import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// EW-8: a person schedules a prompt on the Scheduled page, runs it now and opens the
// conversation it started; pauses, resumes, changes and deletes it there. An agent's call that
// schedules one shows its prompt and time in words before Allow, and the saved prompt then
// stands on the page. The page holds in German, dark and narrow without sideways scrolling.

const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 640 };
/** How long a cleanup request may take; a slow one never hides the test's own failure. */
const CLEANUP_TIMEOUT_MS = 10_000;
/** How long the list read is held, so its loading state shows. */
const LIST_HOLD_MS = 1_000;

const shotsDir = process.env.E2E_SHOTS_DIR;
const idSchema = z.object({ id: z.string() });
const agentsSchema = z.object({ defaultAgentName: z.string() });
const startsSchema = z.object({
  items: z.array(z.object({ id: z.string(), prompt: z.string() }))
});

const composerOf = (page: Page) => page.getByPlaceholder(/^(?:Message|Nachricht)$/u);
const railButton = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Main navigation" }).getByRole("button", { name });

/** Signs in with the locale and theme the pages open in, and answers the person's workspace. */
async function signedIn(
  page: Page,
  look: { locale: "en" | "de"; theme: "light" | "dark" } = { locale: "en", theme: "light" }
): Promise<string> {
  const signed = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: {
      email: process.env.E2E_SUPERADMIN_EMAIL ?? "e2e-superadmin@example.test",
      password: process.env.E2E_SUPERADMIN_PASSWORD ?? "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signed.ok()).toBe(true);
  await page.addInitScript(
    ([origin, locale, theme]) => {
      if (location.origin !== origin) return;
      localStorage.setItem("vivd-catalyst:locale", locale);
      localStorage.setItem("vivd-catalyst:theme", theme);
    },
    [uiOrigin, look.locale, look.theme] as const
  );
  const personal = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces/personal`);
  expect(personal.ok(), await personal.text()).toBe(true);
  return idSchema.parse(await personal.json()).id;
}

/** Saves a scheduled prompt through the API, as the page's own create does. */
async function saveStart(page: Page, workspaceId: string, prompt: string): Promise<void> {
  const agents = agentsSchema.parse(
    await (await page.request.get(`${apiOrigin}/api/v1/workspaces/${workspaceId}/agents`)).json()
  );
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/scheduled-starts`, {
    data: {
      collaborationWorkspaceId: workspaceId,
      agentName: agents.defaultAgentName,
      prompt,
      cron: "0 8 * * 1-5",
      timeZone: "Europe/Berlin"
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
}

/**
 * Deletes what a test scheduled, whatever step it stopped at. Each request is bounded and a
 * failure here is only logged, so the test reports its own failure, not the cleanup's.
 */
async function deleteStarts(page: Page, workspaceId: string, marker: string): Promise<void> {
  try {
    const response = await page.request.get(
      `${apiOrigin}/api/v1/scheduled-starts?collaborationWorkspaceId=${workspaceId}&limit=100`,
      { timeout: CLEANUP_TIMEOUT_MS }
    );
    if (!response.ok()) return;
    const { items } = startsSchema.parse(await response.json());
    for (const start of items.filter((item) => item.prompt.includes(marker)))
      await requestWithOrigin(page, "delete", `${apiOrigin}/api/v1/scheduled-starts/${start.id}`, {
        timeout: CLEANUP_TIMEOUT_MS
      });
  } catch (error) {
    console.warn(`Scheduled prompts of ${marker} were not cleaned up:`, error);
  }
}

/** One picture of the page as it stands, where `E2E_SHOTS_DIR` names a folder. */
async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `scheduled-${name}.png`), animations: "disabled" });
}

/** Holds each read of the list for a second, so its loading state can be seen. */
async function holdListReads(page: Page): Promise<void> {
  await page.route(
    (url) => url.origin === apiOrigin && url.pathname === "/api/v1/scheduled-starts",
    async (route) => {
      if (route.request().method() === "GET")
        await new Promise((resolve) => setTimeout(resolve, LIST_HOLD_MS));
      await route.fallback();
    }
  );
}

async function noSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

