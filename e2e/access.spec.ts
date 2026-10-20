import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./test";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const normalUser = { email: "e2e-user@example.test", password: "e2e-user-password" };
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

/** Asks the Check tab what E2E User may do with one agent name. */
async function check(page: Page, assetName: string): Promise<void> {
  await tab(page, "Check").click();
  const person = page.getByRole("button", { name: /^Person: / });
  if ((await person.getAttribute("aria-label")) !== "Person: E2E User") {
    await pick(page, person, /E2E User/u);
  }
  await page.getByLabel("Asset name").fill(assetName);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

test("an administrator grants, checks, denies and revokes rights", async ({
  page,
  // The test stores an agent of the instance; the turn on the agents holds the one on the
  // grants.
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(90_000);
  // A seeded user is listed once the user has signed in and made a first call.
  await signInViaApi(page, normalUser);
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
  // The page opens on the rights.
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
  const workspaceGrants = grantRows.filter({ hasText: `Workspace ${workspaceName}` });
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

    // Grant E2E User viewing kai-helper. An agent right is given in a shared workspace, which
    // the dialog starts in (WS-OWN-1a), or on one agent.
    await tab(page, "Rights").click();
    await expect(page.getByText("No right given yet.")).toBeVisible();
    await page.getByRole("button", { name: "New right" }).click();
    await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    const inWorkspace = grantDialog.getByRole("radio", { name: /^In a shared workspace/u });
    const onAsset = grantDialog.getByRole("radio", { name: /^On one asset/u });
    await expect(inWorkspace).toBeChecked();
    await onAsset.check();
    await grantDialog.getByLabel("View").check();
    await pick(page, grantDialog.getByRole("button", { name: /^Asset: / }), "kai-helper");
    await grantDialog.getByRole("button", { name: "Create right" }).click();
    await expect(grantDialog).toBeHidden();
    const assetGrants = grantRows.filter({ hasText: "Agent Kai Helper" });
    await expect(grantRows).toHaveCount(1);
    await expect(assetGrants).toContainText("E2E User");
    await expect(assetGrants).toContainText("View agents");
    await expect(assetGrants).toContainText("E2E Admin");

    // The same form with one more action adds the missing row and says what it left alone.
    await page.getByRole("button", { name: "New right" }).click();
    await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    for (const verb of ["View", "Edit"]) {
      await grantDialog.getByLabel(verb).check();
    }
    await onAsset.check();
    await pick(page, grantDialog.getByRole("button", { name: /^Asset: / }), "kai-helper");
    await grantDialog.getByRole("button", { name: "Create right" }).click();
    await expect(grantDialog).toBeHidden();
    await expect(page.getByText("1 added. 1 already there and left as they are.")).toBeVisible();
    await expect(grantRows).toHaveCount(1);
    await expect(assetGrants.locator('[data-effect="allow"]')).toHaveCount(2);

    // Rights in the shared workspace, which cover what it owns and not the instance's agents.
    await page.getByRole("button", { name: "New right" }).click();
    await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    for (const verb of ["View", "Edit", "Delete"]) {
      await grantDialog.getByLabel(verb).check();
    }
    await pick(page, grantDialog.getByRole("button", { name: /^Workspace/u }), workspaceName);
    await grantDialog.getByRole("button", { name: "Create right" }).click();
    await expect(grantDialog).toBeHidden();
    await expect(grantRows).toHaveCount(2);
    await expect(workspaceGrants).toContainText("E2E User");
    await expect(workspaceGrants.locator('[data-effect="allow"]')).toHaveCount(3);

    // The rights on kai-helper allow what they name, the workspace's do not reach the agent of
    // the instance, and nothing allows other-helper. The result says that it answers for the
    // right alone, and that a read through a grant opens no overview.
    await check(page, "kai-helper");
    await expect(checkRow(page, "write")).toContainText("Allowed");
    await expect(checkRow(page, "write")).toContainText("Right on this asset");
    await expect(checkRow(page, "delete")).toContainText("Refused");
    await expect(checkRow(page, "delete")).toContainText("No right");
    await expect(page.getByTestId("check-right-only")).toContainText("This is the right alone.");
    await expect(page.getByText("Viewing is allowed through a given right")).toBeVisible();
    await check(page, "other-helper");
    await expect(checkRow(page, "write")).toContainText("Refused");
    await expect(checkRow(page, "write")).toContainText("No right");
    await expect(page.getByTestId("check-right-only")).toHaveCount(0);
    // A name no agent can have gets no result.
    await check(page, "kai helper");
    await expect(page.getByText("An agent name is one word without spaces.")).toBeVisible();
    await expect(page.getByTestId("check-row")).toHaveCount(0);

    // A deny on the one agent refuses the action there. It is a row of its own: the person's
    // allow of the same action on the same agent would be that row already.
    await tab(page, "Rights").click();
    await page.getByRole("button", { name: "New right" }).click();
    await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    await grantDialog.getByLabel("Delete").check();
    await onAsset.check();
    await pick(page, grantDialog.getByRole("button", { name: /^Asset: / }), "kai-helper");
    await grantDialog.getByRole("radio", { name: /^Deny/u }).check();
    await expect(
      grantDialog.getByText("Refuses the ticked actions here, even for an administrator.")
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
    await expect(grantRows.locator('[data-effect="deny"]')).toHaveText("Denied: Delete agents");

    await check(page, "kai-helper");
    await expect(checkRow(page, "delete")).toContainText("Refused");
    await expect(checkRow(page, "delete")).toContainText("Deny on this asset");
    await expect(checkRow(page, "write")).toContainText("Allowed");
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

    // The rights in the workspace are revoked one by one.
    for (const action of ["View agents", "Edit agents", "Delete agents"]) {
      // The menu of the last round has left the page before the row's menu is opened again: a
      // click that lands while it is still leaving only finishes its closing.
      await expect(page.locator("[data-radix-focus-guard]")).toHaveCount(0);
      await workspaceGrants.getByRole("button", { name: /^Actions for the right of/u }).click();
      await page.getByRole("menuitem", { name: `Revoke: ${action}` }).click();
      const revokeDialog = page.getByRole("dialog", { name: "Revoke this right?" });
      await revokeDialog.getByRole("button", { name: "Revoke" }).click();
      // The dialog is gone, not only faded: it hands the focus back when it leaves.
      await expect(revokeDialog).toHaveCount(0);
      await expect(workspaceGrants.getByText(action, { exact: true })).toHaveCount(0);
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
  await expect(orphanedDeny).toContainText("kai-helper");
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
