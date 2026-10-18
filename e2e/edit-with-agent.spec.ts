import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { sendToolCall } from "./page-surface-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// UXA-3a, navigation check 39, first half: "Edit with the agent" on an App draft or a Workflow
// keeps the asset's page and opens the dock beside it. The dock's head names the agent with its
// mark and "Working on:" the asset, its starters fit the kind, and the agent's first changing
// call acts on that asset. At 390 px the dock lies in front of the page, and "Show page" brings
// the page forward. Fails where the head names only the conversation, where the empty
// conversation offers the agent's own starters, or where the page is left. ACCEPT-1c: the action
// also stays in the head with the dock open, and pressing it again reopens the same conversation.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const EDIT = "Edit with the agent";

const idSchema = z.object({ id: z.string() });
const appSchema = z.looseObject({ draftRevision: z.number() });

const chatColumn = (page: Page) => page.locator("[data-dock-chat]");
const dockHead = (page: Page) => page.getByTestId("dock-head");

async function signIn(page: Page): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
}

async function createWorkspace(page: Page, name: string): Promise<string> {
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name }
  });
  expect(created.ok(), await created.text()).toBe(true);
  return idSchema.parse(await created.json()).id;
}

/** The starters the empty conversation in the dock offers, by their titles. */
async function starterTitles(page: Page): Promise<string[]> {
  return chatColumn(page).locator('[role="group"] button .text-label').allTextContents();
}

/** How many starters stand in the first row: the dock is too narrow for two side by side. */
async function startersInFirstRow(page: Page): Promise<number> {
  const tops = await chatColumn(page)
    .locator('[role="group"] button')
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().top));
  return tops.filter((top) => top === tops[0]).length;
}

/**
 * The dock lies over the page at phone width and is in front: the point in the middle of the
 * window belongs to the conversation, whatever `toBeInViewport` says of the page under it.
 */
async function dockInFront(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const hit = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    return hit?.closest("[data-dock-chat]") !== null;
  });
}

/**
 * The dock in front at 390 px and its "Show page", which brings the page forward and leaves
 * "Show chat" on it.
 */
async function showPageAtPhoneWidth(page: Page, pageReady: () => Promise<void>): Promise<void> {
  // A phone opens the address at its own width.
  await page.setViewportSize(PHONE);
  await page.reload();
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  await expect(dockHead(page)).toBeVisible();
  await pageReady();
  await expect.poll(() => dockInFront(page)).toBe(true);
  // Nothing the page pins, such as its head, is drawn over the dock's head. The covered page is
  // inert, which a hit test passes through: it is read for the moment without.
  const showPage = dockHead(page).getByRole("button", { name: "Show page", exact: true });
  expect(
    await showPage.evaluate((button) => {
      const covered = document.querySelector("[data-dock-page]");
      covered?.removeAttribute("inert");
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      covered?.setAttribute("inert", "");
      return hit !== null && button.contains(hit);
    })
  ).toBe(true);
  await showPage.click();
  await expect.poll(() => dockInFront(page)).toBe(false);
  await pageReady();
  await expect(page.getByTestId("dock-page-action")).toHaveText(/Show chat/u);
  await page.getByTestId("dock-page-action").click();
  await expect.poll(() => dockInFront(page)).toBe(true);
  await page.setViewportSize(WIDE);
}

/**
 * Pictures of the page with the dock, in both themes and languages at 1280 and 390 px. The
 * language and the theme are read when the interface loads, so each variant loads the address
 * again and waits for `ready`. The page is left light, in English, at 1280 px.
 */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  const show = async (theme: string, locale: string, size: typeof WIDE) => {
    await page.evaluate(
      ([themeValue, localeValue]) => {
        window.localStorage.setItem("vivd-catalyst:theme", themeValue);
        window.localStorage.setItem("vivd-catalyst:locale", localeValue);
      },
      [theme, locale] as const
    );
    await page.setViewportSize(size);
    await page.reload();
    await ready();
  };
  for (const theme of ["light", "dark"]) {
    for (const locale of ["en", "de"]) {
      for (const size of [WIDE, PHONE]) {
        await show(theme, locale, size);
        await page.screenshot({
          path: join(shotsDir, `${name}-${theme}-${locale}-${size.width}.png`),
          animations: "disabled"
        });
      }
    }
  }
  await show("light", "en", WIDE);
}

