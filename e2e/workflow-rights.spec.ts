import { randomUUID } from "node:crypto";
import { type Browser, type Locator, type Page } from "@playwright/test";
import { expect, test, type PageErrorWatch } from "./test";
import { requestWithOrigin } from "./request-with-origin";

// Instance > Access gives a person a right on one Workflow: an admin gives a member reading,
// then using, then removes both, and after each step the member is asked what the instance
// lets them do with the Workflow. The Workflow is one of this spec's own, published by the
// superadmin as the release would publish it.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
/** The member the rights are given to. No other spec uses this member. */
const member = {
  email: "e2e-workflow-rights@example.test",
  password: "e2e-workflow-rights-password",
  label: "E2E Zz Workflow Rights"
};
const accessPath = "/settings/instance/access";
const WIDE = { width: 1440, height: 900 };
const NARROW = { width: 390, height: 844 };

const USE_SENTENCE =
  "Start the Workflow. It then runs with the Workflow's own rights, not with this person's, so it can read and change what the person cannot.";
const PUBLISH_NOTE =
  "Publishing also needs every right of the service principal the Workflow runs as.";

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** A page of its own session, watched for page errors like the test's own. */
async function sessionOf(
  browser: Browser,
  watch: PageErrorWatch["watch"],
  user: { email: string; password: string }
): Promise<Page> {
  const context = await browser.newContext();
  await watch(context);
  const page = await context.newPage();
  await signIn(page, user);
  return page;
}

/** Stores and publishes a Workflow that starts by hand and returns a number. */
async function publishWorkflow(
  root: Page,
  id: string,
  runAs: string,
  name = "Rights walk"
): Promise<void> {
  const principal = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
  const saved = await requestWithOrigin(root, "put", assetUrl, {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        manifest: {
          id,
          name,
          description: "A Workflow a spec gives rights on.",
          runAs,
          inputs: { type: "object", additionalProperties: false },
          outputs: {
            type: "object",
            properties: { done: { type: "integer" } },
            required: ["done"]
          },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
          ]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const stored: { revision: number } = await (await root.request.get(assetUrl)).json();
  const published = await requestWithOrigin(root, "post", `${assetUrl}/publish`, {
    data: { revision: stored.revision }
  });
  expect(published.ok(), await published.text()).toBe(true);
}

/** What the instance lets the member do with the Workflow: nothing where it is not listed. */
async function memberActions(memberPage: Page, id: string): Promise<string[] | undefined> {
  const response = await memberPage.request.get(`${apiBaseUrl}/api/v1/workflows`);
  if (!response.ok()) {
    return undefined;
  }
  const body: { items: { id: string; actions: string[] }[] } = await response.json();
  return body.items.find((item) => item.id === id)?.actions.sort();
}

async function start(memberPage: Page, id: string): Promise<number> {
  const response = await requestWithOrigin(
    memberPage,
    "post",
    `${apiBaseUrl}/api/v1/workflows/${id}/runs`,
    { data: {} }
  );
  return response.status();
}

async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option }).click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** Opens the dialog and names the member and the Workflow in it. The rights are still to tick. */
async function openDialogFor(page: Page, id: string): Promise<Locator> {
  await page.getByRole("button", { name: "New right" }).click();
  const dialog = page.getByRole("dialog", { name: "New right" });
  await pick(page, dialog.getByRole("button", { name: /^Person: / }), member.label);
  await dialog.getByRole("radio", { name: "Workflows" }).click();
  // The picker names the Workflow by its name, with what it says of itself under it.
  await dialog.getByRole("button", { name: /^Workflow: / }).click();
  // Named by its id as well: a retry finds the Workflow of the first attempt in the list too.
  const option = page.getByRole("option", { name: new RegExp(`Rights walk ${id}`, "u") });
  await expect(option).toContainText("A Workflow a spec gives rights on.");
  await option.click();
  await expect(page.getByRole("listbox")).toHaveCount(0);
  return dialog;
}

