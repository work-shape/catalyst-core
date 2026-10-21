import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";
import { REQUEST_FAILED } from "./allowed-page-errors";
// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "planted-send-now-failure",
        reason:
          "Chromium's own log line for the Send now request the picture test aborts on purpose, to " +
          "show the queue's error line.",
        matches: REQUEST_FAILED,
        path: /^\/api\/v1\/conversations\/[^/]+\/follow-ups\/dispatch$/u,
        tests: ["pictures of the queue's passing states"]
      },
      {
        name: "planted-phone-send-failure",
        reason:
          "The phone layout regression deliberately aborts a send to show its pinned run notice above a paused queue.",
        matches: REQUEST_FAILED,
        path: /^\/api\/v1\/conversations\/[^/]+\/runs$/u,
        tests: [
          "pinned chat bands cover the transcript and the return button clears the whole footer"
        ]
      }
    ]
  }
});

// A message sent while a run goes waits in the conversation's queue above the composer and
// starts as the next turn. Fails without the queue: the send is refused while the run goes, and
// the text stays in the field.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

/** The two people of this spec, from `tests/fixtures/e2e-users/follow-up-queue.yaml`. */
const owner = { email: "e2e-follow-ups@example.test", password: "e2e-follow-ups-password" };
const member = {
  email: "e2e-follow-ups-member@example.test",
  password: "e2e-follow-ups-member-password"
};

/**
 * The fixture model echoes a message word by word, about 20 ms a word: 500 words keep a run
 * going for some ten seconds, long enough to queue behind it and stop it. The test with two
 * members opens a second browser before it queues, which took more than those ten seconds on
 * the hosted runner, so its run is five times as long. Pictures reload the page eight times
 * while it goes, so their run is longer still.
 */
const RUN_WORDS = shotsDir ? 6_000 : 500;
const SHARED_RUN_WORDS = shotsDir ? 6_000 : 2_500;
/** The time limit of a test with a long run, and the wait for one to end. */
const RUN_TEST_TIMEOUT_MS = shotsDir ? 600_000 : 240_000;
const RUN_END_TIMEOUT_MS = shotsDir ? 240_000 : 120_000;
/**
 * The wait for another member's change to reach a paused queue: the page reads the thread every
 * ten seconds while its queue is paused (`PAUSED_QUEUE_REREAD_MS`), and nothing else tells it.
 */
const PAUSED_QUEUE_CHANGE_TIMEOUT_MS = 30_000;

const idSchema = z.object({ id: z.string() });
/** The parts of a thread the failed-run picture rewrites; the rest passes through. */
const threadSchema = z.looseObject({
  activeRun: z.looseObject({ run: z.looseObject({}), projection: z.looseObject({}) })
});

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The instance knows a person of the config from their first call on.
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
  // A new person steers their own run with Enter; the people of this spec queue (FU-2).
  const queues = await requestWithOrigin(page, "patch", `${apiOrigin}/api/v1/me`, {
    data: { followUpMode: "queue" }
  });
  expect(queues.ok()).toBe(true);
}

/** A workspace of the owner whose conversations its members see, with `invite` as a member. */
async function sharedWorkspace(page: Page, name: string, invite?: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name, defaultConversationVisibility: "workspace" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  if (invite) {
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: invite } }
    );
    expect(added.ok()).toBe(true);
  }
  return workspaceId;
}

/** A message that starts with `token` and keeps the fixture model answering for a long run. */
function longRunMessage(token: string, words: number): string {
  return [token, ...Array.from({ length: words - 1 }, (_, index) => `w${index}`)].join(" ");
}

/** Starts a long run in a new conversation of the workspace; answers its address. */
async function startLongRun(
  page: Page,
  workspaceId: string,
  token: string,
  words = RUN_WORDS
): Promise<string> {
  await page.goto(`/w/${workspaceId}`);
  await page.getByPlaceholder("Message").fill(longRunMessage(token, words));
  await page.getByPlaceholder("Message").press("Enter");
  await expect(page).toHaveURL(/\/w\/[^/]+\/c\/[^/]+$/u);
  await expect(stopButton(page)).toBeVisible();
  return new URL(page.url()).pathname;
}

function stopButton(page: Page): Locator {
  return page.getByRole("button", { name: "Stop generating" });
}

/** The queue in either language: pictures load the page in German too. */
function queueOf(page: Page): Locator {
  return page.getByRole("region", {
    name: /^(?:Queued messages|Nachrichten in der Warteschlange)$/u
  });
}

