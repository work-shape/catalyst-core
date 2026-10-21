import { randomUUID } from "node:crypto";
import type { Locator, Page, Route } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { requestAnswered } from "./allowed-page-errors";
// The messages this spec's tests cause on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "settings-refusals-that-name-an-admin",
        reason:
          "Chromium's own log line: the tests answer a read or a change on Usage, API keys and " +
          "Members with 403 and assert that the refusal names an instance admin to ask.",
        matches: requestAnswered(403),
        path: /^\/api\/v1\/(?:instance\/usage|me\/api-keys(?:\/[^/]+\/revoke)?|workspaces\/[^/]+\/access-requests\/[^/]+\/approve)$/u,
        tests: [
          "Usage opens with the month's cost of its budget and the tokens under it, and a refusal names an instance admin",
          "API keys open with the person's keys, and refusals name an instance admin",
          "Members come first, requests show only while somebody asks, and a refusal names an instance admin in its section"
        ]
      }
    ]
  }
});

// Settings for an admin (UXA-5): Usage opens with the month's cost of its budget and the tokens
// under it, API keys with the person's own keys, Members with the members and requests only
// while somebody asks. A refusal on these pages names an instance admin to ask, never a page the
// person cannot open, and is information where a failure is an error. Every surface is pictured
// at 1280 and 390, light and dark, English and German, in every run: each picture is attached
// with its bytes and written under the test's output in `shots/`.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
// At a short window, the refusal must stay beside the actions while the fields scroll.
const SHORT_WINDOW_HEIGHT_PX = 640;
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
// Of this spec alone: the owner of its workspace. A member holds no right a key could carry, so
// the keys are the admin's, each named by this spec.
const owner = { email: "e2e-first-blocks@example.test", password: "e2e-first-blocks-password" };
// Requests that reach the Inbox are made only in inbox.spec.ts, so the one request to join is
// planted in the answer of the request list.
const plantedRequest = {
  userId: "user_first_blocks_requester",
  displayLabel: "Elif Requester",
  email: "elif.requester@example.test",
  createdAt: "2026-10-16T09:30:00.000Z"
};

const SIZES = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 }
] as const;
const LOOKS = (["light", "dark"] as const).flatMap((theme) =>
  (["en", "de"] as const).map((locale) => ({ theme, locale }))
);
type Look = (typeof LOOKS)[number];
type View = Look & (typeof SIZES)[number];

const words = {
  en: {
    ask: (name: string) => `Ask an instance admin, for example ${name}.`,
    usageRefused: "You may not see the usage of this instance.",
    spentOf: (spent: string, limit: string) => `${spent} of ${limit}`,
    tokens: (count: string) => `${count} tokens`,
    costUnknown: "Cost not known yet",
    limitReached: "Budget reached",
    blockedMonth: "New model calls are blocked for the rest of this month.",
    yourKeys: "Your keys",
    connect: "Connect the CLI",
    newKey: "New key",
    createKey: "Create key",
    revoke: "Revoke",
    cancel: "Cancel",
    close: "Close",
    revokeTitle: (key: string) => `Revoke ${key}?`,
    listRefused: "You may not see your keys.",
    issueRefused: "You may not issue this key.",
    revokeRefused: "You may not revoke this key.",
    members: "Members",
    addMember: "Add member",
    requests: "Requests",
    approve: "Approve",
    decline: "Decline",
    approveRefused: "You can't approve requests in this workspace."
  },
  de: {
    ask: (name: string) => `Frag jemanden, der die Instanz verwaltet, zum Beispiel ${name}.`,
    usageRefused: "Du darfst die Nutzung dieser Instanz nicht sehen.",
    spentOf: (spent: string, limit: string) => `${spent} von ${limit}`,
    tokens: (count: string) => `${count} Tokens`,
    costUnknown: "Kosten noch nicht bekannt",
    limitReached: "Budget erreicht",
    blockedMonth: "Neue Modellaufrufe sind für den Rest des Monats gesperrt.",
    yourKeys: "Deine Schlüssel",
    connect: "CLI verbinden",
    newKey: "Neuer Schlüssel",
    createKey: "Schlüssel erstellen",
    revoke: "Widerrufen",
    cancel: "Abbrechen",
    close: "Schließen",
    revokeTitle: (key: string) => `${key} widerrufen?`,
    listRefused: "Du darfst deine Schlüssel nicht sehen.",
    issueRefused: "Du darfst diesen Schlüssel nicht ausstellen.",
    revokeRefused: "Du darfst diesen Schlüssel nicht widerrufen.",
    members: "Mitglieder",
    addMember: "Mitglied hinzufügen",
    requests: "Anfragen",
    approve: "Genehmigen",
    decline: "Ablehnen",
    approveRefused: "Du darfst Anfragen in diesem Arbeitsbereich nicht genehmigen."
  }
} as const;