test("a prompt scheduled on the page runs now and opens its conversation", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize(WIDE);
  const workspaceId = await signedIn(page);
  const marker = randomUUID().slice(0, 8);
  const prompt = `Summarize the open tickets ${marker}`;
  try {
    await page.goto(`/w/${workspaceId}/scheduled`);
    await expect(page.getByRole("heading", { name: "Scheduled", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Schedule a prompt" }).first().click();

    // The dialog starts on every weekday at eight in the instance's zone. Its buttons stand
    // in the dialog's footer, outside its form, so they are found in the dialog.
    const create = page.getByRole("dialog", { name: "Schedule a prompt" });
    await create.getByLabel("Prompt").fill(prompt);
    await expect(create.getByTestId("scheduled-dialog-summary")).toContainText("Every weekday");
    await shoot(page, "en-light-wide-dialog");
    await create.getByRole("button", { name: "Schedule", exact: true }).click();
    await expect(create).toBeHidden();

    const card = page.getByTestId("scheduled-start").filter({ hasText: marker });
    await expect(card.getByRole("heading", { name: prompt })).toBeVisible();
    await expect(card.getByTestId("scheduled-next")).toBeVisible();

    // Run now: the run shows under the card and ends with a conversation to open.
    await card.getByRole("button", { name: "Run now" }).click();
    const run = card.getByTestId("scheduled-run").first();
    await expect(run).toHaveAttribute("data-status", "completed", { timeout: 90_000 });
    await shoot(page, "en-light-wide-run");
    await run.getByRole("link", { name: "Open conversation" }).click();
    await expect(page).toHaveURL((url) => url.pathname.startsWith(`/w/${workspaceId}/c/`));
    await expect(page.getByText(`Local agent response: I received "${prompt}"`)).toBeVisible({
      timeout: 30_000
    });

    // Pause and resume, with the answer where the person acted.
    await page.goto(`/w/${workspaceId}/scheduled`);
    await card.getByRole("button", { name: "Pause" }).click();
    await expect(card).toHaveAttribute("data-state", "paused");
    await expect(card.getByTestId("scheduled-next")).toBeHidden();
    await card.getByRole("button", { name: "Resume" }).click();
    await expect(card).toHaveAttribute("data-state", "active");
    await expect(card.getByTestId("scheduled-next")).toBeVisible();

    // Edit: the heading follows the prompt.
    const changed = `Summarize the closed tickets ${marker}`;
    await card.getByRole("button", { name: "More for this scheduled prompt" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const edit = page.getByRole("dialog", { name: "Edit scheduled prompt" });
    await expect(edit.getByLabel("Prompt")).toHaveValue(prompt);
    await edit.getByLabel("Prompt").fill(changed);
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(edit).toBeHidden();
    await expect(card.getByRole("heading", { name: changed })).toBeVisible();

    // Delete asks first.
    await card.getByRole("button", { name: "More for this scheduled prompt" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const confirm = page.getByRole("dialog", { name: "Delete this scheduled prompt?" });
    await confirm.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(card).toHaveCount(0);
  } finally {
    await deleteStarts(page, workspaceId, marker);
  }
});

test("the list loads, scrolls and stays across switching to another area and back", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize(WIDE);
  const workspaceId = await signedIn(page);
  const marker = randomUUID().slice(0, 8);
  const prompts = Array.from({ length: 5 }, (_, index) => `Weekly report ${index + 1} ${marker}`);
  try {
    for (const prompt of prompts) await saveStart(page, workspaceId, prompt);
    await holdListReads(page);
    await page.goto(`/w/${workspaceId}/scheduled`);
    // While the held read runs, the list stands as a skeleton.
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
    await shoot(page, "en-light-wide-loading");
    const cards = page.getByTestId("scheduled-start").filter({ hasText: marker });
    await expect(cards).toHaveCount(prompts.length);
    await shoot(page, "en-light-wide-list");

    for (let round = 0; round < 2; round += 1) {
      const last = cards.last();
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeInViewport();
      await railButton(page, "Workflows").click();
      await expect(page).toHaveURL((url) => url.pathname === `/w/${workspaceId}/workflows`);
      const [listRead] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/api/v1/scheduled-starts" &&
            response.request().method() === "GET" &&
            response.ok()
        ),
        railButton(page, "Scheduled").click()
      ]);
      await listRead.finished();
      await expect(page).toHaveURL((url) => url.pathname === `/w/${workspaceId}/scheduled`);
      await expect(page.getByRole("heading", { name: "Scheduled", level: 1 })).toBeVisible();
      await expect(cards).toHaveCount(prompts.length);
    }

    // A start saved from chat or another tab appears without leaving this open page.
    await saveStart(page, workspaceId, `Added while the list is open ${marker}`);
    await expect(cards).toHaveCount(prompts.length + 1, { timeout: 40_000 });
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await deleteStarts(page, workspaceId, marker);
  }
});

test("in German, dark and narrow the page and its dialog fit the screen", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize(NARROW);
  const workspaceId = await signedIn(page, { locale: "de", theme: "dark" });
  const marker = randomUUID().slice(0, 8);
  const prompt = `Fasse die offenen Fristen der Mandanten zusammen ${marker}`;
  try {
    await saveStart(page, workspaceId, prompt);
    await holdListReads(page);
    await page.goto(`/w/${workspaceId}/scheduled`);
    await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
    await shoot(page, "de-dark-narrow-loading");

    const card = page.getByTestId("scheduled-start").filter({ hasText: marker });
    await expect(card.getByRole("heading", { name: prompt })).toBeVisible();
    await expect(card).toContainText("Werktags, 08:00 (Ortszeit Berlin)");
    await expect(card.getByRole("button", { name: "Jetzt ausführen" })).toBeVisible();
    await noSidewaysScroll(page);
    await shoot(page, "de-dark-narrow-list");

    await page.getByRole("button", { name: "Prompt planen" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Prompt planen" });
    await expect(dialog.getByLabel("Prompt")).toBeVisible();
    // A custom schedule starts from the one chosen before, with the cron help beneath.
    await dialog.getByLabel("Wiederholt sich").selectOption({ label: "Eigener Zeitplan (Cron)" });
    await expect(dialog.getByLabel("Cron-Ausdruck")).toHaveValue("0 8 * * 1-5");
    await noSidewaysScroll(page);
    await shoot(page, "de-dark-narrow-dialog");
    await dialog.getByRole("button", { name: "Abbrechen" }).click();
    await expect(dialog).toBeHidden();
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await deleteStarts(page, workspaceId, marker);
  }
});

test("an agent's scheduled prompt is confirmed in words and then stands on the page", async ({
  page
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize(WIDE);
  const workspaceId = await signedIn(page);
  const agents = agentsSchema.parse(
    await (await page.request.get(`${apiOrigin}/api/v1/workspaces/${workspaceId}/agents`)).json()
  );
  const marker = randomUUID().slice(0, 8);
  const prompt = `Check the weekly deadlines ${marker}`;
  try {
    await page.goto(`/w/${workspaceId}`);
    await composerOf(page).fill(
      `/tool scheduled_starts.create ${JSON.stringify({
        collaborationWorkspaceId: workspaceId,
        agentName: agents.defaultAgentName,
        prompt,
        cron: "0 8 * * 1-5",
        timeZone: "Europe/Berlin"
      })}`
    );
    await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();

    // Before Allow the card says what is planned, when and as whom, not the raw cron.
    const summary = page.getByTestId("scheduled-confirmation");
    await expect(summary).toBeVisible({ timeout: 90_000 });
    await expect(summary).toHaveAttribute("data-verb", "create");
    await expect(summary).toContainText(prompt);
    await expect(summary).toContainText(/Every weekday, 0?8:00\s?AM \(Berlin time\)/u);
    await expect(summary).toContainText("You, with your rights at each run");
    await shoot(page, "en-light-wide-confirmation");
    await page.getByRole("button", { name: /^(?:Allow|Erlauben)$/u }).click();
    await expect(page.getByText(/Tool work completed:/u).last()).toBeVisible({ timeout: 60_000 });

    await page.goto(`/w/${workspaceId}/scheduled`);
    const card = page.getByTestId("scheduled-start").filter({ hasText: marker });
    await expect(card.getByRole("heading", { name: prompt })).toBeVisible();
    await expect(card).toContainText("(Berlin time)");
  } finally {
    await deleteStarts(page, workspaceId, marker);
  }
});