/** The App's files, with this heading on its one screen. */
function appFiles(id: string, name: string, heading: string) {
  return [
    { path: "app.yaml", text: `id: ${id}\nname: ${name}\nkit: 1.5.0\nentry: index.html\n` },
    {
      path: "index.html",
      text: `<!doctype html><html><body><h1>${heading}</h1><label>Hours <input></label></body></html>`
    }
  ];
}

function draftHeading(page: Page, heading: string): Locator {
  return page
    .getByTestId("app-edit")
    .getByTestId("page-preview-frame")
    .contentFrame()
    .frameLocator("iframe")
    .getByRole("heading", { name: heading });
}

test("Edit with the agent keeps the App's draft and opens the dock about it", async ({ page }) => {
  test.setTimeout(shotsDir ? 300_000 : 120_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const tag = randomUUID().slice(0, 8);
  const appId = `rate-card-${tag}`;
  const appName = `Rate card ${tag}`;
  const workspaceId = await createWorkspace(page, `Edit with the agent ${tag}`);
  const appUrl = `${apiOrigin}/api/v1/assets/app/${appId}`;
  const saved = await requestWithOrigin(page, "put", appUrl, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: appFiles(appId, appName, "Hourly rate")
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const draftRevision = async () =>
    appSchema.parse(await (await page.request.get(`${appUrl}?workspaceId=${workspaceId}`)).json())
      .draftRevision;
  const draftPath = `/w/${workspaceId}/app-drafts/${appId}`;

  await page.goto(draftPath);
  await expect(draftHeading(page, "Hourly rate")).toBeVisible();
  await page.getByTestId("app-edit").getByRole("button", { name: EDIT, exact: true }).click();

  // The page stays: the same address, now with the conversation in the dock beside the draft.
  await expect(page).toHaveURL((url) => url.pathname === draftPath && url.searchParams.has("chat"));
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  await expect(draftHeading(page, "Hourly rate")).toBeVisible();
  const head = dockHead(page);
  await expect(head).toHaveAttribute("data-subject-kind", "app");
  await expect(head).toContainText(`Working on: ${appName}`);
  await expect(head.locator('[data-kind="agent"]')).toBeVisible();
  // The head says what the conversation is about; the composer does not say it again.
  await expect(chatColumn(page).getByTestId("conversation-subject")).toHaveCount(0);
  await expect.poll(() => starterTitles(page)).toEqual(["Add a field", "Change the look"]);
  // The dock beside the page at 1280 px gives each starter a row, so no hint is cut.
  expect(await startersInFirstRow(page)).toBe(1);
  // ACCEPT-1c C6: the start page speaks of the App, never with the configured agent's welcome.
  await expect(chatColumn(page)).not.toContainText("demo workflow");
  // ACCEPT-1c C12: beside the open dock the head still shows the action, not only in "…", and
  // pressing it again opens the same conversation rather than a second one.
  const conversation = new URL(page.url()).searchParams.get("chat");
  const again = page.getByTestId("app-edit").getByRole("button", { name: EDIT, exact: true });
  await expect(again).toBeVisible();
  await again.click();
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  expect(new URL(page.url()).searchParams.get("chat")).toBe(conversation);
  await expect(chatColumn(page).getByPlaceholder("Message")).toBeFocused();

  const ready = async () => {
    await expect(head).toContainText(appName);
    await expect.poll(() => starterTitles(page)).toHaveLength(2);
    await expect(page.getByTestId("app-edit")).toBeAttached();
  };
  await shoot(page, "uxa-3a-app", ready);
  await showPageAtPhoneWidth(page, async () => {
    await expect(draftHeading(page, "Hourly rate")).toBeVisible();
  });

  // A starter fills the composer and sends nothing.
  await chatColumn(page)
    .getByRole("button", { name: /^Add a field/u })
    .click();
  await expect(chatColumn(page).getByPlaceholder("Message")).toHaveValue(
    "Add a field to this app: "
  );
  expect(await draftRevision()).toBe(1);

  // The agent's first changing call names no App and writes this one's draft, which the page
  // beside the dock shows.
  await sendToolCall(page, "platform.assets.put", {
    files: appFiles(appId, appName, "Hourly rate and VAT"),
    expectedRevision: 1
  });
  await expect.poll(draftRevision).toBe(2);
  await expect(draftHeading(page, "Hourly rate and VAT")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(draftPath);
});

const NAME = "Invoice check";

/** A definition of the Workflow with this description. */
function workflowConfig(id: string, runAs: string, description: string, recipient?: string) {
  return {
    name: id,
    manifest: {
      id,
      name: NAME,
      description,
      runAs,
      inputs: { type: "object", additionalProperties: false },
      outputs: {
        type: "object",
        properties: { done: { type: "integer" } },
        required: ["done"]
      },
      steps: [
        { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
        ...(recipient === undefined
          ? []
          : [
              {
                id: "tell",
                name: "Send summary",
                type: "notify",
                to: { users: [recipient] },
                channels: ["inbox"],
                title: { value: "Document summary" },
                text: { value: "Ready" }
              }
            ]),
        { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
      ]
    }
  };
}

test("Edit with the agent keeps the Workflow's page and opens the dock about it", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 300_000 : 120_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const id = `invoice-check-${randomUUID().slice(0, 8)}`;
  const meResponse = await page.request.get(`${apiOrigin}/api/v1/me`);
  expect(meResponse.ok()).toBe(true);
  const me = z.object({ id: z.string(), displayLabel: z.string() }).parse(await meResponse.json());
  const runAs = `${id}-runner`;
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const assetUrl = `${apiOrigin}/api/v1/assets/workflow/${id}`;
  const saved = await requestWithOrigin(page, "put", assetUrl, {
    data: { expectedRevision: null, config: workflowConfig(id, runAs, "The first draft.", me.id) }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const revision = () => assetRevision(page, assetUrl);
  const workspaceId = await createWorkspace(page, `Edit a Workflow ${id.slice(-8)}`);
  const workflowPath = `/w/${workspaceId}/workflows/${id}`;

  await page.goto(workflowPath);
  const workflowPage = page.getByTestId("workflow-page");
  await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
  await workflowPage.getByRole("button", { name: EDIT, exact: true }).click();

  await expect(page).toHaveURL(
    (url) => url.pathname === workflowPath && url.searchParams.has("chat")
  );
  await expect(chatColumn(page)).toHaveAttribute("data-chat-mode", "dock");
  await expect(workflowPage.getByTestId("workflow-canvas")).toBeVisible();
  const head = dockHead(page);
  await expect(head).toHaveAttribute("data-subject-kind", "workflow");
  await expect(head).toContainText(`Working on: ${NAME}`);
  await expect(head.locator('[data-kind="agent"]')).toBeVisible();
  await expect.poll(() => starterTitles(page)).toEqual(["Add a step", "Run a test"]);
  expect(await startersInFirstRow(page)).toBe(1);
  await expect(chatColumn(page)).not.toContainText("demo workflow");
  // ACCEPT-1c C12: the action stays in the head beside the dock and opens the same conversation.
  const conversation = new URL(page.url()).searchParams.get("chat");
  const again = workflowPage.getByRole("button", { name: EDIT, exact: true });
  await expect(again).toBeVisible();
  await again.click();
  expect(new URL(page.url()).searchParams.get("chat")).toBe(conversation);

  // C9: resolve the real signed-in recipient through the host, on the node and its detail,
  // in both languages. The rendering must not substitute the delivery channel for the person.
  for (const locale of ["en", "de"]) {
    await page.evaluate(
      (value) => window.localStorage.setItem("vivd-catalyst:locale", value),
      locale
    );
    await page.reload();
    const notify = workflowPage.locator('[data-flow-id="tell"]');
    await expect(notify).toContainText(me.displayLabel);
    await notify.click();
    const details = workflowPage.locator('[data-step-panel="tell"]');
    await expect(details).toBeVisible();
    await expect(details).toContainText(me.displayLabel);
    await expect(details).not.toContainText(me.id);
    if (shotsDir)
      await page.screenshot({
        path: join(shotsDir, `accept-fix-3-notify-${locale}.png`),
        animations: "disabled"
      });
  }
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.reload();

  const ready = async () => {
    await expect(head).toContainText(NAME);
    await expect.poll(() => starterTitles(page)).toHaveLength(2);
    await expect(workflowPage).toBeAttached();
  };
  await shoot(page, "uxa-3a-workflow", ready);
  await showPageAtPhoneWidth(page, async () => {
    await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
  });

  // The agent's first changing call names no Workflow and writes this one's draft.
  const before = await revision();
  await sendToolCall(page, "platform.assets.put", {
    config: workflowConfig(id, runAs, "The draft the agent saved."),
    expectedRevision: before
  });
  await expect.poll(revision).toBe(before + 1);
  await expect(workflowPage.getByText("The draft the agent saved.")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(workflowPath);
});
