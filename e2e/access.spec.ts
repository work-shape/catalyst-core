import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";

/** From `tests/fixtures/e2e-users/access.yaml`: the person this spec gives rights to. */
const rightsHolder = {
  email: "e2e-access-rights@example.test",
  password: "e2e-access-rights-password"
};

const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

const accessPath = "/settings/instance/access";

const assetPath = `${apiBaseUrl}/api/v1/assets/agent/kai-helper`;

const NARROW = { width: 390, height: 844 };

const WIDE = { width: 1280, height: 800 };

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

function tab(page: Page, name: string): Locator {
  return page.getByRole("tab", { name: new RegExp(`^${name}`, "u") });
}

function checkRow(page: Page, verb: "read" | "write" | "delete"): Locator {
  return page.locator(`[data-testid="check-row"][data-verb="${verb}"]`);
}

async function pick(page: Page, trigger: Locator, option: string | RegExp): Promise<void> {
  await trigger.click();
  await page.getByRole("option", { name: option }).click();
  // The list is gone before the next step, as it is for a person: a press on a checkbox while
  // the list still fades out is a press outside it.
  await expect(page.getByRole("listbox")).toHaveCount(0);
}

/** Asks the Check tab what the rights holder may do with one agent, picked by its listed title. */
async function check(page: Page, assetName: string): Promise<void> {
  await tab(page, "Check").click();
  const person = page.getByRole("button", { name: /^Person: / });
  if ((await person.getAttribute("aria-label")) !== "Person: E2E Zz Access Rights") {
    await pick(page, person, /E2E Zz Access Rights/u);
  }
  const asset = page.getByRole("button", { name: /^Asset: / });
  if ((await asset.getAttribute("aria-label")) !== `Asset: ${assetName}`) {
    await pick(page, asset, assetName);
  }
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

test("an administrator grants by level, checks, denies and revokes rights", async ({
  page,
  // The test stores an agent of the instance; the turn on the agents holds the one on the
  // grants.
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(90_000);
  // A seeded user is listed once the user has signed in and made a first call.
  await signInViaApi(page, rightsHolder);
  expect((await page.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  await signInViaApi(page, adminUser);
  const workspaceName = "Access rights scope";
  const workspace = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: workspaceName }
  });
  expect(workspace.ok()).toBe(true);
  const rightsWorkspace: { id: string } = await workspace.json();
  await page.setViewportSize(WIDE);
  await page.goto("/settings/instance/users");
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Access", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`${accessPath}$`, "u"));
  // The page opens on Rights, its first tab.
  await expect(tab(page, "Rights")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("No right given yet.")).toBeVisible();

  // An agent of the instance, for the lists and the deny further down.
  const created = await requestWithOrigin(page, "put", assetPath, {
    data: {
      expectedRevision: await assetBaseRevision(page, assetPath),
      config: {
        name: "kai-helper",
        displayName: "Kai Helper",
        modelProviderId: "local",
        instructions: "You help Kai.",
        toolNames: []
      }
    }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const grantDialog = page.getByRole("dialog", { name: "New right" });
  const grantRows = page.getByTestId("grant-row");
  const workspaceGrants = grantRows.filter({ hasText: `in ${workspaceName}` });
  try {
    await page.reload();

    // The page head links to how rights work, and the check to how one right is decided.
    const rightsDocs = "https://docs.workshape.ai/catalyst/operate/how-rights-work/";
    const headLink = page.getByRole("link", { name: "How rights work, opens in a new tab" });
    await expect(headLink).toHaveAttribute("href", `${rightsDocs}#the-short-version`);
    await expect(headLink).toHaveAttribute("target", "_blank");
    await tab(page, "Check").click();
    await expect(
      page.getByRole("link", {
        name: "Learn more about how a right is decided, opens in a new tab"
      })
    ).toHaveAttribute("href", `${rightsDocs}#do-you-hold-the-right-here`);

    // Grant the rights holder viewing kai-helper. An agent right is given in a shared workspace,
    // which the dialog starts in (WS-OWN-1a), or on one agent. The right is one level of the kind,
    // not a box per action.
    await tab(page, "Rights").click();
    await expect(page.getByText("No right given yet.")).toBeVisible();
    await page.getByRole("button", { name: "New right" }).click();
    await pick(
      page,
      grantDialog.getByRole("button", { name: /^Person: / }),
      /E2E Zz Access Rights/u
    );
    const inWorkspace = grantDialog.getByRole("radio", { name: /^In a shared workspace/u });
    const onAsset = grantDialog.getByRole("radio", { name: /^On one asset/u });
    await expect(inWorkspace).toBeChecked();
    // The levels are radios, not a box per action. The one box is Approve, a right beside the
    // levels that decides a held publish of a workspace's agent (WS-PUB-1b).
    await expect(grantDialog.getByRole("checkbox")).toHaveCount(1);
    await expect(grantDialog.getByRole("checkbox", { name: /^Approve/u })).not.toBeChecked();
    const level = (name: string) => grantDialog.getByRole("radio", { name, exact: true });
    // Use is the agents' lowest level (AGENT-USE-1).
    for (const name of ["Use", "View", "Edit", "Publish", "Delete"]) {
      await expect(level(name)).toBeVisible();
    }
    await expect(level("Edit")).toHaveAccessibleDescription("Includes use and view.");
    await onAsset.check();
    await level("View").check();
    await pick(page, grantDialog.getByRole("button", { name: /^Asset: / }), "kai-helper");
    await grantDialog.getByRole("button", { name: "Create right" }).click();
    await expect(grantDialog).toBeHidden();
    const assetGrants = grantRows.filter({ hasText: "the agent Kai Helper" });
    await expect(grantRows).toHaveCount(1);
    await expect(assetGrants).toContainText("E2E Zz Access Rights");
    await expect(assetGrants).toContainText("may view and use the agent Kai Helper");
    await expect(assetGrants).toContainText("E2E Admin");

    // A higher level adds the rows below it that are missing and says what it left alone.
    await page.getByRole("button", { name: "New right" }).click();
    await pick(
      page,
      grantDialog.getByRole("button", { name: /^Person: / }),
      /E2E Zz Access Rights/u
    );
    await level("Edit").check();
    await onAsset.check();
    await pick(page, grantDialog.getByRole("button", { name: /^Asset: / }), "kai-helper");
    await grantDialog.getByRole("button", { name: "Create right" }).click();
    await expect(grantDialog).toBeHidden();
    await expect(page.getByText("1 added. 2 already there and left as they are.")).toBeVisible();
    await expect(grantRows).toHaveCount(1);
    await expect(assetGrants).toContainText("may view, use, and edit the agent Kai Helper");

    // Rights in the shared workspace, which cover what it owns and not the instance's agents.
    await page.getByRole("button", { name: "New right" }).click();
    await pick(
      page,
      grantDialog.getByRole("button", { name: /^Person: / }),
      /E2E Zz Access Rights/u
    );
    await level("Delete").check();
    await pick(page, grantDialog.getByRole("button", { name: /^Workspace/u }), workspaceName);
    await grantDialog.getByRole("button", { name: "Create right" }).click();
    await expect(grantDialog).toBeHidden();
    await expect(grantRows).toHaveCount(2);
    await expect(workspaceGrants).toContainText("E2E Zz Access Rights");
    await expect(workspaceGrants).toContainText(
      `may view, use, edit, publish, and delete agents in ${workspaceName}`
    );

    // The rights on kai-helper allow what they name, the workspace's do not reach the agent of
    // the instance, and nothing allows another agent. The person and the asset are picked by
    // name; nothing is typed. The result says that it answers for the right alone, and that a
    // read through a grant opens no overview.
    await tab(page, "Check").click();
    await expect(page.getByRole("tabpanel", { name: "Check" }).getByRole("textbox")).toHaveCount(0);
    await check(page, "Kai Helper");
    await expect(checkRow(page, "write")).toContainText("Allowed");
    await expect(checkRow(page, "write")).toContainText("Right on this asset");
    await expect(checkRow(page, "delete")).toContainText("Refused");
    await expect(checkRow(page, "delete")).toContainText("No right");
    await expect(page.getByTestId("check-right-only")).toContainText("This is the right alone.");
    await expect(page.getByText("Viewing is allowed through a given right")).toBeVisible();
    await check(page, "Research Assistant");
    await expect(checkRow(page, "write")).toContainText("Refused");
    await expect(checkRow(page, "write")).toContainText("No right");
    await expect(page.getByTestId("check-right-only")).toHaveCount(0);
    // What a role decides names the role, as the Users page names it.
    await pick(page, page.getByRole("button", { name: /^Person: / }), /E2E Admin/u);
    await expect(checkRow(page, "write")).toContainText(
      "The person's role, Admin, allows this everywhere."
    );

    // A row's menu revokes one action of its sentence.
    await tab(page, "Rights").click();
    await assetGrants.getByRole("button", { name: /^Actions for the right of/u }).click();
    await page.getByRole("menuitem", { name: "Revoke: Edit agents" }).click();
    const revokeEdit = page.getByRole("dialog", { name: "Revoke this right?" });
    await revokeEdit.getByRole("button", { name: "Revoke" }).click();
    await expect(revokeEdit).toHaveCount(0);
    await expect(assetGrants).toContainText("may view and use the agent Kai Helper");
    await expect(page.locator("[data-radix-focus-guard]")).toHaveCount(0);

    // A deny on the one agent refuses the action there. It joins the row of the person's rights
    // on that agent, as a sentence of its own.
    await page.getByRole("button", { name: "New right" }).click();
    await pick(
      page,
      grantDialog.getByRole("button", { name: /^Person: / }),
      /E2E Zz Access Rights/u
    );
    await level("Delete").check();
    await onAsset.check();
    await pick(page, grantDialog.getByRole("button", { name: /^Asset: / }), "kai-helper");
    // A deny is the exception: it waits behind its own control.
    const refuse = grantDialog.getByRole("checkbox", { name: /^Refuse this level/u });
    await expect(refuse).toHaveCount(0);
    await grantDialog.getByRole("button", { name: "Refuse instead" }).click();
    await refuse.check();
    await expect(level("Edit")).toHaveAccessibleDescription("Also refuses publish and delete.");
    await expect(
      grantDialog.getByText("Refuses the chosen level and every one above it here")
    ).toBeVisible();
    // The dialog leads into the documentation at the place it asks for and after the deny.
    const rightsPage = "https://docs.workshape.ai/catalyst/operate/how-rights-work/";
    await expect(grantDialog.locator("a[data-docs-link]")).toHaveCount(2);
    const denyLink = grantDialog.getByRole("link", {
      name: "Learn more about how a deny is decided, opens in a new tab"
    });
    await expect(denyLink).toHaveText("Learn more");
    await expect(denyLink).toHaveAttribute("href", `${rightsPage}#do-you-hold-the-right-here`);
    await expect(denyLink).toHaveAttribute("target", "_blank");
    await expect(denyLink).toHaveAttribute("rel", "noopener noreferrer");
    await grantDialog.getByRole("button", { name: "Create right" }).click();
    await expect(grantDialog).toBeHidden();
    await expect(grantRows).toHaveCount(2);
    await expect(grantRows.locator('[data-effect="deny"]')).toHaveText(
      "Deniedmay not delete the agent Kai Helper"
    );

    await check(page, "Kai Helper");
    await expect(checkRow(page, "delete")).toContainText("Refused");
    await expect(checkRow(page, "delete")).toContainText("Deny on this asset");
    await expect(checkRow(page, "read")).toContainText("Allowed");
    await expect(page.getByText("does not take away instance-wide rights")).toBeVisible();

    // At 390 wide the page keeps inside the window, on the result and on the grant list,
    // and nothing in the list scrolls sideways: a row stacks and keeps its menu in reach.
    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await page.setViewportSize(NARROW);
    await checkRow(page, "write").scrollIntoViewIfNeeded();
    await expect(checkRow(page, "write")).toBeInViewport();
    await expectNoSidewaysScroll(page);
    await tab(page, "Rights").click();
    await expect(grantRows).toHaveCount(2);
    await expectNoSidewaysScroll(page);
    for (const row of await grantRows.all()) {
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      );
      await expect(row.getByRole("button", { name: /^Actions for the right of/u })).toBeInViewport({
        ratio: 1
      });
    }
    await page.setViewportSize(WIDE);
    await page.getByRole("button", { name: "Expand sidebar" }).click();

    // The rights in the workspace are revoked one by one; each takes one verb out of the row's
    // sentence, and the last one the row.
    for (const [action, left] of [
      ["Use agents", `may view, edit, publish, and delete agents in ${workspaceName}`],
      ["View agents", `may edit, publish, and delete agents in ${workspaceName}`],
      ["Edit agents", `may publish and delete agents in ${workspaceName}`],
      ["Publish agents", `may delete agents in ${workspaceName}`],
      ["Delete agents", undefined]
    ] as const) {
      // The menu of the last round has left the page before the row's menu is opened again: a
      // click that lands while it is still leaving only finishes its closing.
      await expect(page.locator("[data-radix-focus-guard]")).toHaveCount(0);
      await workspaceGrants.getByRole("button", { name: /^Actions for the right of/u }).click();
      await page.getByRole("menuitem", { name: `Revoke: ${action}` }).click();
      const revokeDialog = page.getByRole("dialog", { name: "Revoke this right?" });
      await revokeDialog.getByRole("button", { name: "Revoke" }).click();
      // The dialog is gone, not only faded: it hands the focus back when it leaves.
      await expect(revokeDialog).toHaveCount(0);
      if (left === undefined) {
        await expect(workspaceGrants).toHaveCount(0);
      } else {
        await expect(workspaceGrants).toContainText(left);
      }
    }
    await expect(grantRows).toHaveCount(1);
  } finally {
    await requestWithOrigin(
      page,
      "delete",
      `${apiBaseUrl}/api/v1/workspaces/${rightsWorkspace.id}`
    );
    const deleted = await requestWithOrigin(page, "post", `${assetPath}/delete`, {
      data: { expectedRevision: await assetRevision(page, assetPath) }
    });
    expect(deleted.ok()).toBe(true);
  }

  // The deny outlives its asset: the list says so in text and still removes it.
  await page.reload();
  await tab(page, "Rights").click();
  const orphanedDeny = grantRows.filter({ hasText: "Asset no longer exists" });
  await expect(orphanedDeny).toContainText("may not delete the agent kai-helper");
  await expect(orphanedDeny).toContainText("This deny stays until you remove it.");
  await orphanedDeny.getByRole("button", { name: /^Actions for the right of/u }).click();
  await page.getByRole("menuitem", { name: "Remove deny: Delete agents" }).click();
  await page
    .getByRole("dialog", { name: "Remove this deny?" })
    .getByRole("button", { name: "Remove deny" })
    .click();
  await expect(orphanedDeny).toHaveCount(0);
  await expect(page.getByText("No right given yet.")).toBeVisible();
});

test("the roles of the instance: built-in first, superadmin read-only, a custom role from copy to delete", async ({
  page,
  browser,
  baseURL,
  // The test gives E2E Admin a right and writes a role: the turn on the grants.
  accessState: _accessState
}) => {
  test.setTimeout(90_000);
  const superadminUser = {
    email: "e2e-superadmin@example.test",
    password: "e2e-superadmin-password"
  };
  const rootContext = await browser.newContext({ baseURL });
  const root = await rootContext.newPage();
  await signInViaApi(root, superadminUser);
  await signInViaApi(page, adminUser);
  const me = await page.request.get(`${apiBaseUrl}/api/v1/me`);
  expect(me.ok()).toBe(true);
  const { id: adminId }: { id: string } = await me.json();
  const roleName = `E2E reviewers ${Date.now()}`;
  const renamed = `${roleName} renamed`;
  const grants: string[] = [];
  const rolesPath = `${apiBaseUrl}/api/v1/instance/access/roles`;
  const rows = page.getByTestId("role-row");
  const rolePage = page.getByTestId("role-page");
  try {
    await page.setViewportSize(WIDE);
    await page.goto(accessPath);
    await tab(page, "Roles").click();

    // User, Admin and Superadmin come first, in that order.
    await expect(rows.first()).toBeVisible();
    expect(
      (
        await rows.evaluateAll((items) => items.map((item) => item.getAttribute("data-role")))
      ).slice(0, 3)
    ).toEqual(["user", "admin", "superadmin"]);

    // Superadmin is read-only, its rights shown by area.
    await rows.filter({ hasText: "Superadmin" }).getByRole("button").first().click();
    await expect(rolePage).toHaveAttribute("data-role", "superadmin");
    await expect(rolePage.getByText("Read-only")).toBeVisible();
    await expect(rolePage.getByRole("button", { name: /^Edit the rights for/u })).toHaveCount(0);
    await expect(rolePage.getByRole("button", { name: "Reset to default" })).toHaveCount(0);
    await expect(
      rolePage.locator('[data-area="roles"]').getByText(/Edit the built-in roles/u)
    ).toBeVisible();
    await page.getByRole("button", { name: "All roles" }).click();

    // An admin without the right views User and does not change it.
    await rows.filter({ hasText: /^User/u }).getByRole("button").first().click();
    await expect(rolePage).toHaveAttribute("data-role", "user");
    await expect(
      page.getByText(
        "You can view this role. Changing it needs the right “Edit the built-in roles User and Admin”."
      )
    ).toBeVisible();
    await expect(rolePage.getByRole("button", { name: "Reset to default" })).toHaveCount(0);
    await page.getByRole("button", { name: "All roles" }).click();

    // A new role copies the rights of another, then opens.
    await page.getByRole("button", { name: "New role" }).click();
    const create = page.getByRole("dialog", { name: "New role" });
    await create.getByLabel("Copy the rights of").selectOption({ label: "User" });
    await create.getByLabel("Name").fill(roleName);
    await create.getByRole("button", { name: "Create role" }).click();
    await expect(create).toHaveCount(0);
    await expect(rolePage.getByRole("heading", { name: roleName })).toBeVisible();

    // Its rights are edited by area: a right the admin holds is given, a superadmin's is not.
    const administration = rolePage.locator('[data-area="administration"]');
    await expect(administration).toContainText("No right in this area.");
    await rolePage.getByRole("button", { name: "Edit the rights for Administration" }).click();
    const area = page.getByRole("dialog", {
      name: `Administration in ${roleName}`
    });
    await expect(area.getByRole("checkbox", { name: /^Manage API access/u })).toBeDisabled();
    await area.getByRole("checkbox", { name: /^View usage/u }).check();
    await area.getByRole("button", { name: "Save rights" }).click();
    await expect(area).toHaveCount(0);
    await expect(administration).not.toContainText("No right in this area.");

    // Renamed and deleted from its menu.
    await rolePage.getByRole("button", { name: `Actions for ${roleName}` }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    const rename = page.getByRole("dialog", { name: `Rename ${roleName}` });
    await rename.getByLabel("Name").fill(renamed);
    await rename.getByRole("button", { name: "Save" }).click();
    await expect(rename).toHaveCount(0);
    await expect(rolePage.getByRole("heading", { name: renamed })).toBeVisible();
    await rolePage.getByRole("button", { name: `Actions for ${renamed}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const remove = page.getByRole("dialog", { name: `Delete ${renamed}?` });
    await remove.getByRole("button", { name: "Delete" }).click();
    await expect(rolePage).toHaveCount(0);
    await expect(rows.filter({ hasText: renamed })).toHaveCount(0);

    // Given the right to edit the built-in roles, the admin edits User and may reset it.
    const granted = await requestWithOrigin(
      root,
      "post",
      `${apiBaseUrl}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: adminId,
          action: "roles.edit_built_in",
          effect: "allow",
          scopeKind: "instance"
        }
      }
    );
    expect(granted.ok(), await granted.text()).toBe(true);
    const grant: { id: string } = await granted.json();
    grants.push(grant.id);
    await page.reload();
    await tab(page, "Roles").click();
    await rows.filter({ hasText: /^User/u }).getByRole("button").first().click();
    await expect(rolePage).toHaveAttribute("data-role", "user");
    await expect(
      page.getByText("A change applies at once to everybody who holds this role.")
    ).toBeVisible();
    await expect(rolePage.getByRole("button", { name: "Reset to default" })).toBeVisible();
    await expect(
      rolePage.getByRole("button", { name: "Edit the rights for Administration" })
    ).toBeVisible();

    // In German, at 1280 wide: the list and the page of Admin.
    await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
    await page.reload();
    await tab(page, "Rollen").click();
    await expect(rows.first()).toBeVisible();
    await expectNoSidewaysScroll(page);
    const shotsDir = process.env.E2E_SHOTS_DIR;
    if (shotsDir) await mkdir(shotsDir, { recursive: true });
    if (shotsDir)
      await page.screenshot({
        path: join(shotsDir, "roles-list-de-1280.png"),
        animations: "disabled"
      });
    await rows
      .filter({ hasText: /^Admin/u })
      .getByRole("button")
      .first()
      .click();
    await expect(rolePage).toHaveAttribute("data-role", "admin");
    await expect(rolePage.getByRole("button", { name: "Auf Standard zurücksetzen" })).toBeVisible();
    await expectNoSidewaysScroll(page);
    if (shotsDir)
      await page.screenshot({
        path: join(shotsDir, "role-admin-de-1280.png"),
        animations: "disabled",
        fullPage: true
      });
  } finally {
    for (const grantId of grants) {
      await requestWithOrigin(
        root,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grantId}`
      );
    }
    const listed = await root.request.get(rolesPath);
    if (listed.ok()) {
      const { items }: { items: { id: string; name: string }[] } = await listed.json();
      for (const role of items.filter((item) => item.name.startsWith(roleName))) {
        await requestWithOrigin(root, "delete", `${rolesPath}/${role.id}`);
      }
    }
    await rootContext.close();
  }
});