// Only an admin who has signed in is named, so each test signs the admin in before it asks whom
// a refusal names, whatever ran before it on its shard; the fallback without a name is a unit
// test's.
const meSchema = z.object({ instanceAdminName: z.string().min(1) });
const idSchema = z.object({ id: z.string() });
const usageSchema = z
  .object({
    spendBudget: z.object({}).passthrough(),
    currentMonth: z
      .object({ totalTokens: z.number(), cost: z.object({}).passthrough() })
      .passthrough()
  })
  .passthrough();

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** The instance admin the signed-in person is told to ask, as the instance answers it. */
async function instanceAdminName(page: Page): Promise<string> {
  const response = await page.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(response.ok()).toBe(true);
  return meSchema.parse(await response.json()).instanceAdminName;
}

/**
 * Opens `path` in the look's theme and language, read when the interface loads: one load where the
 * page already stands on the interface, two only for the first.
 */
async function open(page: Page, path: string, look: Look): Promise<void> {
  if (page.url() === "about:blank") await page.goto(path);
  await page.evaluate(
    ({ theme, locale }) => {
      window.localStorage.setItem("vivd-catalyst:theme", theme);
      window.localStorage.setItem("vivd-catalyst:locale", locale);
    },
    { theme: look.theme, locale: look.locale }
  );
  await page.goto(path);
}

/**
 * Each theme and language loads `path` once at the wide size; `check` then runs at each width in
 * turn, as a person narrows the window.
 */
async function eachView(
  page: Page,
  path: string,
  check: (view: View) => Promise<void>
): Promise<void> {
  for (const look of LOOKS) {
    await page.setViewportSize(SIZES[0]);
    await open(page, path, look);
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await check({ ...look, ...size });
    }
  }
}

/**
 * Pictures the page under the test's output in `shots/`, and attaches the picture's bytes: the
 * JSON report the hosted check always keeps carries them, so every run holds its pictures.
 */
async function shoot(page: Page, name: string, view: View): Promise<void> {
  const file = `${name}-${view.width}-${view.theme}-${view.locale}.png`;
  const path = test.info().outputPath("shots", file);
  const body = await page.screenshot({ path, animations: "disabled" });
  await test.info().attach(file, { body, contentType: "image/png" });
}

/** Answers every matching request with the refusal the instance gives a missing right. */
async function refuse(route: Route): Promise<void> {
  await route.fulfill({
    status: 403,
    json: { error: { code: "FORBIDDEN", message: "Forbidden" } }
  });
}

/**
 * Scrolls the page's own scroll container until `locator` stands near its top, as a person
 * scrolls to it. `scrollIntoView` would also scroll the app root under the floating header.
 */
async function scrollToTop(locator: Locator): Promise<void> {
  await locator.evaluate((element) => {
    let container = element.parentElement;
    while (container && container.scrollHeight <= container.clientHeight) {
      container = container.parentElement;
    }
    if (!container) return;
    const offset = element.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
    container.scrollTop += offset;
  });
}

async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error("The element is not on the page");
  return box;
}

