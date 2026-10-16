import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Browser, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** The member of this file alone: its conversations ride in the dock. */
const member = { email: "e2e-dock@example.test", password: "e2e-dock-password" };
/** Another person, whose conversation the member may not read. */
const otherPerson = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/**
 * The fixture model echoes a message one word every 20 ms, so this many words are a run of
 * about ten seconds.
 */
const longRunWords = 500;

/** The one column the conversation lives in, on the chat route and in the dock. */
const chatColumn = (page: Page) => page.locator("[data-dock-chat]");
const dockHead = (page: Page) => chatColumn(page).locator("header").first();
const pageAction = (page: Page) => page.getByTestId("dock-page-action");

// DOCK-1, acceptance check 24: fails where a change of route mounts the conversation anew; the
// mark on its element, the composer's text and the thread's scroll position are then gone.
test("the dock keeps its conversation, the composer's text and the scroll position across pages", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 700 });
  await signIn(page, member);
  const stamp = Date.now();
  const title = `Dock keeps ${stamp}`;
  const conversation = await createListedConversation(page, title, words(`kept-${stamp}`, 400));
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);

  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  await expect(dockHead(page)).toContainText(title);
  // It opens at 420 px at the left of the page.
  await expect
    .poll(async () => Math.round((await chatColumn(page).boundingBox())?.width ?? 0))
    .toBe(420);

  const composer = chatColumn(page).getByPlaceholder("Message");
  const thread = chatColumn(page).locator(".chat-thread-inset");
  await expect(chatColumn(page).getByText(`kept-${stamp}`).first()).toBeVisible();
  await chatColumn(page).evaluate((element) => {
    element.dataset.e2eMounted = "once";
  });
  await composer.fill(`unsent words ${stamp}`);
  await expect
    .poll(() => thread.evaluate((element) => element.scrollHeight > element.clientHeight + 200))
    .toBe(true);
  await thread.evaluate((element) => {
    element.style.scrollBehavior = "auto";
    element.scrollTop = 120;
  });

  // To another page through the account menu: the address carries the dock.
  await page.getByRole("button", { name: "E2E Zz Dock account" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/you/profile\\?chat=${conversation.id}$`, "u"));
  await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
  await expect(chatColumn(page)).toHaveAttribute("data-e2e-mounted", "once");
  await expect(composer).toHaveValue(`unsent words ${stamp}`);
  expect(await thread.evaluate((element) => element.scrollTop)).toBe(120);

  // And through the sidebar, back to the Agents page.
  await page
    .getByRole("navigation", { name: "Main navigation" })
    .getByRole("button", { name: "Agents", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/agents\\?chat=${conversation.id}$`, "u"));
  await expect(chatColumn(page)).toHaveAttribute("data-e2e-mounted", "once");
  await expect(composer).toHaveValue(`unsent words ${stamp}`);

  // "Open as full chat" goes to the chat route, whose path names the conversation.
  await dockHead(page).getByRole("button", { name: "Open as full chat" }).click();
  await expect(page).toHaveURL(new RegExp(`/w/${workspace}/c/${conversation.id}$`, "u"));
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "main");
  await expect(chatColumn(page)).toHaveAttribute("data-e2e-mounted", "once");
  await expect(composer).toHaveValue(`unsent words ${stamp}`);
});

// DOCK-1, acceptance check 24: fails where a change of route ends the run's stream; the dock
// would then open the stream again or lose the answer's end.
test("a run in the dock keeps streaming while the person goes to another page, and a closed dock comes back", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const stamp = Date.now();
  const conversation = await createListedConversation(
    page,
    `Dock streams ${stamp}`,
    `Opening ${stamp}`
  );
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);
  const eventRequests: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "GET" &&
      /^\/api\/v1\/conversations\/[^/]+\/runs\/[^/]+\/events$/u.test(
        new URL(request.url()).pathname
      )
    ) {
      eventRequests.push(request.url());
    }
  });

  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  const composer = chatColumn(page).getByPlaceholder("Message");
  const stop = chatColumn(page).getByRole("button", { name: "Stop generating" });
  await composer.fill(words(`stream-${stamp}`, longRunWords));
  await composer.press("Enter");
  await expect(stop).toBeVisible();
  await expect.poll(() => eventRequests.length).toBeGreaterThan(0);
  const streamsBefore = eventRequests.length;

  await page.getByRole("button", { name: "E2E Zz Dock account" }).click();
  await page.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
  await expect(stop).toBeVisible();

  // Closed, the dock leaves the address and the page head offers it back, with a dot while
  // its answer runs.
  await dockHead(page).getByRole("button", { name: "Close chat" }).click();
  await expect(page).toHaveURL(/\/settings\/you\/profile$/u);
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "closed");
  await expect(chatColumn(page)).not.toBeVisible();
  await expect(pageAction(page)).toHaveText(/^Chat/u);
  await expect(pageAction(page).getByTestId("dock-running-dot")).toBeVisible();
  await pageAction(page).click();
  await expect(page).toHaveURL(new RegExp(`/settings/you/profile\\?chat=${conversation.id}$`, "u"));
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");

  // The answer ends in the dock, from the stream it had all along.
  await expect(stop).toHaveCount(0, { timeout: 30_000 });
  await expect(
    chatColumn(page)
      .getByText(`w${longRunWords - 2}`, { exact: false })
      .last()
  ).toBeVisible();
  expect(eventRequests).toHaveLength(streamsBefore);
  await expect(pageAction(page)).toHaveCount(0);
});

