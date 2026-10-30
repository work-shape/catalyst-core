import { randomUUID } from "node:crypto";
import { type Browser, type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type PageErrorWatch } from "./test";

// LU-2 (limits spec 3.1, checks 4 and 5): an admin sets a shared workspace's daily spend limit
// on Settings › All workspaces › Limits, at phone width in light and dark. A member of that
// workspace reads above the composer which limit stops them, when it resets and that an
// administrator can raise it, without an amount; the workspace's owner reads the amounts. A
// member cannot set a limit. Once the admin removes the value, the member can send again. The
// limit is on a workspace of this test alone, so no other spec is stopped by it.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const NARROW = { width: 390, height: 844 };
const limitsUrl = `${apiBaseUrl}/api/v1/instance/usage/limits`;

const admin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/limits.yaml`. No other spec uses it. */
const member = { email: "e2e-limits@example.test", password: "e2e-limits-password" };

const idSchema = z.object({ id: z.string() });

async function sessionOf(
  browser: Browser,
  watch: PageErrorWatch["watch"],
  user: { email: string; password: string },
  colorScheme: "light" | "dark" = "light"
): Promise<Page> {
  const context = await browser.newContext({ viewport: NARROW, colorScheme });
  await watch(context);
  const page = await context.newPage();
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...user, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  return page;
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

test("a workspace's spend limit stops its members with a sentence, set and removed by an admin", async ({
  browser,
  pageErrors
}) => {
  test.setTimeout(120_000);
  const name = `Limits ${randomUUID().slice(0, 8)}`;
  const root = await sessionOf(browser, pageErrors.watch, admin);
  const person = await sessionOf(browser, pageErrors.watch, member, "dark");
  // Signed in once, the member has the account a workspace adds.
  expect((await person.request.get(`${apiBaseUrl}/api/v1/me`)).ok()).toBe(true);
  const created = await requestWithOrigin(root, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const added = await requestWithOrigin(
    root,
    "post",
    `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
    { data: { email: member.email } }
  );
  expect(added.ok(), await added.text()).toBe(true);

  try {
    // The admin sets the workspace's daily limit on the Limits page, at phone width.
    await root.goto("/settings/instance/limits");
    await root
      .getByRole("combobox", { name: "Workspace", exact: true })
      .selectOption({ label: name });
    const editor = root.locator(`[data-testid="limit-editor"][data-label="${name}"]`);
    await editor.getByLabel("Per day").fill("0");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor.getByRole("status")).toHaveText("Saved. It applies from the next message.");
    await expectNoSidewaysScroll(root);
    // The interface takes its mode when it loads: the page is opened again in dark.
    await root.emulateMedia({ colorScheme: "dark" });
    await root.reload();
    await expect(editor.getByLabel("Per day")).toHaveValue("0");
    await expectNoSidewaysScroll(root);

    // A member reads the sentence, without an amount, and cannot send.
    await person.goto(`/w/${workspaceId}`);
    const block = person.getByTestId("usage-limit-block");
    await expect(block).toHaveText(
      "This workspace has reached its daily spend limit. It resets at midnight UTC. An administrator can raise it; other workspaces keep working."
    );
    await person.getByRole("textbox").first().fill("Hello");
    await expect(person.getByRole("button", { name: "Send message" })).toBeDisabled();
    await expectNoSidewaysScroll(person);

    // The owner reads the amounts.
    await root.goto(`/w/${workspaceId}`);
    await expect(root.getByTestId("usage-limit-block")).toContainText(
      "This workspace has reached its daily spend limit (€0.00 of €0.00)."
    );

    // The member holds no limits.manage: the API refuses them, and their settings list no Limits.
    const refused = await requestWithOrigin(person, "put", limitsUrl, {
      data: { level: "workspace", target: workspaceId, limits: { daily: 1000 } }
    });
    expect(refused.status()).toBe(403);
    await person.goto("/settings");
    await expect(person.getByRole("link", { name: "Limits", exact: true })).toHaveCount(0);

    // The admin removes the value and the member can send again.
    await root.goto("/settings/instance/limits");
    const set = root.locator(`[data-testid="limit-editor"][data-label="${name}"]`);
    await set.getByRole("button", { name: "Remove" }).click();
    await expect(set).toHaveCount(0);
    await person.goto(`/w/${workspaceId}`);
    await person.getByRole("textbox").first().fill("Hello");
    await expect(person.getByTestId("usage-limit-block")).toHaveCount(0);
    await expect(person.getByRole("button", { name: "Send message" })).toBeEnabled();
  } finally {
    await requestWithOrigin(root, "put", limitsUrl, {
      data: { level: "workspace", target: workspaceId, limits: null }
    });
  }
});