async function topOf(locator: Locator): Promise<number> {
  return (await boxOf(locator)).y;
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("Usage opens with the month's cost of its budget and the tokens under it, and a refusal names an instance admin", async ({
  page
}) => {
  test.setTimeout(240_000);
  await signIn(page, admin);
  const adminName = await instanceAdminName(page);
  // The instance's budget is set in its release config, and the deterministic model is not
  // priced; both are planted in the answer, so the month reads as priced, unpriced or over.
  const monthlyLimit = 437;
  const spentBy = { priced: 12.34, over: 450 };
  let month: "priced" | "unknown" | "over" = "priced";
  let tokens = 0;
  // Freeze one answer for this matrix: other specs may record usage in the same database.
  let usageResponse: ReturnType<Route["fetch"]> | undefined;
  await page.route("**/api/v1/instance/usage", async (route) => {
    const response = await (usageResponse ??= route.fetch());
    const usage = usageSchema.parse(await response.json());
    tokens = usage.currentMonth.totalTokens;
    await route.fulfill({
      response,
      json: {
        ...usage,
        spendBudget: {
          ...usage.spendBudget,
          currency: "EUR",
          monthlyLimitMicros: monthlyLimit * 1_000_000,
          // The budget counts the same planted spend; unknown keeps the budget's spend unknown too.
          monthlySpentMicros: month === "unknown" ? undefined : spentBy[month] * 1_000_000
        },
        currentMonth: {
          ...usage.currentMonth,
          cost:
            month === "unknown"
              ? { ...usage.currentMonth.cost, currency: undefined, billableCostMicros: undefined }
              : {
                  ...usage.currentMonth.cost,
                  currency: "EUR",
                  billableCostMicros: spentBy[month] * 1_000_000
                }
        }
      }
    });
  });

  const usagePage = "/settings/instance/usage";
  await eachView(page, usagePage, async (view) => {
    const said = words[view.locale];
    const lead = page.getByTestId("usage-month-budget");
    await expect(lead).toBeVisible();
    // The first block of the page, before the cost cards and the budget progress.
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector("[data-card]")?.getAttribute("data-testid"))
      )
      .toBe("usage-month-budget");
    const amount = new Intl.NumberFormat(view.locale, { style: "currency", currency: "EUR" });
    // The month's one answer, with the tokens second and the budget's state under them.
    await expect(lead.getByTestId("usage-month-cost")).toHaveText(
      said.spentOf(amount.format(spentBy.priced), amount.format(monthlyLimit))
    );
    const tokensSaid = said.tokens(tokens.toLocaleString(view.locale));
    await expect(lead).toContainText(tokensSaid);
    await expect(lead.getByRole("progressbar")).toBeVisible();
    await shoot(page, "usage", view);
  });

  // Nothing priced yet: the answer says so, and the configured budget still stands.
  month = "unknown";
  await eachView(page, usagePage, async (view) => {
    const said = words[view.locale];
    const lead = page.getByTestId("usage-month-budget");
    const amount = new Intl.NumberFormat(view.locale, { style: "currency", currency: "EUR" });
    await expect(lead.getByTestId("usage-month-cost")).toHaveText(said.costUnknown);
    await expect(lead.getByTestId("usage-budget-limit")).toHaveText(amount.format(monthlyLimit));
    await shoot(page, "usage-cost-unknown", view);
  });

  // Over the budget: the month's card says the limit is reached and new calls are blocked.
  month = "over";
  await eachView(page, usagePage, async (view) => {
    const said = words[view.locale];
    const lead = page.getByTestId("usage-month-budget");
    const amount = new Intl.NumberFormat(view.locale, { style: "currency", currency: "EUR" });
    await expect(lead.getByTestId("usage-month-cost")).toHaveText(
      said.spentOf(amount.format(spentBy.over), amount.format(monthlyLimit))
    );
    await expect(lead).toContainText(said.limitReached);
    await expect(lead).toContainText(said.blockedMonth);
    await shoot(page, "usage-over-budget", view);
  });

  await page.unroute("**/api/v1/instance/usage");
  await page.route("**/api/v1/instance/usage", refuse);
  await eachView(page, usagePage, async (view) => {
    const said = words[view.locale];
    const refusal = page.locator('[data-tone="info"]', {
      hasText: `${said.usageRefused} ${said.ask(adminName)}`
    });
    await expect(refusal).toBeVisible();
    await expect(page.getByText(/Settings >|Einstellungen >/u)).toHaveCount(0);
    await shoot(page, "usage-refused", view);
  });
});