/** The user messages of the transcript, in order. */
function userMessages(page: Page): Locator {
  return page.getByRole("region", { name: "Chat" }).locator('[data-role="user"]');
}

async function queueMessage(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder("Message");
  await input.fill(text);
  // While the run goes Send stays beside Stop, and names what it does now.
  await expect(stopButton(page)).toBeVisible();
  await expect(page.getByRole("button", { name: "Send after this answer" })).toBeVisible();
  await input.press("Enter");
  await expect(queueOf(page).getByText(text)).toBeVisible();
  await expect(input).toHaveValue("");
}

const VARIANTS = (["light", "dark"] as const).flatMap((theme) =>
  (["en", "de"] as const).flatMap((locale) =>
    ([1280, 390] as const).map((width) => [theme, locale, width] as const)
  )
);

type Variant = (typeof VARIANTS)[number];

/**
 * Loads the address again in a theme, language and width: both are read when the interface
 * loads. Then waits for `ready`.
 */
async function showVariant(
  page: Page,
  [theme, locale, width]: Variant,
  ready: () => Promise<void>
): Promise<void> {
  await page.evaluate(
    ([themeValue, localeValue]) => {
      window.localStorage.setItem("vivd-catalyst:theme", themeValue);
      window.localStorage.setItem("vivd-catalyst:locale", localeValue);
    },
    [theme, locale] as const
  );
  await page.setViewportSize({ width, height: width === 390 ? 844 : 800 });
  await page.reload();
  await ready();
}

async function picture(page: Page, name: string): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

/**
 * Pictures of the conversation in both themes and languages at both widths, each after `ready`.
 * The page is left in light English at 1280.
 */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  if (!shotsDir) {
    return;
  }
  for (const variant of VARIANTS) {
    await showVariant(page, variant, ready);
    await picture(page, `${name}-${variant.join("-")}`);
  }
  await showVariant(page, ["light", "en", 1280], ready);
}

// A route that holds an answer can outlive its test.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a message sent during a run waits in a queue both members see, and starts as the next turn", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(RUN_TEST_TIMEOUT_MS);
  const suffix = Date.now();
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, owner);
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  const workspaceId = await sharedWorkspace(page, `Queue team ${suffix}`, member.email);

  const conversationPath = await startLongRun(
    page,
    workspaceId,
    `queue-run-${suffix}`,
    SHARED_RUN_WORDS
  );
  await memberPage.goto(conversationPath);
  await expect(stopButton(memberPage)).toBeVisible();

  const ownText = `Then check the March numbers ${suffix}`;
  await queueMessage(page, ownText);
  await expect(queueOf(page)).toContainText("Sent once the agent has finished this whole answer.");
  // The member's tab follows the run, and the queue change is one more event on its stream.
  const memberQueue = queueOf(memberPage);
  await expect(memberQueue.getByText(ownText)).toBeVisible();
  await expect(memberQueue).toContainText("From E2E Zz Follow-ups");
  await expect(queueOf(page)).not.toContainText("From E2E Zz Follow-ups");
  await expect(memberQueue.getByRole("button", { name: "Edit" })).toHaveCount(0);
  // The queue lives on the server: a reload keeps it.
  await memberPage.reload();
  await expect(queueOf(memberPage).getByText(ownText)).toBeVisible();
  await expect(queueOf(memberPage)).toContainText("From E2E Zz Follow-ups");

  // The member's own message queues behind the owner's.
  const memberText = `And add a short summary ${suffix}`;
  await queueMessage(memberPage, memberText);
  await expect(queueOf(page).getByText(memberText)).toBeVisible();
  await expect(queueOf(page)).toContainText("From E2E Zz Follow-ups Member");
  await shoot(page, "follow-up-queue-waiting", async () => {
    await expect(queueOf(page).getByText(memberText)).toBeVisible();
  });

  // Each queued message starts as a turn of its own, in order, once the run before it completes.
  await expect(userMessages(page).filter({ hasText: ownText })).toBeVisible({
    timeout: RUN_END_TIMEOUT_MS
  });
  await expect(userMessages(page).filter({ hasText: memberText })).toBeVisible({
    timeout: RUN_END_TIMEOUT_MS
  });
  await expect(userMessages(page).last()).toContainText(memberText);
  await expect(queueOf(page)).toHaveCount(0);
  await memberContext.close();
});

