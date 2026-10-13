import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { ALLOWED_URL, plantConnection, removeConnection } from "./connection-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// The Actions side of a draft: a builder reads which actions the App has, what each reaches
// and what a call would come to, tests the reading one with a real call, follows the link of
// the result and finds the run in Instance > Operations with the origin App. The run stays
// after the App is deleted and then says so. Fails without S3-43: a draft had two sides, an
// action could be called from a tile alone, and a run said "App" and nothing of its App.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

/** The two people of this spec, from `tests/fixtures/e2e-app.yaml`. */
const builder = {
  email: "e2e-app-actions-view@example.test",
  password: "e2e-app-actions-view-password"
};
const member = {
  email: "e2e-app-actions-view-member@example.test",
  password: "e2e-app-actions-view-member-password"
};

const idSchema = z.object({ id: z.string() });

/** The source of an App with a reading action, a changing one and nothing to look at. */
function appSource(app: { id: string; connection: string }): { path: string; text: string }[] {
  const files: Record<string, string> = {
    "app.yaml": `id: ${app.id}\nname: Stock desk\nkit: 1.1.0\nentry: index.html\nconnections:\n  - ${app.connection}\n`,
    "index.html": "<!doctype html><title>Stock desk</title><p>Stock desk</p>",
    "actions/load-rows.action.yaml": `connection: ${app.connection}
operation: echo
effect: reading
description: Reads the rows of the stock system.
input:
  schema: { type: object, properties: { text: { type: string } }, required: [text] }
  mapping: { text: "{{text}}" }
`,
    "actions/book-row.action.yaml": `connection: ${app.connection}
operation: book
effect: changing
description: Books one row into the stock system.
`
  };
  return Object.entries(files).map(([path, text]) => ({ path, text }));
}

/** The source of an App that has no action. */
function plainSource(id: string): { path: string; text: string }[] {
  return [
    { path: "app.yaml", text: `id: ${id}\nname: Notes\nkit: 1.1.0\nentry: index.html\n` },
    { path: "index.html", text: "<!doctype html><title>Notes</title><p>Notes</p>" }
  ];
}

async function signIn(page: Page, person: { email: string; password: string }): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The instance knows a person of the config from their first call on.
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

/** Sets the theme and the language the next load reads. */
async function setLook(page: Page, theme: "light" | "dark", locale: "en" | "de"): Promise<void> {
  await page.evaluate(
    ([themeValue, localeValue]) => {
      window.localStorage.setItem("vivd-catalyst:theme", themeValue);
      window.localStorage.setItem("vivd-catalyst:locale", localeValue);
    },
    [theme, locale] as const
  );
}

/** One picture: the theme, the language, and the width and the height of the window. */
type Look = readonly ["light" | "dark", "en" | "de", number, number?];

/** Both themes, and German and 390 wide once each. */
const usualLooks: readonly Look[] = [
  ["light", "en", 1440],
  ["dark", "en", 1440],
  ["light", "de", 1440],
  ["dark", "en", 390]
];

/**
 * Pictures of one state, one per look. `reach` leads to the state after a load, since the
 * theme and the language are read at load. A look that names a height is a window lower than
 * the usual one, and its picture says so in its name.
 */
async function shoot(
  page: Page,
  name: string,
  reach: () => Promise<void>,
  looks: readonly Look[] = usualLooks
): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  for (const [theme, locale, width, height] of looks) {
    await setLook(page, theme, locale);
    await page.setViewportSize({ width, height: height ?? (width === 390 ? 844 : 900) });
    await reach();
    await page.screenshot({
      path: join(
        shotsDir,
        `${name}-${theme}-${locale}-${width}${height === undefined ? "" : `x${height}`}.png`
      ),
      animations: "disabled"
    });
  }
  await setLook(page, "light", "en");
  await page.setViewportSize({ width: 1440, height: 900 });
  await reach();
}

/** The dialog is gone and the page under it takes input again. */
async function closed(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog).toBeHidden();
  await expect(page.locator("[data-radix-focus-guard]")).toHaveCount(0);
}