test("API keys open with the person's keys, and refusals name an instance admin", async ({
  page
}) => {
  test.setTimeout(360_000);
  await signIn(page, admin);
  const adminName = await instanceAdminName(page);
  const keyName = `first-blocks-${randomUUID().slice(0, 6)}`;
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/me/api-keys`, {
    data: {
      name: keyName,
      scopes: ["agent.read"],
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const keyId = z.object({ key: idSchema }).parse(await created.json()).key.id;

  try {
    await eachView(page, "/settings/you/api-keys", async (view) => {
      const said = words[view.locale];
      const yourKeys = page.getByRole("heading", { level: 2, name: said.yourKeys, exact: true });
      const connect = page.getByRole("heading", { level: 2, name: said.connect, exact: true });
      await expect(page.getByText(keyName)).toBeVisible();
      await expect(connect).toBeVisible();
      expect(await topOf(yourKeys)).toBeLessThan(await topOf(connect));
      await shoot(page, "api-keys", view);

      // Issuing refused: the dialog says whom to ask.
      await page.route("**/api/v1/me/api-keys", (route) =>
        route.request().method() === "POST" ? refuse(route) : route.fallback()
      );
      await page.getByRole("button", { name: said.newKey }).click();
      const dialog = page.getByRole("dialog", { name: said.newKey });
      await dialog.getByRole("textbox", { name: "Name" }).fill("refused");
      await dialog.getByRole("checkbox").first().click();
      await dialog.getByRole("button", { name: said.createKey }).click();
      // In view where Create key was pressed, not below the fields' fold, as information.
      const issueRefusal = dialog.locator('[data-tone="info"]', {
        hasText: `${said.issueRefused} ${said.ask(adminName)}`
      });
      await expect(issueRefusal).toBeInViewport({ ratio: 1 });
      // The same key would be refused again: Create key waits for a changed field.
      const create = dialog.getByRole("button", { name: said.createKey });
      await expect(create).toBeDisabled();
      await shoot(page, "api-keys-issue-refused", view);
      if (view.width === 390) {
        await page.setViewportSize({ width: view.width, height: SHORT_WINDOW_HEIGHT_PX });
        await expect(issueRefusal).toBeInViewport({ ratio: 1 });
        const pinnedTop = await topOf(issueRefusal);
        // Dialog's body is the form's scrolling parent; its footer is outside that body.
        const fields = dialog.locator("form").locator("..");
        for (const fraction of [0.25, 0.5, 1]) {
          const target = await fields.evaluate((body, fraction) => {
            const end = body.scrollHeight - body.clientHeight;
            if (end <= 0) throw new Error("Key fields must scroll in the short window");
            const target = Math.floor(end * fraction);
            body.scrollTop = target;
            return target;
          }, fraction);
          await expect.poll(() => fields.evaluate((body) => body.scrollTop)).toBe(target);
          await expect(issueRefusal).toBeInViewport({ ratio: 1 });
          expect(await topOf(issueRefusal)).toBeCloseTo(pinnedTop, 1);
        }
        await page.setViewportSize({ width: view.width, height: view.height });
      }
      await dialog.getByRole("textbox", { name: "Name" }).fill("refused-again");
      await expect(create).toBeEnabled();
      await expect(issueRefusal).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();

      // Revoking refused: the question says whom to ask.
      await page.route("**/api/v1/me/api-keys/*/revoke", refuse);
      const row = page.getByRole("row").filter({ hasText: keyName });
      await row.getByRole("button", { name: said.revoke }).click();
      const question = page.getByRole("dialog", { name: said.revokeTitle(keyName) });
      await question.getByRole("button", { name: said.revoke }).click();
      await expect(
        question.locator('[data-tone="info"]', {
          hasText: `${said.revokeRefused} ${said.ask(adminName)}`
        })
      ).toBeVisible();
      // Asking again would be refused again: one Close is left, beside the head's close icon.
      await expect(question.getByRole("button", { name: said.revoke })).toHaveCount(0);
      await expect(question.getByRole("button", { name: said.cancel })).toHaveCount(0);
      const close = question.getByRole("button").filter({ hasText: said.close });
      await expect(close).toHaveCount(1);
      await shoot(page, "api-keys-revoke-refused", view);
      await close.click();
      await expect(question).toBeHidden();
      await page.unrouteAll({ behavior: "ignoreErrors" });
    });

    // The list itself refused.
    await page.route("**/api/v1/me/api-keys**", (route) =>
      route.request().method() === "GET" ? refuse(route) : route.fallback()
    );
    await eachView(page, "/settings/you/api-keys", async (view) => {
      const said = words[view.locale];
      await expect(
        page.locator('[data-tone="info"]', {
          hasText: `${said.listRefused} ${said.ask(adminName)}`
        })
      ).toBeVisible();
      await shoot(page, "api-keys-list-refused", view);
    });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/me/api-keys/${keyId}/revoke`);
  }
});