test("Stop pauses the queue, and Send now starts the oldest message", async ({ page }) => {
  test.setTimeout(RUN_TEST_TIMEOUT_MS);
  const suffix = Date.now();
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, owner);
  const workspaceId = await sharedWorkspace(page, `Paused queue ${suffix}`);
  await startLongRun(page, workspaceId, `paused-run-${suffix}`);
  const queuedText = `Summarise the answer ${suffix}`;
  await queueMessage(page, queuedText);

  await stopButton(page).click();
  const queue = queueOf(page);
  await expect(queue).toContainText("Queue paused");
  // Nothing starts by itself after a stop.
  await expect(userMessages(page).filter({ hasText: queuedText })).toHaveCount(0);
  await shoot(page, "follow-up-queue-paused", async () => {
    await expect(queueOf(page)).toContainText(/Queue paused|Warteschlange angehalten/u);
  });

  await queue.getByRole("button", { name: "Send now" }).click();
  await expect(userMessages(page).filter({ hasText: queuedText })).toBeVisible();
  await expect(queueOf(page)).toHaveCount(0);
});

// The notice, queue and composer share one opaque pinned surface. The return button belongs
// above all of them, and the head's band covers the transcript in both themes at phone width;
// from 768 px up the transcript scrolls under the floating controls to the window's top.
test("pinned chat bands cover the transcript and the return button clears the whole footer", async ({
  page
}) => {
  test.setTimeout(RUN_TEST_TIMEOUT_MS);
  page.setDefaultTimeout(10_000);
  await signIn(page, owner);
  const workspaceId = await sharedWorkspace(page, `Phone bands ${Date.now()}`);
  await startLongRun(page, workspaceId, `phone-bands-${Date.now()}`, 500);
  await queueMessage(page, "Then summarise the quarterly revenue and the remaining questions");
  await stopButton(page).click();
  await expect(queueOf(page)).toContainText("Queue paused");

  // A failed send leaves its run notice above the paused queue.
  await page.route(/\/api\/v1\/conversations\/[^/]+\/runs$/u, (route) =>
    route.request().method() === "POST" ? route.abort("failed") : route.continue()
  );
  const footer = page.getByTestId("thread-footer");
  const viewport = page.locator(".chat-thread-inset");
  const chat = page.getByRole("region", { name: "Chat" });
  const head = page.locator("header").first();
  const bottom = page.getByRole("button", { name: /^(?:Scroll to bottom|Zum Ende scrollen)$/u });
  const background = (locator: Locator) =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  const top = (locator: Locator) =>
    locator.evaluate((element) => element.getBoundingClientRect().top);

  for (const variant of VARIANTS) {
    await showVariant(page, variant, async () => {
      await expect(queueOf(page)).toBeVisible();
    });
    await page.setViewportSize({ width: variant[2], height: 640 });
    await chat.getByRole("button", { name: /^(?:Show more|Mehr anzeigen)$/u }).click();
    const input = page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
    await input.fill("Keep this message when sending fails");
    await input.press("Enter");
    await expect(footer.getByRole("alert")).toBeVisible();
    await input.fill("");
    expect(await background(footer)).toBe(await background(chat));
    const fade = await head.evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return {
        display: style.display,
        top: parseFloat(style.top),
        height: parseFloat(style.height),
        image: style.backgroundImage,
        headerHeight: element.getBoundingClientRect().height,
        rem: parseFloat(getComputedStyle(document.documentElement).fontSize)
      };
    });
    if (variant[2] === 390) {
      expect(await background(head)).toBe(await background(chat));
      expect(fade.top).toBe(fade.headerHeight);
      expect(fade.height).toBe(fade.rem);
      expect(fade.image).toContain("linear-gradient");
    } else {
      // From 768 px up the transcript scrolls to the window's top under the floating controls.
      expect(await background(head)).toBe("rgba(0, 0, 0, 0)");
      expect(fade.display).toBe("none");
      await expect(head.locator("[data-header-fade]")).toBeVisible();
    }

    const end = await viewport.evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(end).toBeGreaterThan(100);
    // Wheel input tells assistant-ui the reader has taken over from turn anchoring.
    await viewport.hover({ position: { x: 100, y: 100 } });
    const wheelToTop = () =>
      expect
        .poll(async () => {
          await page.mouse.wheel(0, -100_000);
          return viewport.evaluate((element) => element.scrollTop);
        })
        .toBe(0);
    await wheelToTop();
    const pinnedTop = await top(footer);
    await page.mouse.wheel(0, end / 2);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    expect(await top(footer)).toBeCloseTo(pinnedTop, 0);
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, 100_000);
        return viewport.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop
        );
      })
      .toBeLessThanOrEqual(1);
    expect(await top(footer)).toBeCloseTo(pinnedTop, 0);
    await wheelToTop();
    await page.mouse.wheel(0, 80);
    await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(80);
    await expect(bottom).toBeVisible();
    const buttonBottom = await bottom.evaluate((element) => element.getBoundingClientRect().bottom);
    expect(buttonBottom).toBeLessThanOrEqual(await top(footer));
    expect(buttonBottom).toBeLessThanOrEqual(await top(footer.getByRole("alert")));
    expect(buttonBottom).toBeLessThanOrEqual(await top(queueOf(page)));
    await picture(page, `phone-chat-bands-${variant.join("-")}`);
    await bottom.click();
    await expect(bottom).toBeHidden();
  }
  await queueOf(page)
    .getByRole("button", { name: /^(?:Remove|Entfernen)$/u })
    .click();
  await expect(queueOf(page)).toHaveCount(0);
  await page.unroute(/\/api\/v1\/conversations\/[^/]+\/runs$/u);
  const completedMessage = "Finish this reply for the composer-only layout";
  const input = page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
  await input.fill(completedMessage);
  await input.press("Enter");
  await expect(chat.locator('[data-role="assistant"]').last()).toContainText(completedMessage);
  await expect(
    page.getByRole("button", { name: /^(?:Stop generating|Generierung stoppen)$/u })
  ).toBeHidden();
  for (const variant of VARIANTS) {
    await showVariant(page, variant, async () => {
      await expect(page.getByPlaceholder(/^(?:Message|Nachricht)$/u)).toBeVisible();
    });
    await page.setViewportSize({ width: variant[2], height: 640 });
    await chat.getByRole("button", { name: /^(?:Show more|Mehr anzeigen)$/u }).click();
    await expect(footer.getByRole("alert")).toHaveCount(0);
    await expect(queueOf(page)).toHaveCount(0);
    await viewport.hover({ position: { x: 100, y: 100 } });
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -100_000);
        return viewport.evaluate((element) => element.scrollTop);
      })
      .toBe(0);
    await expect(bottom).toBeVisible();
    const buttonBottom = await bottom.evaluate((element) => element.getBoundingClientRect().bottom);
    expect(buttonBottom).toBeLessThanOrEqual(await top(footer));
    await picture(page, `phone-composer-only-${variant.join("-")}`);
    await bottom.click();
    await expect(bottom).toBeHidden();
  }
});

