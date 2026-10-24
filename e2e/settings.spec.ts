import { requestWithOrigin } from "./request-with-origin";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { z } from "zod";

import { apiBaseUrl, normalUser, settingsGear, settingsPages } from "./chat-fixtures";

const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

test("an instance admin opens every group of the Settings rail", async ({ page }) => {
  await signInViaApi(page, superadminUser);
  const workspace = await createWorkspace(page, { name: `E2E Rail ${Date.now()}` });

  await page.goto("/");
  await settingsGear(page).click();
  const rail = settingsPages(page);
  await expect(page).toHaveURL(/\/settings\/instance\/users$/u);
  for (const group of ["You", "Workspace", "Instance"]) {
    await expect(rail.getByRole("group", { name: group, exact: true })).toBeVisible();
  }
  await expect(
    rail.getByRole("group", { name: "Instance", exact: true }).getByRole("button")
  ).toHaveText(["Users", "Access", "API access", "Usage", "Limits", "Audit", "Workspaces"]);
  // How the instance runs folds away at the end of Instance, under System (RIGHTS-1e).
  const system = rail.getByRole("group", { name: "System", exact: true });
  await expect(system.getByRole("button")).toHaveText(["System"]);
  await system.getByRole("button", { name: "System", exact: true }).click();
  await expect(system.getByRole("button")).toHaveText([
    "System",
    "Jobs",
    "Operations",
    "Modules",
    "Infrastructure"
  ]);
  await expect(rail.getByRole("button", { name: "Users", exact: true })).toHaveAttribute(
    "aria-current",
    "true"
  );
  // Studio stands in the main rail as an area of its own, not among the Settings pages.
  await expect(page.getByRole("button", { name: "Studio", exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Studio" })).toHaveCount(0);

  await rail.getByRole("button", { name: "API access", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/instance\/api-access$/u);
  await expect(page.getByRole("heading", { name: "API access", level: 1 })).toBeVisible();

  await rail.getByRole("button", { name: "Security", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/you\/security$/u);
  await expect(page.getByRole("heading", { name: "Security", level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/settings\/instance\/api-access$/u);
  await expect(page.getByRole("heading", { name: "API access", level: 1 })).toBeVisible();

  // The Workspace pages change the workspace named under the group's label.
  await rail.getByRole("button", { name: /^Members/u }).click();
  await expect(page).toHaveURL(/\/settings\/workspace\/members$/u);
  await expect(page.getByRole("heading", { name: "Members", level: 1 })).toBeVisible();
  const scope = rail.getByRole("button", { name: /^Workspace for these pages: / });
  if ((await scope.count()) > 0) {
    await scope.click();
    await page.getByRole("option", { name: workspace.name, exact: true }).click();
    await expect(scope).toContainText(workspace.name);
  } else {
    await expect(rail.getByText(workspace.name, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("E2E Superadmin").first()).toBeVisible();

  await page.getByRole("button", { name: "Return to chat" }).click();
  await expect(page.getByPlaceholder("Message")).toBeVisible();
  await expect(rail).toHaveCount(0);
});

// Check 40 (RIGHTS-1e): a customer's admin keeps the audit log and sees no System page, neither
// in the rail nor by address, and the server refuses the reads behind them.
test("an admin finds no System pages, not by their address either", async ({ page }) => {
  await signInViaApi(page, adminUser);

  await page.goto("/settings/instance/users");
  const rail = settingsPages(page);
  await expect(rail.getByRole("button", { name: "Audit", exact: true })).toBeVisible();
  await expect(rail.getByRole("group", { name: "System", exact: true })).toHaveCount(0);
  for (const closed of ["System", "Jobs", "Operations", "Modules", "Infrastructure"]) {
    await expect(rail.getByRole("button", { name: closed, exact: true })).toHaveCount(0);
  }

  for (const [path, heading] of [
    ["/settings/instance/jobs", "Jobs"],
    ["/settings/instance/operations", "Operations"],
    ["/settings/instance/modules", "Modules"],
    ["/settings/instance/infrastructure", "Infrastructure"]
  ] as const) {
    await page.goto(path);
    await expect(
      page.getByText("You cannot open this page: it needs a right you do not have.", {
        exact: false
      })
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: heading, level: 1 })).toHaveCount(0);
  }

  for (const path of [
    "/api/v1/instance/jobs",
    "/api/v1/instance/jobs/summary",
    "/api/v1/operations/runs",
    "/api/v1/instance/modules",
    "/api/v1/instance/infrastructure"
  ]) {
    expect((await page.request.get(`${apiBaseUrl}${path}`)).status(), path).toBe(403);
  }
  expect((await page.request.get(`${apiBaseUrl}/api/v1/instance/audit-events`)).status()).toBe(200);
});

// A grant in a workspace opens Studio for this user: no spec hands one out while this runs.
test("a plain user finds only their own pages in the Settings rail", async ({
  page,
  accessState: _accessState
}) => {
  await signInViaApi(page, normalUser);

  await page.goto("/settings");
  await expect(page).toHaveURL(/\/settings\/you\/profile$/u);
  const rail = settingsPages(page);
  await expect(rail.getByRole("button", { name: "Profile", exact: true })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Profile", exact: true })).toHaveAttribute(
    "aria-current",
    "true"
  );
  await expect(rail.getByRole("button", { name: "Language and appearance" })).toBeVisible();
  await expect(rail.getByRole("button", { name: "Security", exact: true })).toBeVisible();
  // Usage stands among their own pages, by person; the Instance group stays closed below.
  for (const closed of ["Users", "Access", "API access", "Limits", "Audit", "Jobs", "System"]) {
    await expect(rail.getByRole("button", { name: closed, exact: true })).toHaveCount(0);
  }
  await expect(rail.getByRole("group", { name: "Instance" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Studio", exact: true })).toHaveCount(0);

  // The server refuses what the rail hides: the list of users stays closed to this user.
  const users = await page.request.get(`${apiBaseUrl}/api/v1/instance/users`);
  expect(users.status()).toBe(403);

  // A known page stays at the address that was opened and explains the missing right.
  await page.goto("/settings/instance/users");
  await expect(page).toHaveURL(/\/settings\/instance\/users$/u);
  await expect(
    page.getByText("You cannot open this page: it needs a right you do not have.", { exact: false })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open your profile", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Users", level: 1 })).toHaveCount(0);

  for (const [path, canonical] of [
    ["/admin/usage", "/settings/instance/usage"],
    ["/settings/instance/access", "/settings/instance/access"]
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("navigation", { name: "Main navigation" })).toBeVisible();
    await expect(page).toHaveURL(new URL(canonical, page.url()).href);
    await expect(
      page.getByRole("button", { name: "Open your profile", exact: true })
    ).toBeVisible();
    await expect(page.getByRole("heading", { name: "Usage", level: 1 })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /^Rights/u })).toHaveCount(0);
    await expect(rail.getByRole("group", { name: "Instance" })).toHaveCount(0);
  }

  await page.getByRole("button", { name: "Open your profile", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\/you\/profile$/u);
});

test("the account menu names the account and holds the settings, the theme and sign out", async ({
  page
}) => {
  await signInViaUi(page, normalUser);
  const trigger = page.getByRole("button", { name: "E2E User account" });
  const menu = page.getByRole("menu");
  const shell = page.locator("main").first();
  const isDark = () => shell.evaluate((element) => element.classList.contains("dark"));

  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("E2E User");
  await expect(menu).toContainText(normalUser.email);
  await expect(menu.getByRole("menuitem")).toHaveText([
    "Profile",
    "Language and appearance",
    /^Switch to (dark|light) theme$/u,
    "Documentation",
    "Sign out"
  ]);
  // The documentation is a link to the instance's docs address, in a new tab.
  const documentation = menu.getByRole("menuitem", {
    name: "Documentation, opens in a new tab",
    exact: true
  });
  await expect(documentation).toHaveAttribute("href", "https://docs.workshape.ai/catalyst");
  await expect(documentation).toHaveAttribute("target", "_blank");
  await expect(documentation).toHaveAttribute("rel", "noopener noreferrer");
  // It opens upward from the footer of the rail.
  const menuBox = await menu.boundingBox();
  const triggerBox = await trigger.boundingBox();
  expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(triggerBox?.y ?? 0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();

  const wasDark = await isDark();
  await trigger.click();
  await menu
    .getByRole("menuitem", { name: wasDark ? "Switch to light theme" : "Switch to dark theme" })
    .click();
  await expect.poll(isDark).toBe(!wasDark);
  await expect(menu).toBeHidden();

  // The collapsed rail keeps the avatar alone, and the menu opens beside it.
  await page.getByRole("button", { name: "Collapse sidebar" }).click();
  await expect(trigger).toHaveText(/^.{0,2}$/u);
  await trigger.click();
  await expect(menu).toBeVisible();
  const sideMenuBox = await menu.boundingBox();
  const collapsedTriggerBox = await trigger.boundingBox();
  expect(sideMenuBox?.x ?? 0).toBeGreaterThanOrEqual(
    (collapsedTriggerBox?.x ?? 0) + (collapsedTriggerBox?.width ?? 0)
  );
  await menu.getByRole("menuitem", { name: "Language and appearance" }).click();
  await expect(page).toHaveURL(/\/settings\/you\/language-appearance$/u);
  await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
  await expect(menu).toBeHidden();
  await trigger.click();
  await menu.getByRole("menuitem", { name: "Profile" }).click();
  await expect(page).toHaveURL(/\/settings\/you\/profile$/u);
  await expect(page.getByRole("heading", { name: "Profile", level: 1 })).toBeVisible();
  await expect(menu).toBeHidden();

  await trigger.click();
  await menu.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
});

test("superadmin creates a user with a password from the users panel", async ({ page }) => {
  await signInViaUi(page, superadminUser);
  await settingsGear(page).click();
  await expect(settingsPages(page)).toBeVisible();

  await settingsPages(page).getByRole("button", { name: "Users", exact: true }).click();
  await page.getByRole("button", { name: "New user" }).click();

  const timestamp = Date.now();
  const createdUser = {
    displayLabel: `E2E Created ${timestamp}`,
    email: `e2e-created-${timestamp}@example.test`,
    password: `e2e-created-${timestamp}`
  };
  const dialog = page.getByRole("dialog", { name: "New user" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Display label").fill(createdUser.displayLabel);
  await dialog.getByLabel("Email").fill(createdUser.email);
  const initialPasswordInput = dialog.getByLabel("Initial password");
  await expect(initialPasswordInput).toHaveAttribute("type", "password");
  await initialPasswordInput.fill(createdUser.password);
  await dialog.getByRole("button", { name: "Show password" }).click();
  await expect(initialPasswordInput).toHaveAttribute("type", "text");
  await expect(initialPasswordInput).toHaveValue(createdUser.password);
  await dialog.getByRole("button", { name: "Hide password" }).click();
  await expect(initialPasswordInput).toHaveAttribute("type", "password");
  await dialog.getByRole("button", { name: "Create user" }).click();
  const createdDialog = page.getByRole("dialog", { name: "User created" });
  await expect(createdDialog).toBeVisible();
  const createdPasswordInput = createdDialog.getByLabel("Initial password");
  await expect(createdPasswordInput).toHaveAttribute("type", "password");
  await createdDialog.getByRole("button", { name: "Show password" }).click();
  await expect(createdPasswordInput).toHaveAttribute("type", "text");
  await expect(createdPasswordInput).toHaveValue(createdUser.password);
  await page.getByRole("button", { name: "Open user" }).click();
  await expect(page.getByText(createdUser.displayLabel, { exact: true })).toBeVisible();
  await expect(page.getByText("Password sign-in", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: "E2E Superadmin account" }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();

  await signInViaUi(
    page,
    { email: createdUser.email, password: createdUser.password },
    { alreadyOnLogin: true }
  );
  await expect(
    page.getByRole("button", { name: `${createdUser.displayLabel} account` })
  ).toBeVisible();
  await expect(settingsGear(page)).toHaveCount(0);
});

async function createWorkspace(
  page: Page,
  data: {
    name: string;
    visibility?: "private" | "discoverable";
    defaultConversationVisibility?: "private";
  }
): Promise<{ id: string; name: string }> {
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data
  });
  expect(created.ok()).toBe(true);
  return z.object({ id: z.string(), name: z.string() }).parse(await created.json());
}

async function signInViaUi(
  page: Page,
  user: { email: string; password: string },
  options: { alreadyOnLogin?: boolean } = {}
): Promise<void> {
  if (!options.alreadyOnLogin) {
    await page.goto("/");
  }
  await expect(page.getByRole("main", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(user.email);
  await page.getByLabel("Password").fill(user.password);
  await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/auth/sign-in/email"
    ),
    page.getByRole("button", { name: "Sign in", exact: true }).click()
  ]);
  /*
   * The rail itself is the readiness signal. The client branding lives in the
   * workspace selector popover rather than in a branding row, so the rail does
   * not spell out the client name.
   */
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Search", exact: true })
  ).toBeVisible();
}

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: {
      email: user.email,
      password: user.password,
      rememberMe: true
    }
  });
  expect(response.ok()).toBe(true);
}