// A route that holds or rewrites an answer ends with its test.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

// The test plants a Connection: it takes its turn with the specs that start an API, which
// would delete a planted Connection.
test("a builder reads the actions of a draft, tests a reading one and finds its run in Operations", async ({
  page,
  browser,
  baseURL,
  pageErrors,
  releaseConnections: _releaseConnections
}, testInfo) => {
  // An App's id is taken once for the whole instance, so a repeated or retried run names its
  // Apps after the attempt.
  const attempt = testInfo.repeatEachIndex * 10 + testInfo.retry;
  const suffix = attempt === 0 ? "" : `-${attempt}`;
  const appId = `stock-desk${suffix}`;
  const plainId = `stock-notes${suffix}`;
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `e2e_desk_${randomUUID().slice(0, 8)}`,
    displayName: "Stock system",
    url: ALLOWED_URL,
    authScheme: "none" as const,
    operations: [
      { name: "echo", effect: "reading" as const, exposure: ["bridge", "agent"], enabled: true },
      { name: "book", effect: "changing" as const, exposure: ["bridge"], enabled: true }
    ]
  };
  test.setTimeout(shotsDir ? 600_000 : 180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  page.setDefaultTimeout(30_000);
  await signIn(page, builder);
  // The member signs in first: a workspace takes a person the instance already knows.
  const memberContext = await browser.newContext({
    baseURL,
    viewport: { width: 1440, height: 900 }
  });
  await pageErrors.watch(memberContext);
  const memberPage = await memberContext.newPage();
  memberPage.setDefaultTimeout(30_000);
  await signIn(memberPage, member);

  await plantConnection(connection);
  try {
    const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
      data: { name: `Stock desk ${attempt}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = idSchema.parse(await created.json()).id;
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiOrigin}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: member.email } }
    );
    expect(added.ok(), await added.text()).toBe(true);
    const appUrl = (id: string) => `${apiOrigin}/api/v1/assets/app/${id}`;
    for (const [id, files] of [
      [appId, appSource({ id: appId, connection: connection.name })],
      [plainId, plainSource(plainId)]
    ] as const) {
      const written = await requestWithOrigin(page, "put", appUrl(id), {
        // The App is new: a write names the revision it read, and none was read.
        data: { workspaceId, expectedRevision: null, files },
        timeout: 90_000
      });
      expect(written.ok(), await written.text()).toBe(true);
    }
    const draftPath = (id: string) => `/w/${workspaceId}/app-drafts/${id}`;
    const draft = page.getByTestId("app-edit");
    const actions = draft.locator("[data-app-actions]");
    const row = (name: string) => draft.locator(`[data-app-action="${name}"]`);
    /** Opens the Actions side of a draft: the third side beside Preview and Files. */
    const openActions = async (id: string) => {
      await page.goto(draftPath(id));
      await draft.getByRole("radio", { name: /^(Actions|Aktionen)$/u }).click();
      await expect(actions).toBeVisible();
    };

    // The list: one row per action, with what it calls by the Connection's label and what a
    // call would come to for the builder.
    await openActions(appId);
    await expect(actions).toHaveAttribute("data-app-actions", "ready");
    await expect(row("load-rows")).toContainText("Reads the rows of the stock system.");
    await expect(row("load-rows")).toContainText("Reading");
    await expect(row("load-rows")).toContainText("Stock system");
    await expect(row("load-rows")).toContainText("echo");
    await expect(row("load-rows")).toContainText("Can be tested");
    // One line over the list says what it is, to a reader who knows none of the words.
    await expect(draft.locator("[data-app-actions-intro]")).toContainText(
      "What this app can read or change in other systems."
    );
    // A changing action is not carried out in a draft, and nothing offers to test it.
    await expect(row("book-row")).toContainText("Changing");
    await expect(row("book-row")).toContainText("Not carried out in a draft");
    await expect(row("book-row").getByRole("button")).toHaveCount(0);
    await expect(draft.getByRole("button", { name: /^Test /u })).toHaveCount(1);

    // At 390 wide each action is a block: nothing runs out of sight sideways, and the test
    // is on the screen under nothing else.
    await page.setViewportSize({ width: 390, height: 844 });
    await openActions(appId);
    const narrowTest = row("load-rows").getByRole("button", { name: "Test load-rows" });
    await expect(narrowTest).toBeInViewport({ ratio: 1 });
    await expect(row("load-rows")).toContainText("Can be tested");
    expect(
      await actions.evaluate((table) => {
        const box = table.parentElement;
        return box !== null && box.scrollWidth <= box.clientWidth;
      })
    ).toBe(true);
    expect(
      await narrowTest.evaluate((button) => {
        const { left, top, width, height } = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(left + width / 2, top + height / 2));
      })
    ).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await shoot(page, "actions-list", () => openActions(appId), [
      ...usualLooks,
      ["light", "en", 390]
    ]);

    // An App without actions, and a list the instance did not answer.
    await openActions(plainId);
    await expect(actions).toHaveAttribute("data-app-actions", "empty");
    await expect(actions).toContainText("This app has no actions yet.");
    await shoot(page, "actions-empty", () => openActions(plainId));
    await page.route("**/api/v1/app-actions?*", (route) =>
      route.fulfill({ status: 500, json: { error: { code: "INTERNAL", message: "failed" } } })
    );
    await openActions(appId);
    await expect(actions).toHaveAttribute("data-app-actions", "failed");
    await expect(actions).toContainText("The actions could not be loaded.");
    await shoot(page, "actions-failed", () => openActions(appId));
    await page.unroute("**/api/v1/app-actions?*");
    await actions.getByRole("button", { name: "Try again" }).click();
    await expect(actions).toHaveAttribute("data-app-actions", "ready");

    // The test: the input is checked before any call, then the call is made as the builder.
    const dialog = page.getByRole("dialog");
    const input = dialog.getByRole("textbox");
    const runTest = dialog.getByRole("button", { name: /^(Test|Testen)$/u });
    const openTest = async () => {
      await openActions(appId);
      await row("load-rows").getByRole("button").click();
      await expect(dialog).toBeVisible();
    };
    await row("load-rows").getByRole("button", { name: "Test load-rows" }).click();
    await expect(dialog).toContainText("Stock system");
    // The place the call is listed in is a link for this builder, who may open it.
    await expect(
      dialog.getByRole("link", { name: "It is listed under Operations." })
    ).toHaveAttribute("href", "/settings/instance/operations");
    await expect(input).toHaveValue('{\n  "text": ""\n}');
    await shoot(page, "test-idle", openTest);
    await input.fill("{text: 1}");
    await runTest.click();
    await expect(dialog.getByRole("alert")).toHaveText("This is not valid JSON.");
    await input.fill('{"text": 5}');
    await runTest.click();
    await expect(dialog.getByRole("alert")).toHaveText("“text” must be a text.");
    await expect(dialog.locator("[data-app-action-test-status]")).toHaveCount(0);

    // A call of an outside system can take half a minute. While this one is held the dialog
    // says that it waits, and its button takes no second call.
    const outcome = dialog.locator("[data-app-action-test-status]");
    const actionCall = "**/api/v1/app-content-sessions/*/actions/load-rows";
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    await page.route(actionCall, async (route) => {
      await answered;
      // A picture's load left the call of the load before it behind.
      await route.continue().catch(() => undefined);
    });
    const hold = async () => {
      await input.fill('{"text": "Alster Papier"}');
      await runTest.click();
      await expect(outcome).toHaveAttribute("data-app-action-test-status", "running");
    };
    await hold();
    await expect(outcome).toContainText("Waiting for the answer.");
    await expect(dialog.locator('button[aria-busy="true"]')).toBeDisabled();
    await shoot(
      page,
      "test-working",
      async () => {
        await openTest();
        await hold();
      },
      [
        ["light", "en", 1440],
        ["dark", "en", 1440]
      ]
    );
    answer();
    await expect(outcome).toHaveAttribute("data-app-action-test-status", "done");
    await page.unroute(actionCall);
    await expect(outcome).toContainText("Done");
    await expect(outcome.getByRole("region")).toContainText('"text": "Alster Papier"');
    const runLink = outcome.getByRole("link", { name: "Open the run in Operations" });
    const runHref = await runLink.getAttribute("href");
    expect(runHref).toMatch(/^\/settings\/instance\/operations\?run=/u);
    const reachResult = async () => {
      await openTest();
      await input.fill('{"text": "Alster Papier"}');
      await runTest.click();
      await expect(outcome).toHaveAttribute("data-app-action-test-status", "done");
    };
    // In a window 640 high the dialog scrolls what it holds, and its buttons stay in reach.
    await page.setViewportSize({ width: 1440, height: 640 });
    await reachResult();
    await outcome.scrollIntoViewIfNeeded();
    await expect(runTest).toBeInViewport({ ratio: 1 });
    await expect(dialog.getByRole("button", { name: "Close" }).last()).toBeInViewport({ ratio: 1 });
    await page.setViewportSize({ width: 1440, height: 900 });
    await shoot(page, "test-result", reachResult, [
      ...usualLooks,
      ["light", "en", 1440, 640],
      ["dark", "en", 1440, 640]
    ]);

    // A call the instance refuses is shown as what it answered, with its status.
    await page.route(actionCall, (route) =>
      route.fulfill({
        status: 403,
        json: {
          error: {
            code: "FORBIDDEN",
            message: "Forbidden",
            details: {
              action: "connection.use",
              connectionUseDenied: true,
              frame: "app",
              connectionLabel: "Stock system"
            }
          }
        }
      })
    );
    const refuse = async () => {
      await openTest();
      await input.fill('{"text": "Alster Papier"}');
      await runTest.click();
      await expect(outcome).toHaveAttribute("data-app-action-test-status", "denied");
    };
    await refuse();
    await expect(outcome).toContainText("You may not use the connection Stock system");
    await shoot(page, "test-refused", refuse, [...usualLooks, ["dark", "de", 1440]]);
    await page.unroute(actionCall);

    // The link leads to the run in Instance > Operations: origin App, the action, done, the
    // Connection and its operation, and nothing of the input or the result.
    const run = page.getByRole("dialog").locator("[data-operation-run-detail]");
    const openRun = async () => {
      await page.goto(runHref ?? "");
      await expect(run).toBeVisible();
    };
    await openTest();
    await input.fill('{"text": "Alster Papier"}');
    await runTest.click();
    await expect(outcome).toHaveAttribute("data-app-action-test-status", "done");
    await runLink.click();
    await expect(run).toBeVisible();
    await expect(run.locator('[data-field="operation"]')).toContainText(`app.${appId}.load-rows`);
    await expect(run.locator('[data-field="status"]')).toContainText("Done");
    await expect(run.locator('[data-field="origin"]')).toContainText("App");
    await expect(run.locator('[data-field="origin.app"]')).toContainText("Stock desk");
    await expect(run.locator('[data-field="origin.app"]')).toContainText("revision 1");
    await expect(run.locator('[data-field="origin.actionName"]')).toContainText("load-rows");
    await expect(run.locator('[data-field="origin.target"]')).toContainText(connection.name);
    await expect(run.locator('[data-field="origin.target"]')).toContainText("echo");
    await expect(run).not.toContainText("Alster Papier");
    await shoot(page, "operations-run", openRun);

    // The same run in the list, among the reads with the origin App.
    await page.goto("/settings/instance/operations");
    await page.getByLabel("Filter by effect").selectOption({ label: "Reading calls" });
    await page.getByLabel("Filter by origin").selectOption({ label: "App" });
    await page.getByLabel("Operation, exact name").fill(`app.${appId}.load-rows`);
    const listed = page.locator("[data-operation-run-id]").first();
    await expect(listed).toHaveAttribute("data-status", "done");
    await expect(listed.locator("[data-origin-app]")).toContainText(
      "App · Stock desk · revision 1 · load-rows"
    );
    if (shotsDir) {
      for (const theme of ["light", "dark"] as const) {
        await setLook(page, theme, "en");
        await page.reload();
        await page.getByLabel("Filter by effect").selectOption({ label: "Reading calls" });
        await page.getByLabel("Operation, exact name").fill(`app.${appId}.load-rows`);
        await expect(page.locator("[data-origin-app]").first()).toBeVisible();
        await page.screenshot({
          path: join(shotsDir, `operations-list-${theme}-en-1440.png`),
          animations: "disabled"
        });
      }
      await setLook(page, "light", "en");
    }

    // The sides of the draft are views of one App: going away from Actions and back shows
    // the same list, twice over.
    await openActions(appId);
    for (const side of ["Preview", "Files"]) {
      await draft.getByRole("radio", { name: side }).click();
      await expect(actions).toHaveCount(0);
      await draft.getByRole("radio", { name: "Actions" }).click();
      await expect(row("load-rows")).toContainText("Can be tested");
    }

    // Published, the App's Details list its actions with effect and outcome, and an agent's
    // Tools section offers the action an agent can carry: the reading one, since the
    // Connection opens `book` to Apps alone.
    const published = await requestWithOrigin(page, "post", `${appUrl(appId)}/publish`, {
      data: { workspaceId, revision: 1 }
    });
    expect(published.ok(), await published.text()).toBe(true);
    const details = page.getByRole("dialog").locator("[data-app-details-actions]");
    const openDetails = async () => {
      await page.goto(`/w/${workspaceId}/apps/${appId}`);
      await page
        .getByTestId("app-view")
        .getByRole("button", { name: /^(More actions|Weitere Aktionen)$/u })
        .click();
      await page.getByRole("menuitem", { name: "Details" }).click();
      await expect(details).toBeVisible();
    };
    await openDetails();
    await expect(details.locator('[data-app-action="load-rows"]')).toContainText("Reading");
    await expect(details.locator('[data-app-action="load-rows"]')).toContainText("Runs");
    await expect(details.locator('[data-app-action="book-row"]')).toContainText("Changing");
    await shoot(page, "details-actions", openDetails);
    const appTools = page.locator(`#tools [data-app-tools="${appId}"]`);
    const openAgentTools = async () => {
      await page.goto("/build/agents/application_assistant");
      await expect(appTools).toBeVisible();
    };
    await openAgentTools();
    await expect(appTools).toContainText("Stock desk");
    await expect(appTools.getByRole("checkbox")).toHaveCount(1);
    await expect(appTools.getByRole("checkbox", { name: /^load-rows/u })).not.toBeChecked();
    await expect(appTools).toContainText("Reads the rows of the stock system.");
    await shoot(page, "agent-app-tools", async () => {
      await openAgentTools();
      await appTools.scrollIntoViewIfNeeded();
    });

    // A member who may not write the App is shown no draft, so no test, and may not list the
    // actions without the right to read the App.
    const refused = await memberPage.request.get(
      `${apiOrigin}/api/v1/app-actions?app=${encodeURIComponent(appId)}`
    );
    expect(refused.status()).toBe(403);
    await memberPage.goto(draftPath(appId));
    await expect(memberPage.getByTestId("app-edit")).toContainText(
      "The draft of this app is not available to you."
    );
    await expect(memberPage.getByRole("radio")).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: /^Test/u })).toHaveCount(0);

    // The run stays after its App is deleted, and says so with the App's id.
    const deleted = await requestWithOrigin(page, "post", `${appUrl(appId)}/delete`, {
      data: { workspaceId, expectedRevision: 1 }
    });
    expect(deleted.ok(), await deleted.text()).toBe(true);
    await openRun();
    await expect(run.locator('[data-field="origin.app"]')).toContainText(`Deleted app (${appId})`);
    await shoot(page, "operations-run-deleted-app", openRun);
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).first().click();
    await closed(page, page.getByRole("dialog"));
  } finally {
    await memberContext.close();
    await removeConnection(connection.id);
  }
});