test("an admin gives a member reading and using on one Workflow and removes both", async ({
  page,
  browser,
  pageErrors,
  accessState: _accessState
}) => {
  test.setTimeout(120_000);
  const id = `rights-walk-${randomUUID().slice(0, 8)}`;
  const root = await sessionOf(browser, pageErrors.watch, superadmin);
  await publishWorkflow(root, id, `${id}-runner`);
  // A seeded user is listed once the user has signed in.
  const memberPage = await sessionOf(browser, pageErrors.watch, member);
  expect((await memberPage.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  expect(await memberActions(memberPage, id)).toBeUndefined();

  await signIn(page, admin);
  await page.setViewportSize(WIDE);
  await page.goto(accessPath);
  await page.getByRole("tab", { name: /^Rights/u }).click();
  const row = page.getByTestId("grant-row").filter({ hasText: "Workflow Rights walk" });
  const dialog = page.getByRole("dialog", { name: "New right" });
  try {
    // The dialog says each right of a Workflow in a sentence, and what publishing still needs.
    await openDialogFor(page, id);
    // Reading, using, writing, publishing and deleting as levels, and reading run data on its
    // own (RIGHTS-1c, RIGHTS-DIALOG-1).
    await expect(
      dialog.getByRole("radiogroup", { name: "Level", exact: true }).getByRole("radio")
    ).toHaveCount(5);
    await expect(dialog.getByRole("checkbox")).toHaveCount(1);
    await expect(dialog.getByText("See the Workflow, its steps and its runs.")).toBeVisible();
    await expect(dialog.getByText(USE_SENTENCE)).toBeVisible();
    await expect(dialog.getByText(PUBLISH_NOTE, { exact: false })).toBeVisible();
    // A deny of publishing holds as any deny does, so the note is for an allow only.
    await dialog.getByRole("button", { name: "Refuse instead" }).click();
    const refuse = dialog.getByRole("checkbox", { name: /^Refuse this level/u });
    await refuse.check();
    await expect(dialog.getByText(PUBLISH_NOTE, { exact: false })).toHaveCount(0);
    await refuse.uncheck();
    // A Workflow belongs to no workspace, so one Workflow is its one place and no place is
    // asked for.
    await expect(dialog.getByRole("radiogroup", { name: "Where" })).toBeVisible();
    await dialog.getByRole("radio", { name: /^On one Workflow/u }).check();

    // Viewing, the lowest level: the member sees the Workflow and its runs but cannot start it,
    // because a run acts with the Workflow's own rights.
    await dialog.getByRole("radio", { name: "View", exact: true }).check();
    await dialog.getByRole("button", { name: "Create right" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toContainText(member.label);
    await expect(row).toContainText("may view the Workflow Rights walk");
    await expect.poll(() => memberActions(memberPage, id)).toEqual(["workflow.read"]);
    expect(await start(memberPage, id)).toBeGreaterThanOrEqual(400);

    // The level Use brings View with it: the row says both, and the member may start it.
    await openDialogFor(page, id);
    await dialog.getByRole("radio", { name: "Use", exact: true }).check();
    await dialog.getByRole("button", { name: "Create right" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText("1 added. 1 already there and left as they are.")).toBeVisible();
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("may view and use the Workflow Rights walk");
    await expect
      .poll(() => memberActions(memberPage, id))
      .toEqual(["workflow.read", "workflow.use"]);
    expect(await start(memberPage, id)).toBeLessThan(300);

    // The dialog at 390 wide, and in German.
    await page.setViewportSize(NARROW);
    await openDialogFor(page, id);
    await expect(dialog.getByText(USE_SENTENCE)).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
      )
    ).toBe(true);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await page.setViewportSize(WIDE);
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    await page.reload();
    await page.getByRole("tab", { name: /^Rechte/u }).click();
    await expect(row).toContainText("darf den Workflow Rights walk ansehen und verwenden");
    await page.getByRole("button", { name: "Neues Recht" }).click();
    const german = page.getByRole("dialog", { name: "Neues Recht" });
    await german.getByRole("radio", { name: "Workflows" }).click();
    await expect(german.getByRole("radio", { name: "Veröffentlichen", exact: true })).toBeVisible();
    await expect(
      german.getByText("Er läuft dann mit den eigenen Rechten des Workflows", { exact: false })
    ).toBeVisible();
    await german.getByRole("button", { name: "Abbrechen" }).click();
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "en"));
    await page.reload();
    await page.getByRole("tab", { name: /^Rights/u }).click();

    // Both removed from the row's menu: the Workflow is gone for the member.
    for (const [right, left] of [
      ["View workflows", "may use the Workflow Rights walk"],
      ["Use workflows", undefined]
    ] as const) {
      await row.getByRole("button", { name: `Actions for the right of ${member.label}` }).click();
      await page.getByRole("menuitem", { name: `Revoke: ${right}` }).click();
      const confirm = page.getByRole("dialog", { name: "Revoke this right?" });
      await expect(confirm).toContainText("Workflow Rights walk");
      await confirm.getByRole("button", { name: "Revoke" }).click();
      await expect(confirm).toBeHidden();
      await expect(page.locator("[data-radix-focus-guard]")).toHaveCount(0);
      if (left !== undefined) {
        await expect(row).toContainText(left);
      }
    }
    await expect(row).toHaveCount(0);
    await expect.poll(() => memberActions(memberPage, id)).toBeUndefined();
    expect(await start(memberPage, id)).toBeGreaterThanOrEqual(400);
  } finally {
    // Whatever the test left: the member's rows on the Workflow, read as the admin.
    const listed = await page.request.get(
      `${apiBaseUrl}/api/v1/instance/access/grants?holderKind=user&limit=100`
    );
    const rows: { items: { id: string; scopeAsset?: { name?: string } }[] } = listed.ok()
      ? await listed.json()
      : { items: [] };
    for (const grant of rows.items.filter((item) => item.scopeAsset?.name === id)) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grant.id}`
      );
    }
    await memberPage.context().close();
    await root.context().close();
  }
});

/** The person's own workspace, which the instance makes when the person first opens it. */
async function personalWorkspaceId(memberPage: Page): Promise<string> {
  await memberPage.goto("/");
  let id = "";
  await expect
    .poll(async () => {
      const body: { items: { id: string; kind: string }[] } = await (
        await memberPage.request.get(`${apiBaseUrl}/api/v1/workspaces?limit=100`)
      ).json();
      id = body.items.find((workspace) => workspace.kind === "personal")?.id ?? "";
      return id;
    })
    .not.toBe("");
  return id;
}

test("a write on one Workflow offers that one's draft, and no runs, start or sibling", async ({
  page,
  browser,
  pageErrors,
  accessState: _accessState
}) => {
  test.setTimeout(120_000);
  const suffix = randomUUID().slice(0, 8);
  const granted = { id: `rights-granted-${suffix}`, name: `Rights granted ${suffix}` };
  const sibling = { id: `rights-sibling-${suffix}`, name: `Rights sibling ${suffix}` };
  const root = await sessionOf(browser, pageErrors.watch, superadmin);
  for (const workflow of [granted, sibling]) {
    await publishWorkflow(root, workflow.id, `${workflow.id}-runner`, workflow.name);
  }
  const memberPage = await sessionOf(browser, pageErrors.watch, member);
  const me: { id: string } = await (await memberPage.request.get(`${apiBaseUrl}/api/v1/me`)).json();
  const asset: { id: string } = await (
    await root.request.get(`${apiBaseUrl}/api/v1/assets/workflow/${granted.id}`)
  ).json();
  await signIn(page, admin);
  const grants: string[] = [];
  try {
    const given = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: me.id,
          action: "workflow.write",
          effect: "allow",
          scopeKind: "asset",
          scopeId: asset.id
        }
      }
    );
    expect(given.ok(), await given.text()).toBe(true);
    const grant: { id: string } = await given.json();
    grants.push(grant.id);
    // Writing reads no run and starts nothing: the engine lists the Workflow to neither.
    expect(await memberActions(memberPage, granted.id)).toBeUndefined();

    const personalId = await personalWorkspaceId(memberPage);
    await memberPage.goto(`/w/${personalId}/workflows`);
    const area = memberPage.getByTestId("workflows-area");
    await expect(area.getByRole("link", { name: `Open ${granted.name}` })).toBeVisible();
    await expect(area.getByRole("link", { name: `Open ${sibling.name}` })).toHaveCount(0);
    await expect(area.getByRole("button", { name: /Start now/u })).toHaveCount(0);
    await expect(area.getByRole("link", { name: "Runs", exact: true })).toHaveCount(0);

    await area.getByRole("link", { name: `Open ${granted.name}` }).click();
    await expect(
      memberPage.getByRole("button", { name: "Edit with the agent", exact: true })
    ).toBeVisible();
    const opened = memberPage.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.origin === new URL(apiBaseUrl).origin &&
        url.pathname === "/api/v1/conversations" &&
        response.request().method() === "POST"
      );
    });
    await memberPage.getByRole("button", { name: "Edit with the agent", exact: true }).click();
    const conversation = await opened;
    expect(conversation.ok()).toBe(true);
    expect(await conversation.json()).toMatchObject({
      subject: { kind: "workflow", name: granted.id }
    });
    // The page leads to no runs the member may not read, and holds no Delete.
    await expect(memberPage.getByRole("link", { name: "Runs", exact: true })).toHaveCount(0);
    await expect(memberPage.getByRole("button", { name: /Delete/u })).toHaveCount(0);

    // The runs' own address says they are not the member's, and asks the instance for none.
    const refused: string[] = [];
    memberPage.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === new URL(apiBaseUrl).origin &&
        url.pathname === `/api/v1/workflows/${granted.id}/runs`
      )
        refused.push(request.url());
    });
    await memberPage.goto(`/w/${personalId}/workflows/${granted.id}/runs`);
    await expect(
      memberPage.getByText("The runs of this workflow are not available to you.")
    ).toBeVisible();
    expect(refused).toEqual([]);
  } finally {
    for (const grantId of grants) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grantId}`
      );
    }
    await memberPage.context().close();
    await root.context().close();
  }
});