// DOCK-1, acceptance check 25: fails where the dock lives only in memory; a reload or a link in
// a new tab then shows the page alone.
test("a reload and a new tab with ?chat= bring the dock back with its conversation", async ({
  page,
  context
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const stamp = Date.now();
  const conversation = await createListedConversation(
    page,
    `Dock address ${stamp}`,
    `restored-${stamp}`
  );
  const address = `/settings/you/profile?chat=${conversation.id}`;

  await page.goto(address);
  await expect(chatColumn(page).getByText(`restored-${stamp}`).first()).toBeVisible();
  await page.reload();
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  await expect(chatColumn(page).getByText(`restored-${stamp}`).first()).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`\\?chat=${conversation.id}$`, "u"));

  const tab = await context.newPage();
  await tab.setViewportSize({ width: 1440, height: 900 });
  await tab.goto(address);
  await expect(tab.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
  await expect(chatColumn(tab).getByText(`restored-${stamp}`).first()).toBeVisible();
  await tab.close();
});

// DOCK-1, acceptance check 25: fails where the dock shows the refusal; a link someone shared
// then greets the recipient with an error.
test("a person who may not read the dock's conversation gets an empty dock and no error", async ({
  page,
  browser
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const stamp = Date.now();
  const foreign = await conversationOf(browser, otherPerson, `Not yours ${stamp}`);
  await signIn(page, member);
  const own = await createListedConversation(page, `Own ${stamp}`, `Opening ${stamp}`);
  const workspace = encodeURIComponent(own.collaborationWorkspaceId);

  await page.goto(`/w/${workspace}/agents?chat=${foreign.id}`);
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  // The address loses the conversation, and the dock stays open without one.
  await expect(page).toHaveURL(new RegExp(`/w/${workspace}/agents$`, "u"));
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  await expect(dockHead(page)).toContainText("New chat");
  await expect(chatColumn(page).getByPlaceholder("Message")).toBeVisible();
  await expect(chatColumn(page).getByText(`Not yours ${stamp}`)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

// DOCK-1, acceptance check 26: fails where the dock squeezes a page under its minimum; below
// 760 px of main area the two cannot stand side by side.
test("in a narrow window the dock lies over the page, and each brings the other back", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 700, height: 900 });
  await signIn(page, member);
  const stamp = Date.now();
  const conversation = await createListedConversation(
    page,
    `Dock narrow ${stamp}`,
    `narrow-${stamp}`
  );
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);

  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  const content = await page.locator("#workspace-content").boundingBox();
  await expect
    .poll(async () => Math.round((await chatColumn(page).boundingBox())?.width ?? 0))
    .toBe(Math.round(content?.width ?? -1));
  await expect(chatColumn(page).getByText(`narrow-${stamp}`).first()).toBeVisible();
  await expect(page.getByRole("separator", { name: "Resize chat" })).toHaveCount(0);

  await dockHead(page).getByRole("button", { name: "Show page" }).click();
  await expect(chatColumn(page)).not.toBeVisible();
  await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();
  await expect(pageAction(page)).toHaveText("Show chat");
  await pageAction(page).click();
  await expect(chatColumn(page)).toBeVisible();
  await expect(pageAction(page)).toHaveCount(0);

  // On a phone the button keeps only its icon, and its tooltip names it.
  await page.setViewportSize({ width: 390, height: 844 });
  const showPage = dockHead(page).getByRole("button", { name: "Show page" });
  await expect(showPage).toHaveText("");
  await showPage.hover();
  await expect(page.getByRole("tooltip")).toHaveText("Show page");
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  for (const theme of ["light", "dark"] as const) {
    for (const locale of ["en", "de"] as const) {
      await page.evaluate(
        ([mode, language]) => {
          localStorage.setItem("vivd-catalyst:theme", mode);
          localStorage.setItem("vivd-catalyst:locale", language);
        },
        [theme, locale] as const
      );
      await page.setViewportSize({ width: 390, height: 640 });
      await page.reload();
      await expect(chatColumn(page)).toBeVisible();
      await expect(page.locator("[data-dock-page]")).toHaveAttribute("inert", "");
      await expect(
        dockHead(page).getByRole("button", { name: /^(?:Show page|Seite anzeigen)$/u })
      ).toHaveText("");
      await page.mouse.move(0, 0);
      if (shotsDir)
        await page.screenshot({
          path: join(shotsDir, `phone-dock-overlay-${theme}-${locale}-390.png`),
          animations: "disabled"
        });
    }
  }
});

