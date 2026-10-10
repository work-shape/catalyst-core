import { expect, test, type Locator, type Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const normalUser = { email: "e2e-user@example.test", password: "e2e-user-password" };
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
const accessPath = "/settings/instance/access";
const assetPath = `${apiBaseUrl}/api/v1/instance/config/assets/agent/kai-helper`;
/** Where a closed Instance page sends the visitor: the workspace, or its first settings page. */
const awayFromInstancePagesPattern = /\/w\/[^/]+$|\/settings\/workspace\/general$/u;
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

test("an administrator registers a Namespace, grants in it, checks, denies, revokes and deletes", async ({
  page
}) => {
  test.setTimeout(90_000);
  // A seeded user is listed once the user has signed in.
  await signInViaApi(page, normalUser);
  expect((await page.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  await signInViaApi(page, adminUser);
  await page.setViewportSize(WIDE);
  await page.goto("/settings/instance/users");
  await page
    .getByRole("navigation", { name: "Settings pages" })
    .getByRole("button", { name: "Access", exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`${accessPath}$`, "u"));
  await expect(page.getByText("No Namespace yet.")).toBeVisible();

  // Register kai-.
  await page.getByRole("button", { name: "New Namespace" }).click();
  const namespaceDialog = page.getByRole("dialog", { name: "New Namespace" });
  await namespaceDialog.getByLabel("Prefix").fill("Kai");
  await expect(namespaceDialog.getByText("Use lowercase letters and digits")).toBeVisible();
  await namespaceDialog.getByLabel("Prefix").fill("kai-");
  await namespaceDialog.getByLabel("Display name").fill("Kai");
  await namespaceDialog.getByRole("button", { name: "Create Namespace" }).click();
  await expect(namespaceDialog).toBeHidden();
  const namespaceRow = page.getByTestId("namespace-row").filter({ hasText: "kai-" });
  await expect(namespaceRow).toBeVisible();

  // A prefix that overlaps it is refused at the field, before anything is sent.
  await page.getByRole("button", { name: "New Namespace" }).click();
  await namespaceDialog.getByLabel("Prefix").fill("kai-x-");
  await expect(
    namespaceDialog.getByText("This prefix overlaps the registered Namespace kai-.")
  ).toBeVisible();
  await namespaceDialog.getByRole("button", { name: "Cancel" }).click();

  // An agent in the Namespace, for the lists and the deny further down.
  const created = await requestWithOrigin(page, "put", assetPath, {
    data: {
      config: {
        name: "kai-helper",
        displayName: "Kai Helper",
        modelProviderId: "local",
        instructions: "You help Kai.",
        toolNames: []
      }
    }
  });
  expect(created.ok()).toBe(true);
  const grantDialog = page.getByRole("dialog", { name: "New grant" });
  const grantRows = page.getByTestId("grant-row");
  const namespaceGrants = grantRows.filter({ hasText: "Namespace kai-" });
  try {
    await page.reload();

    // Grant E2E User reading and writing agents in kai-: one row, two actions.
    await tab(page, "Grants").click();
    await expect(page.getByText("No grant yet.")).toBeVisible();
    await page.getByRole("button", { name: "New grant" }).click();
    await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    await grantDialog.getByLabel("Read").check();
    await grantDialog.getByLabel("Write").check();
    await pick(page, grantDialog.getByRole("button", { name: /^Namespace: / }), /kai-/u);
    await grantDialog.getByRole("button", { name: "Create grant" }).click();
    await expect(grantDialog).toBeHidden();
    await expect(grantRows).toHaveCount(1);
    await expect(grantRows.first()).toContainText("E2E User");
    await expect(grantRows.first()).toContainText("Read agents");
    await expect(grantRows.first()).toContainText("Write agents");
    await expect(grantRows.first()).toContainText("Namespace kai-");
    await expect(grantRows.first()).toContainText("E2E Admin");

    // The same form with one more action adds the missing row and says what it left alone.
    await page.getByRole("button", { name: "New grant" }).click();
    await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    for (const verb of ["Read", "Write", "Delete"]) {
      await grantDialog.getByLabel(verb).check();
    }
    await pick(page, grantDialog.getByRole("button", { name: /^Namespace: / }), /kai-/u);
    await grantDialog.getByRole("button", { name: "Create grant" }).click();
    await expect(grantDialog).toBeHidden();
    await expect(page.getByText("1 added. 2 already there and left as they are.")).toBeVisible();
    await expect(grantRows).toHaveCount(1);
    await expect(grantRows.first().locator('[data-effect="allow"]')).toHaveCount(3);

    // The rows allow kai-helper and nothing allows other-helper. The result says that it
    // answers for the right alone, and that a read through a grant opens no overview.
    await check(page, "kai-helper");
    await expect(checkRow(page, "write")).toContainText("Allowed");
    await expect(checkRow(page, "write")).toContainText("Grant in Namespace kai-");
    await expect(page.getByTestId("check-right-only")).toContainText("This is the right alone.");
    await expect(page.getByText("Read is allowed through a grant")).toBeVisible();
    await expect(page.getByTestId("check-namespace-limits")).toHaveCount(0);
    await check(page, "other-helper");
    await expect(checkRow(page, "write")).toContainText("Refused");
    await expect(checkRow(page, "write")).toContainText("No grant");
    await expect(page.getByTestId("check-right-only")).toHaveCount(0);
    // A name no agent can have gets no result.
    await check(page, "kai helper");
    await expect(page.getByText("An agent name is one word without spaces.")).toBeVisible();
    await expect(page.getByTestId("check-row")).toHaveCount(0);

    // The Namespace cannot be deleted while grants name it. The item says why without a
    // pointer: the reason is a line of the item.
    await tab(page, "Namespaces").click();
    await namespaceRow.getByRole("button", { name: "Actions for kai-" }).click();
    const deleteItem = page.getByRole("menuitem", { name: "Delete" });
    await expect(deleteItem).toBeDisabled();
    await expect(deleteItem).toContainText("3 grants name this Namespace. Revoke them first.");

    // An empty tool list over an agent that exists is saved only after a confirmation that
    // names the Namespace and the agent count.
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editDialog = page.getByRole("dialog", { name: "Edit Namespace kai-" });
    await editDialog.getByRole("switch", { name: "Limit tools" }).click();
    await expect(editDialog.getByText("1 agent already has this prefix.")).toBeVisible();
    await editDialog.getByRole("button", { name: "Save", exact: true }).click();
    const lockConfirm = page.getByRole("dialog", { name: "Save kai- with an empty list?" });
    await expect(lockConfirm).toContainText("1 agent already has this prefix.");
    await expect(lockConfirm).toContainText("an instance administrator and the release sync");
    await lockConfirm.getByRole("button", { name: "Save anyway" }).click();
    await expect(editDialog).toBeHidden();
    await expect(namespaceRow).toContainText("None allowed");

    // The Check tab names that limit under a write it calls allowed.
    await check(page, "kai-helper");
    await expect(checkRow(page, "write")).toContainText("Allowed");
    await expect(page.getByTestId("check-namespace-limits")).toContainText(
      "This name lies in Namespace kai-"
    );
    await expect(page.getByTestId("check-namespace-limits")).toContainText("Tools: none allowed.");

    // A deny on the one agent wins over the grant in its Namespace.
    await tab(page, "Grants").click();
    await page.getByRole("button", { name: "New grant" }).click();
    await pick(page, grantDialog.getByRole("button", { name: /^Person: / }), /E2E User/u);
    await grantDialog.getByLabel("Write").check();
    await grantDialog.getByRole("radio", { name: /On one asset/u }).check();
    await pick(page, grantDialog.getByRole("button", { name: /^Asset: / }), "kai-helper");
    await grantDialog.getByRole("radio", { name: /^Deny/u }).check();
    await expect(grantDialog.getByText("Wins over grants and roles on this asset")).toBeVisible();
    await grantDialog.getByRole("button", { name: "Create grant" }).click();
    await expect(grantDialog).toBeHidden();
    await expect(grantRows).toHaveCount(2);
    await expect(grantRows.locator('[data-effect="deny"]')).toHaveText("Denied: Write agents");

    await check(page, "kai-helper");
    await expect(checkRow(page, "write")).toContainText("Refused");
    await expect(checkRow(page, "write")).toContainText("Deny on this asset");
    await expect(page.getByText("does not take away instance-wide rights")).toBeVisible();

    // At 390 wide the page keeps inside the window, on the result and on the grant list,
    // and nothing in the list scrolls sideways: a row stacks and keeps its menu in reach.
    await page.getByRole("button", { name: "Close sidebar" }).click();
    await page.setViewportSize(NARROW);
    await checkRow(page, "write").scrollIntoViewIfNeeded();
    await expect(checkRow(page, "write")).toBeInViewport();
    await expectNoSidewaysScroll(page);
    await tab(page, "Grants").click();
    await expect(grantRows).toHaveCount(2);
    await expectNoSidewaysScroll(page);
    for (const row of await grantRows.all()) {
      expect(await row.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
        true
      );
      await expect(row.getByRole("button", { name: /^Actions for the grant of/u })).toBeInViewport({
        ratio: 1
      });
    }
    await page.setViewportSize(WIDE);
    await page.getByRole("button", { name: "Open sidebar" }).click();
  } finally {
    const deleted = await requestWithOrigin(page, "post", `${assetPath}/delete`, { data: {} });
    expect(deleted.ok()).toBe(true);
  }

  // The deny outlives its asset: the list says so in text and still removes it.
  await page.reload();
  await tab(page, "Grants").click();
  const orphanedDeny = grantRows.filter({ hasText: "Asset no longer exists" });
  await expect(orphanedDeny).toContainText("kai-helper");
  await expect(orphanedDeny).toContainText("This deny stays until you remove it.");
  await orphanedDeny.getByRole("button", { name: /^Actions for the grant of/u }).click();
  await page.getByRole("menuitem", { name: "Remove deny: Write agents" }).click();
  await page
    .getByRole("dialog", { name: "Remove this deny?" })
    .getByRole("button", { name: "Remove deny" })
    .click();
  await expect(orphanedDeny).toHaveCount(0);
  for (const action of ["Read agents", "Write agents", "Delete agents"]) {
    // The menu of the last round has left the page before the row's menu is opened again: a
    // click that lands while it is still leaving only finishes its closing.
    await expect(page.locator("[data-radix-focus-guard]")).toHaveCount(0);
    await namespaceGrants.getByRole("button", { name: /^Actions for the grant of/u }).click();
    await page.getByRole("menuitem", { name: `Revoke: ${action}` }).click();
    const revokeDialog = page.getByRole("dialog", { name: "Revoke this grant?" });
    await revokeDialog.getByRole("button", { name: "Revoke" }).click();
    // The dialog is gone, not only faded: it hands the focus back when it leaves.
    await expect(revokeDialog).toHaveCount(0);
    await expect(namespaceGrants.getByText(action, { exact: true })).toHaveCount(0);
  }
  await expect(page.getByText("No grant yet.")).toBeVisible();

  // Nothing names the Namespace any more, so it can go.
  await tab(page, "Namespaces").click();
  await namespaceRow.getByRole("button", { name: "Actions for kai-" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page
    .getByRole("dialog", { name: "Delete Namespace kai-?" })
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(page.getByText("No Namespace yet.")).toBeVisible();
});

test("a user without the right to manage users has no Access page", async ({ page }) => {
  await signInViaApi(page, normalUser);
  await page.goto("/settings/you/profile");
  const rail = page.getByRole("navigation", { name: "Settings pages" });
  await expect(rail.getByRole("button", { name: "Profile" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Access", exact: true })).toHaveCount(0);

  await page.goto(accessPath);
  await expect(page).toHaveURL(awayFromInstancePagesPattern);
  await expect(page.getByRole("tab", { name: /^Namespaces/u })).toHaveCount(0);
});
