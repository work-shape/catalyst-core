import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A Builder and Publisher of one Shared Workspace confirms the connect code `catalyst setup`
// starts without touching a box. The page offers only the rights the person holds, every one
// ticked but `connection.use`, so the confirmation is never refused for a right the screen
// ticked, and the key the CLI collects carries no deletion: neither bundle deletes.
//
// The key is read from the collection answer into memory only: it is never printed, attached or
// shot, and it is revoked through the signed-in session at the end. A trace would record the
// answer, so this file keeps none.

test.use({ trace: "off" });

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/personal-key-connect-code.yaml`. */
const builder = { email: "e2e-key-connect@example.test", password: "e2e-key-connect-password" };

const idSchema = z.object({ id: z.string() });
const startedSchema = z.object({ userCode: z.string(), deviceCode: z.string() });
const issuedSchema = z.object({
  status: z.literal("issued"),
  key: z.object({ id: z.string(), scopes: z.array(z.string()) })
});
const redeemedSchema = z.object({ status: z.string() });

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

test("a Builder and Publisher of one workspace confirms a connect code as it stands and gets a key without delete", async ({
  page,
  browser,
  baseURL,
  playwright
}) => {
  test.setTimeout(120_000);
  await signIn(page, superadmin);
  const tag = randomUUID().slice(0, 8);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Key connect ${tag}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;

  const builderContext = await browser.newContext({ baseURL });
  const builderPage = await builderContext.newPage();
  // The CLI: no session, only its own codes.
  const cli = await playwright.request.newContext();
  const grants: string[] = [];
  let keyId: string | undefined;
  try {
    await signIn(builderPage, builder);
    const me = idSchema.parse(
      await (await builderPage.request.get(`${apiBaseUrl}/api/v1/me`)).json()
    );
    for (const action of ["builder", "publisher"]) {
      const granted = await requestWithOrigin(
        page,
        "post",
        `${apiBaseUrl}/api/v1/instance/access/grants`,
        {
          data: {
            holderKind: "user",
            holderId: me.id,
            action,
            effect: "allow",
            scopeKind: "workspace",
            scopeId: workspaceId
          }
        }
      );
      expect(granted.ok(), await granted.text()).toBe(true);
      grants.push(idSchema.parse(await granted.json()).id);
    }

    // What `catalyst setup claude-code` does first: start a code, with no session.
    const started = await cli.post(`${apiBaseUrl}/api/v1/auth/connect-codes`, {
      data: { clientLabel: `Claude Code on e2e-${tag}` }
    });
    expect(started.ok(), `connect code start status ${started.status()}`).toBe(true);
    const { userCode, deviceCode } = startedSchema.parse(await started.json());

    await builderPage.goto(`/settings/you/api-keys?code=${encodeURIComponent(userCode)}&level=use`);
    const confirm = builderPage.getByRole("button", { name: "Confirm", exact: true });
    await expect(confirm).toBeEnabled();
    const form = builderPage.locator("form").filter({ has: confirm });
    // Only what the person holds is offered, ticked: no deletion, which neither bundle carries.
    await expect(form.getByRole("checkbox", { name: "Edit agents", exact: true })).toBeChecked();
    await expect(form.getByRole("checkbox", { name: "Publish agents", exact: true })).toBeChecked();
    await expect(form.getByRole("checkbox", { name: "Delete agents", exact: true })).toHaveCount(0);
    await expect(form.getByRole("checkbox", { name: "Delete skills", exact: true })).toHaveCount(0);

    await confirm.click();
    await expect(builderPage.getByText("The CLI is now logged in", { exact: true })).toBeVisible();

    // The CLI collects the key with its own code. Only the scopes are read from the answer.
    const redeemed = await cli.post(`${apiBaseUrl}/api/v1/auth/connect-codes/redeem`, {
      data: { deviceCode }
    });
    expect(redeemed.ok(), `connect code redeem status ${redeemed.status()}`).toBe(true);
    const answer: unknown = await redeemed.json();
    expect(redeemedSchema.parse(answer).status).toBe("issued");
    const issued = issuedSchema.parse(answer);
    keyId = issued.key.id;
    expect(issued.key.scopes).toEqual(expect.arrayContaining(["agent.write", "agent.publish"]));
    expect(issued.key.scopes.filter((scope) => scope.split(":")[0]?.endsWith(".delete"))).toEqual(
      []
    );
  } finally {
    if (keyId !== undefined) {
      const revoked = await requestWithOrigin(
        builderPage,
        "post",
        `${apiBaseUrl}/api/v1/me/api-keys/${encodeURIComponent(keyId)}/revoke`
      );
      expect(revoked.ok(), `revoke status ${revoked.status()}`).toBe(true);
    }
    for (const grant of grants) {
      await requestWithOrigin(
        page,
        "delete",
        `${apiBaseUrl}/api/v1/instance/access/grants/${grant}`
      );
    }
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/workspaces/${workspaceId}`);
    await cli.dispose();
    await builderContext.close();
  }
});
