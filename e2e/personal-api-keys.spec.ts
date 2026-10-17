import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// You > API keys: a new key starts with no scope ticked and gets exactly the boxes the person
// ticks, by the box or by its label, in the dialog and for a CLI's connect code alike. Each box
// is named as the rights screens name its action. Ticked in advance, a click on the scope a
// person wanted took it away, and the key got everything else.
// The one exception is the use level `catalyst setup` asks for (CLI-PUBLISH-USE).

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** Ticks and unticks boxes the way a person does and checks that only those change. */
async function chooseScopes(form: Locator): Promise<void> {
  await expect(form.getByRole("checkbox")).not.toHaveCount(0);
  const checked = form.locator('[role="checkbox"][aria-checked="true"]');
  await expect(checked).toHaveCount(0);

  await form.getByRole("checkbox", { name: "View agents", exact: true }).click();
  await form.getByText("Edit skills", { exact: true }).click();
  await form.getByRole("checkbox", { name: "Edit agents", exact: true }).click();
  await expect(checked).toHaveCount(3);
  // A second click unticks that one box and no other.
  await form.getByText("View agents", { exact: true }).click();
  await expect(checked).toHaveCount(2);
  await expect(form.getByRole("checkbox", { name: "Edit agents", exact: true })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "Edit skills", exact: true })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "View agents", exact: true })).not.toBeChecked();
}

test("a new key starts with no scope ticked and gets exactly the scopes ticked", async ({
  page
}) => {
  await signIn(page);
  await page.goto("/settings/you/api-keys");
  await page.getByRole("button", { name: "New key" }).click();
  const dialog = page.getByRole("dialog", { name: "New key" });
  await dialog.getByRole("textbox", { name: "Name" }).fill("scope-check");
  // Nothing is ticked, so nothing can be created yet.
  await expect(dialog.getByRole("button", { name: "Create key" })).toBeDisabled();
  await chooseScopes(dialog);

  const created = page.waitForResponse(
    (response) => response.url().includes("/me/api-keys") && response.request().method() === "POST"
  );
  await dialog.getByRole("button", { name: "Create key" }).click();
  const body: unknown = (await created).request().postDataJSON();
  expect(body).toMatchObject({ name: "scope-check", scopes: ["agent.write", "skill.write"] });
});

test("a CLI's connect code starts with no scope ticked and gets exactly the scopes ticked", async ({
  page
}) => {
  await signIn(page);
  const started = await page.request.post(`${apiBaseUrl}/api/v1/auth/connect-codes`, {
    data: { clientLabel: "catalyst CLI" }
  });
  expect(started.ok()).toBe(true);
  const { confirmPath } = z.object({ confirmPath: z.string() }).parse(await started.json());
  await page.goto(confirmPath);
  const form = page.locator("form").filter({ has: page.getByRole("checkbox") });
  await chooseScopes(form);

  const confirmed = page.waitForResponse(
    (response) =>
      response.url().includes("/me/connect-codes/") && response.request().method() === "POST"
  );
  await form.getByRole("button", { name: "Confirm" }).click();
  const body: unknown = (await confirmed).request().postDataJSON();
  expect(body).toMatchObject({ scopes: ["agent.write", "skill.write"] });
});

test("the code `catalyst setup` opens starts with the authoring rights and the use level ticked", async ({
  page
}) => {
  await signIn(page);
  const started = await page.request.post(`${apiBaseUrl}/api/v1/auth/connect-codes`, {
    data: { clientLabel: "Claude Code on laptop" }
  });
  expect(started.ok()).toBe(true);
  const { confirmPath } = z.object({ confirmPath: z.string() }).parse(await started.json());
  await page.goto(`${confirmPath}&level=use`);
  const form = page.locator("form").filter({ has: page.getByRole("checkbox") });
  const useLevel = form.getByRole("group", { name: "Use" });
  await expect(useLevel.locator('[role="checkbox"][aria-checked="true"]')).not.toHaveCount(0);

  const confirmed = page.waitForResponse(
    (response) =>
      response.url().includes("/me/connect-codes/") && response.request().method() === "POST"
  );
  await form.getByRole("button", { name: "Confirm" }).click();
  const { scopes } = z
    .object({ scopes: z.array(z.string()) })
    .parse((await confirmed).request().postDataJSON());
  // The key pushes and publishes as it is offered: reading and writing are ticked, deleting
  // is not, and the use level is.
  expect(scopes).toContain("agent.read");
  expect(scopes).toContain("agent.write");
  expect(
    scopes.filter((scope) =>
      [
        "connection.use",
        "data_store.insert",
        "data_store.execute",
        "knowledge_base.use",
        "workflow.use"
      ].includes(scope)
    )
  ).not.toEqual([]);
  expect(scopes.filter((scope) => scope.endsWith(".delete"))).toEqual([]);
});