test("when the oldest message of a paused queue is withdrawn, the next author can send theirs without a reload", async ({
  page,
  browser,
  baseURL,
  pageErrors
}) => {
  test.setTimeout(RUN_TEST_TIMEOUT_MS);
  const suffix = Date.now();
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, owner);
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1280, height: 800 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  await signIn(memberPage, member);
  const workspaceId = await sharedWorkspace(page, `Withdrawn queue ${suffix}`, member.email);
  const conversationPath = await startLongRun(
    page,
    workspaceId,
    `withdrawn-run-${suffix}`,
    SHARED_RUN_WORDS
  );
  await memberPage.goto(conversationPath);
  await expect(stopButton(memberPage)).toBeVisible();
  const ownText = `First compare the offers ${suffix}`;
  await queueMessage(page, ownText);
  const memberText = `Then draft the reply ${suffix}`;
  await queueMessage(memberPage, memberText);
  const memberQueue = queueOf(memberPage);
  await expect(memberQueue.getByText(ownText)).toBeVisible();

  await stopButton(page).click();
  await expect(memberQueue).toContainText("Queue paused");
  await expect(memberQueue).toContainText("Continues after the next message is answered.");
  // The oldest message is the owner's: only they may start it, and its row says so.
  await expect(memberQueue).toContainText("From E2E Zz Follow-ups · Only they can send it now.");
  await expect(memberQueue.getByRole("button", { name: "Send now" })).toHaveCount(0);
  await shoot(memberPage, "follow-up-queue-next-not-own", async () => {
    await expect(queueOf(memberPage).getByText(memberText)).toBeVisible();
  });

  await queueOf(page).getByRole("button", { name: "Remove" }).click();
  await expect(queueOf(page).getByText(ownText)).toHaveCount(0);
  // Nothing streams a paused queue: the member's open tab reads the thread again by itself.
  await expect(memberQueue.getByText(ownText)).toHaveCount(0, {
    timeout: PAUSED_QUEUE_CHANGE_TIMEOUT_MS
  });
  await memberQueue.getByRole("button", { name: "Send now" }).click();
  await expect(userMessages(memberPage).filter({ hasText: memberText })).toBeVisible();
  await expect(queueOf(memberPage)).toHaveCount(0);
  await memberContext.close();
});