test("Members come first, requests show only while somebody asks, and a refusal names an instance admin in its section", async ({
  page
}) => {
  test.setTimeout(360_000);
  // An admin named on a refusal is one who has signed in; this test does not rely on another.
  await signIn(page, admin);
  await signIn(page, owner);
  const adminName = await instanceAdminName(page);
  const name = `First blocks ${randomUUID().slice(0, 6)}`;
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name, visibility: "discoverable" }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const membersPath = "/settings/workspace/members";
  const memberRow = page.getByTestId("collaboration-workspace-member-row").first();

  try {
    // The browser remembers the workspace last opened, which the Workspace pages change.
    await page.goto(`/w/${workspaceId}`);
    await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}`, "u"));
    // A workspace people can find, with nobody asking: no Requests section at all.
    await eachView(page, membersPath, async (view) => {
      const said = words[view.locale];
      await expect(memberRow).toBeVisible();
      // One title, with Add member in the page's head, as API keys has New key.
      await expect(
        page.getByRole("heading", { level: 1, name: said.members, exact: true })
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: said.members, exact: true })
      ).toHaveCount(0);
      await expect(
        page.locator("header").getByRole("button", { name: said.addMember })
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { level: 2, name: said.requests, exact: true })
      ).toHaveCount(0);
      await shoot(page, "members", view);
    });

    // Somebody asks: Requests stands below Members, and approving it is refused here.
    // A predicate on the path, so the list's paging query matches too.
    const requestList = `/api/v1/workspaces/${workspaceId}/access-requests`;
    await page.route(
      (url) => url.pathname === requestList,
      (route) =>
        route.request().method() === "GET"
          ? route.fulfill({ json: { items: [plantedRequest] } })
          : route.fallback()
    );
    await page.route("**/api/v1/workspaces/*/access-requests/*/approve", refuse);
    // Each view loads the page again: approving changes what the next picture would show.
    for (const view of LOOKS.flatMap((look) => SIZES.map((size) => ({ ...look, ...size })))) {
      const said = words[view.locale];
      await page.setViewportSize(view);
      await open(page, membersPath, view);
      await expect(memberRow).toBeVisible();
      const members = page.getByTestId("collaboration-workspace-members");
      const requests = page.getByRole("heading", { level: 2, name: said.requests, exact: true });
      const requestsSection = page.locator("section").filter({ has: requests });
      const request = page
        .getByTestId("collaboration-workspace-request-row")
        .filter({ hasText: plantedRequest.displayLabel });
      await expect(request).toBeVisible();
      expect(await topOf(members)).toBeLessThan(await topOf(requests));
      // The name stands whole at a phone's width; the date went into the line under it.
      const requesterName = request.getByText(plantedRequest.displayLabel, { exact: true });
      await expect(requesterName).toBeVisible();
      expect(await requesterName.evaluate((name) => name.scrollWidth <= name.clientWidth + 1)).toBe(
        true
      );
      await expect(request).toContainText(plantedRequest.email);
      // The email and the date stay in their column: no word runs on under Decline.
      const description = request.getByText(plantedRequest.email, { exact: false });
      expect(await description.evaluate((line) => line.scrollWidth <= line.clientWidth + 1)).toBe(
        true
      );
      const descriptionBox = await boxOf(description);
      const declineBox = await boxOf(request.getByRole("button", { name: said.decline }));
      expect(descriptionBox.x + descriptionBox.width).toBeLessThanOrEqual(declineBox.x);
      await shoot(page, "members-requests", view);

      await request.getByRole("button", { name: said.approve }).click();
      // Said at the top of Requests, naming what was refused, never above the members.
      const refusal = requestsSection.locator('[data-tone="info"]', {
        hasText: `${said.approveRefused} ${said.ask(adminName)}`
      });
      await expect(refusal).toBeVisible();
      await expect(members.locator("[data-tone]")).toHaveCount(0);
      expect(await topOf(requests)).toBeLessThan(await topOf(refusal));
      expect(await topOf(refusal)).toBeLessThan(await topOf(request));
      await expect(request).toBeVisible();
      await scrollToTop(requests);
      await expect(refusal).toBeInViewport({ ratio: 1 });
      await expect(requesterName).toBeInViewport();
      await shoot(page, "members-refused", view);
    }
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`, {
      data: { confirmName: name }
    });
  }
});
