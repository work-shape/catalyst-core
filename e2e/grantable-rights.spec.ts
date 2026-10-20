import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";

const api = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
async function signIn(page: Page, email: string, password: string) {
  const response = await requestWithOrigin(page, "post", `${api}/api/auth/sign-in/email`, {
    data: { email, password, rememberMe: true }
  });
  expect(response.ok(), await response.text()).toBe(true);
}
/** The people a test made. They and their rows go before the test gives up its turn. */
const made: string[] = [];
test.afterEach(async ({ page }) => {
  for (const holderId of made.splice(0)) {
    const listed = await page.request.get(
      `${api}/api/v1/instance/access/grants?holderKind=user&holderId=${holderId}&limit=100`
    );
    const rows: { items: { id: string }[] } = listed.ok() ? await listed.json() : { items: [] };
    for (const grant of rows.items) {
      await requestWithOrigin(page, "delete", `${api}/api/v1/instance/access/grants/${grant.id}`);
    }
    await requestWithOrigin(page, "delete", `${api}/api/v1/instance/users/${holderId}`);
  }
});
async function prepare(root: Page, manager: Page) {
  manager.setDefaultTimeout(10_000);
  await signIn(root, "e2e-superadmin@example.test", "e2e-superadmin-password");
  const suffix = randomUUID().slice(0, 8),
    email = `rights-${suffix}@example.test`,
    password = "rights-manager-password";
  const response = await requestWithOrigin(root, "post", `${api}/api/v1/instance/users`, {
    data: {
      displayLabel: `Rights manager ${suffix}`,
      email,
      roles: ["user"],
      permissions: ["users.manage"],
      passwordSignIn: { password }
    }
  });
  expect(response.ok(), await response.text()).toBe(true);
  const user: { id: string } = await response.json();
  await signIn(manager, email, password);
  const workspace = await requestWithOrigin(root, "post", `${api}/api/v1/workspaces`, {
    data: { name: `Rights workspace ${suffix}` }
  });
  expect(workspace.ok()).toBe(true);
  const { id: workspaceId }: { id: string } = await workspace.json();
  const name = `rights-app-${suffix}`;
  const saved = await requestWithOrigin(root, "put", `${api}/api/v1/assets/app/${name}`, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${name}\nname: Rights App\nkit: 1.1.0\nentry: index.html\n`
        },
        { path: "index.html", text: "<!doctype html><title>Rights</title><p>Rights</p>" }
      ]
    },
    timeout: 90000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const asset: { id: string } = await (
    await root.request.get(`${api}/api/v1/assets/app/${name}?workspaceId=${workspaceId}`)
  ).json();
  const recipientResponse = await requestWithOrigin(root, "post", `${api}/api/v1/instance/users`, {
    data: { displayLabel: `Rights recipient ${suffix}`, roles: ["user"] }
  });
  expect(recipientResponse.ok()).toBe(true);
  const recipient: { id: string; displayLabel: string } = await recipientResponse.json();
  made.push(user.id, recipient.id);
  return { user, workspaceId, asset, name, email, recipient };
}
async function openAccess(page: Page) {
  await page.goto("/settings/instance/access");
  await page.getByRole("tab", { name: /^Rights/u }).click();
}

test("a giver with users.manage alone cannot open a new-right dialog", async ({
  page,
  browser,
  accessState: _accessState
}) => {
  test.setTimeout(120000);
  const context = await browser.newContext();
  const manager = await context.newPage();
  try {
    await prepare(page, manager);
    await openAccess(manager);
    await expect(manager.getByRole("button", { name: "New right", exact: true })).toBeDisabled();
  } finally {
    await context.close();
  }
});

test("the new-right dialog offers only the giver's workspace verbs and places", async ({
  page,
  browser,
  accessState: _accessState
}) => {
  test.setTimeout(120000);
  const context = await browser.newContext();
  const manager = await context.newPage();
  try {
    const { user, workspaceId, email, recipient } = await prepare(page, manager);
    for (const action of ["app.read", "app.write"]) {
      const response = await requestWithOrigin(
        page,
        "post",
        `${api}/api/v1/instance/access/grants`,
        {
          data: {
            holderKind: "user",
            holderId: user.id,
            action,
            effect: "allow",
            scopeKind: "workspace",
            scopeId: workspaceId
          }
        }
      );
      expect(response.ok(), await response.text()).toBe(true);
    }
    const other = await requestWithOrigin(page, "post", `${api}/api/v1/workspaces`, {
      data: { name: "Ungrantable workspace" }
    });
    const { id: otherId }: { id: string } = await other.json();
    expect(
      (
        await requestWithOrigin(page, "post", `${api}/api/v1/workspaces/${otherId}/members`, {
          data: { email }
        })
      ).ok()
    ).toBe(true);
    await openAccess(manager);
    await manager.getByRole("button", { name: "New right", exact: true }).click();
    const dialog = manager.getByRole("dialog", { name: "New right" });
    await dialog.getByRole("radio", { name: "Apps", exact: true }).check();
    await expect(dialog.getByRole("checkbox", { name: "View", exact: true })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "Edit", exact: true })).toBeVisible();
    await expect(dialog.getByRole("checkbox", { name: "Publish", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: "Delete", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("radio", { name: /^Whole instance/u })).toHaveCount(0);
    await expect(dialog.getByRole("radio", { name: /Namespace/u })).toHaveCount(0);
    await dialog.getByRole("button", { name: /^Workspace:/u }).click();
    await expect(
      manager.getByRole("option", { name: "Ungrantable workspace", exact: true })
    ).toHaveCount(0);
    await manager.getByRole("option").click();
    await dialog.getByRole("button", { name: /^Person:/u }).click();
    await manager.getByRole("option", { name: recipient.displayLabel, exact: true }).click();
    await dialog.getByRole("checkbox", { name: "Edit", exact: true }).check();
    const written = manager.waitForResponse(
      (response) =>
        response.url() === `${api}/api/v1/instance/access/grants` &&
        response.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: "Create right", exact: true }).click();
    const granted = await written;
    expect(granted.status(), await granted.text()).toBe(200);
    expect(await granted.json()).toMatchObject({
      holderId: recipient.id,
      action: "app.write",
      scopeKind: "workspace",
      scopeId: workspaceId
    });
    await expect(dialog).toBeHidden();
  } finally {
    await context.close();
  }
});

test("an asset-only giver is offered no broader scope or unheld verbs", async ({
  page,
  browser,
  accessState: _accessState
}) => {
  test.setTimeout(120000);
  const context = await browser.newContext();
  const manager = await context.newPage();
  try {
    const { user, asset, recipient } = await prepare(page, manager);
    expect(
      (
        await requestWithOrigin(page, "post", `${api}/api/v1/instance/access/grants`, {
          data: {
            holderKind: "user",
            holderId: user.id,
            action: "app.read",
            effect: "allow",
            scopeKind: "asset",
            scopeId: asset.id
          }
        })
      ).ok()
    ).toBe(true);
    await openAccess(manager);
    await manager.getByRole("button", { name: "New right", exact: true }).click();
    const dialog = manager.getByRole("dialog", { name: "New right" });
    await dialog.getByRole("radio", { name: "Apps", exact: true }).check();
    await expect(dialog.getByRole("checkbox")).toHaveCount(1);
    await expect(dialog.getByRole("checkbox", { name: "View", exact: true })).toBeVisible();
    await expect(dialog.getByRole("radiogroup", { name: "Where", exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: /^App:/u })).toBeEnabled();
    await dialog.getByRole("button", { name: /^App:/u }).click();
    await manager.getByRole("option").click();
    await dialog.getByRole("button", { name: /^Person:/u }).click();
    await manager.getByRole("option", { name: recipient.displayLabel, exact: true }).click();
    await dialog.getByRole("checkbox", { name: "View", exact: true }).check();
    const written = manager.waitForResponse(
      (response) =>
        response.url() === `${api}/api/v1/instance/access/grants` &&
        response.request().method() === "POST"
    );
    await dialog.getByRole("button", { name: "Create right", exact: true }).click();
    const granted = await written;
    expect(granted.status(), await granted.text()).toBe(200);
    expect(await granted.json()).toMatchObject({
      holderId: recipient.id,
      action: "app.read",
      scopeKind: "asset",
      scopeId: asset.id
    });
    const refused = await requestWithOrigin(
      manager,
      "post",
      `${api}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: recipient.id,
          action: "app.read",
          scopeKind: "instance",
          effect: "allow"
        }
      }
    );
    expect(refused.status()).toBe(403);
  } finally {
    await context.close();
  }
});