// DOCK-1: fails where the width is not kept, or where the dock and the page lose their minimum.
test("the dock opens at 420 px, keeps 380 px for itself and the page, and remembers its width", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const stamp = Date.now();
  const conversation = await createListedConversation(
    page,
    `Dock width ${stamp}`,
    `Opening ${stamp}`
  );
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);
  const handle = page.getByRole("separator", { name: "Resize chat" });
  const dockWidth = async () => Math.round((await chatColumn(page).boundingBox())?.width ?? 0);
  const contentWidth = async () =>
    Math.round((await page.locator("#workspace-content").boundingBox())?.width ?? 0);

  await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
  await expect.poll(dockWidth).toBe(420);
  await expect(handle).toHaveAttribute("aria-valuenow", "420");
  await expect(handle).toHaveAttribute("aria-valuemin", "380");
  await expect(handle).toHaveAttribute("aria-valuemax", String((await contentWidth()) - 380));

  await handle.focus();
  await handle.press("Home");
  await expect.poll(dockWidth).toBe(380);
  await handle.press("End");
  await expect.poll(dockWidth).toBe((await contentWidth()) - 380);
  await handle.press("Home");
  await handle.press("ArrowRight");
  await expect.poll(dockWidth).toBe(396);

  // Dragged by the pointer, it keeps the width it ends on, also after a reload.
  const box = await handle.boundingBox();
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y, { steps: 4 });
  await page.mouse.up();
  await expect.poll(dockWidth).toBe(456);
  await page.reload();
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  await expect.poll(dockWidth).toBe(456);
});

// DOCK-1: fails where the dock moves under reduced motion; the change must then happen at once.
test("the chat widens out of the dock with a view transition, and at once under reduced motion", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const start = document.startViewTransition?.bind(document);
    window.dockViewTransitions = 0;
    if (start) {
      document.startViewTransition = (
        update?: ViewTransitionUpdateCallback | StartViewTransitionOptions
      ) => {
        window.dockViewTransitions = (window.dockViewTransitions ?? 0) + 1;
        return start(update);
      };
    }
  });
  await signIn(page, member);
  const stamp = Date.now();
  const conversation = await createListedConversation(
    page,
    `Dock motion ${stamp}`,
    `Opening ${stamp}`
  );
  const workspace = encodeURIComponent(conversation.collaborationWorkspaceId);
  const transitions = () => page.evaluate(() => window.dockViewTransitions ?? 0);

  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    await page.emulateMedia({ reducedMotion });
    await page.goto(`/w/${workspace}/agents?chat=${conversation.id}`);
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
    const before = await transitions();
    await dockHead(page).getByRole("button", { name: "Open as full chat" }).click();
    await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "main");
    expect((await transitions()) - before).toBe(reducedMotion === "reduce" ? 0 : 1);
    // The shell's own movement, where the browser has no view transition, plays neither.
    await expect(page.locator("[data-dock-arrival]")).toHaveCount(0);
  }
});

declare global {
  interface Window {
    /** How many view transitions the page started, counted by the test. */
    dockViewTransitions?: number;
  }
}

function words(token: string, count: number): string {
  return [token, ...Array.from({ length: count - 1 }, (_, index) => `w${index}`)].join(" ");
}

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** A conversation of another person, made in a browser of their own. */
async function conversationOf(
  browser: Browser,
  user: { email: string; password: string },
  title: string
): Promise<{ id: string }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto("/");
    await signIn(page, user);
    return await createListedConversation(page, title, `Opening ${title}`);
  } finally {
    await context.close();
  }
}

/** A conversation the list shows: one with a message, whose run has ended. */
async function createListedConversation(
  page: Page,
  title: string,
  text: string
): Promise<{ id: string; collaborationWorkspaceId: string }> {
  if (page.url() === "about:blank") {
    await page.goto("/");
  }
  const started = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/conversations/runs`, {
    data: { idempotencyKey: randomUUID(), conversation: { title }, message: { text } }
  });
  expect(started.ok()).toBe(true);
  const { conversation } = z
    .object({ conversation: z.object({ id: z.string(), collaborationWorkspaceId: z.string() }) })
    .parse(await started.json());
  await expect
    .poll(
      async () => {
        const thread = await page.request.get(
          `${apiBaseUrl}/api/v1/conversations/${encodeURIComponent(conversation.id)}/thread`
        );
        expect(thread.ok()).toBe(true);
        const snapshot = z
          .object({ activeRun: z.unknown().optional(), messages: z.array(z.unknown()) })
          .parse(await thread.json());
        return { running: snapshot.activeRun !== undefined, messages: snapshot.messages.length };
      },
      { timeout: 30_000 }
    )
    .toEqual({ running: false, messages: 2 });
  return conversation;
}
