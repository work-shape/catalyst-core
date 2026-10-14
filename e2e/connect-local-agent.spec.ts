import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// You > Connect a local agent: the command for the chosen tool, with the instance's release and
// address. Opening the page, switching the tool and copying the command issue no key and no
// connect code (Platform Access acceptance check 52).

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("shows one command per tool and issues no key and no code", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  const changes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /connect-codes|api-keys/u.test(request.url())) {
      changes.push(`${request.method()} ${request.url()}`);
    }
  });

  await page.goto("/settings/you/connect");
  await expect(page.getByRole("heading", { name: "Connect a local agent" })).toBeVisible();
  const command = page.getByRole("region", { name: "Command for Claude Code" });
  await expect(command).toContainText(`npm install --global @work-shape/catalyst-cli@`);
  await expect(command).toContainText(`catalyst setup claude-code --instance ${apiBaseUrl}`);

  await page.getByRole("radio", { name: "Codex" }).click();
  const codex = page.getByRole("region", { name: "Command for Codex" });
  await expect(codex).toContainText(`catalyst setup codex --instance ${apiBaseUrl}`);
  await page.getByRole("button", { name: "Copy" }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(
    /^npm install --global @work-shape\/catalyst-cli@\S+ && catalyst setup codex --instance \S+$/u
  );

  await expect(page.getByRole("link", { name: "See or revoke the key" })).toHaveAttribute(
    "href",
    "/settings/you/api-keys"
  );
  expect(changes).toEqual([]);
});