test("pictures of the queue's passing states", async ({ page }) => {
  test.skip(!shotsDir, "Only takes pictures; the flows are proven by the tests above.");
  test.setTimeout(RUN_TEST_TIMEOUT_MS);
  const suffix = Date.now();
  await signIn(page, owner);
  const workspaceId = await sharedWorkspace(page, `Queue pictures ${suffix}`);
  await page.setViewportSize({ width: 1280, height: 800 });
  await startLongRun(page, workspaceId, `pictures-run-${suffix}`);
  await queueMessage(page, `Summarise the answer ${suffix}`);

  // Stop beside Send while the field holds text, at phone width.
  const nextText = `And list the open questions ${suffix}`;
  await showVariant(page, ["light", "de", 390], async () => {
    await page.getByPlaceholder("Nachricht").fill(nextText);
    await expect(page.getByRole("button", { name: "Nach dieser Antwort senden" })).toBeVisible();
  });
  await picture(page, "follow-up-queue-stop-and-send-light-de-390");
  await showVariant(page, ["light", "en", 1280], async () => {
    await page.getByPlaceholder("Message").fill("");
    await expect(stopButton(page)).toBeVisible();
  });

  await stopButton(page).click();
  const queue = queueOf(page);
  await expect(queue).toContainText("Queue paused");
  await queue.getByRole("button", { name: "Discard" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await picture(page, "follow-up-queue-discard-light-en-1280");
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  // A run that broke reads as interrupted in the person's language: the thread is answered as
  // if the stopped run had failed with the worker's internal error.
  await page.route("**/thread", async (route) => {
    const response = await route.fetch();
    const thread = threadSchema.parse(await response.json());
    const error = { code: "INTERNAL", message: "Agent run failed", category: "internal_error" };
    await route.fulfill({
      response,
      json: {
        ...thread,
        activeRun: {
          ...thread.activeRun,
          run: { ...thread.activeRun.run, status: "failed" },
          projection: { ...thread.activeRun.projection, status: "failed", error }
        }
      }
    });
  });
  for (const locale of ["en", "de"] as const) {
    await showVariant(page, ["light", locale, 1280], async () => {
      await expect(
        page.getByText(/^(?:The reply was interrupted|Die Antwort wurde unterbrochen)/u)
      ).toBeVisible();
    });
    await picture(page, `follow-up-queue-failed-light-${locale}-1280`);
  }
  await page.unrouteAll({ behavior: "ignoreErrors" });
  await showVariant(page, ["light", "en", 1280], async () => {
    await expect(queue).toContainText("Queue paused");
  });

  // Send now does not reach the instance once: the line under the queue says so.
  await page.route("**/follow-ups/dispatch", (route) => route.abort());
  await queue.getByRole("button", { name: "Send now" }).click();
  await expect(queue).toContainText("That did not work. Try again.");
  await picture(page, "follow-up-queue-error-light-en-1280");
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // While the thread does not name the started run yet, the queue reads as sending.
  await page.route("**/thread", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    await route.continue().catch(() => undefined);
  });
  await queue.getByRole("button", { name: "Send now" }).click();
  await expect(queue).toContainText("Sending the next message…");
  await picture(page, "follow-up-queue-sending-light-en-1280");
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Edit takes a queued message back into the composer", async ({ page }) => {
  test.setTimeout(RUN_TEST_TIMEOUT_MS);
  const suffix = Date.now();
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page, owner);
  const workspaceId = await sharedWorkspace(page, `Edited queue ${suffix}`);
  await startLongRun(page, workspaceId, `edit-run-${suffix}`);
  const queuedText = `Use the second table instead ${suffix}`;
  await queueMessage(page, queuedText);

  await queueOf(page).getByRole("button", { name: "Edit" }).click();
  await expect(page.getByPlaceholder("Message")).toHaveValue(queuedText);
  await expect(queueOf(page)).toHaveCount(0);

  await stopButton(page).click();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  // Withdrawn, so the stopped run leaves nothing to send.
  await expect(userMessages(page).filter({ hasText: queuedText })).toHaveCount(0);
});
