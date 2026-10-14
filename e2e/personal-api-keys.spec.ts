import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// You > API keys: a new key starts with no scope ticked and gets exactly the boxes the person
// ticks, by the box or by its label, in the dialog and for a CLI's connect code alike. Ticked in
// advance, a click on the scope a person wanted took it away, and the key got everything else.

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

  await form.getByRole("checkbox", { name: "agent.read", exact: true }).click();
  await form.getByText("skill.write", { exact: true }).click();
  await form.getByRole("checkbox", { name: "agent.write", exact: true }).click();
  await expect(checked).toHaveCount(3);
  // A second click unticks that one box and no other.
  await form.getByText("agent.read", { exact: true }).click();
  await expect(checked).toHaveCount(2);
  await expect(form.getByRole("checkbox", { name: "agent.write", exact: true })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "skill.write", exact: true })).toBeChecked();
  await expect(form.getByRole("checkbox", { name: "agent.read", exact: true })).not.toBeChecked();
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
