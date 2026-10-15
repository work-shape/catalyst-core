import type { Page } from "@playwright/test";
import { PUBLISHED_CLI_VERSION } from "@work-shape/catalyst-api-contract";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// You > Connect a local agent: the command for the chosen tool, with the CLI version on npm the
// instance names and its address. Opening the page, switching the tool and copying the command
// issue no key and no connect code (Platform Access acceptance check 52). While the platform
// names no published CLI version, the page offers no command; the release that sets one runs
// the other test.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

/** Records each call that could issue a key or a code. */
function changesOf(page: Page): string[] {
  const changes: string[] = [];
  page.on("request", (request) => {
    if (request.method() !== "GET" && /connect-codes|api-keys/u.test(request.url())) {
      changes.push(`${request.method()} ${request.url()}`);
    }
  });
  return changes;
}

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...admin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("says the command is not available while no CLI is published for the instance", async ({
  page
}) => {
  test.skip(PUBLISHED_CLI_VERSION !== undefined, "A published CLI version is named");
  await signIn(page);
  const changes = changesOf(page);

  await page.goto("/settings/you/connect");
  await expect(page.getByRole("heading", { name: "Connect a local agent" })).toBeVisible();
  await expect(page.getByText("The command is not available yet")).toBeVisible();
  await expect(page.getByText("npm install")).toHaveCount(0);
  await page.getByRole("radio", { name: "Codex" }).click();
  await expect(page.getByText("The command is not available yet")).toBeVisible();
  expect(changes).toEqual([]);
});

test("shows one command per tool and issues no key and no code", async ({ page, context }) => {
  test.skip(PUBLISHED_CLI_VERSION === undefined, "No published CLI version is named yet");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);
  const changes = changesOf(page);

  await page.goto("/settings/you/connect");
  await expect(page.getByRole("heading", { name: "Connect a local agent" })).toBeVisible();
  const command = page.getByRole("region", { name: "Command for Claude Code" });
  await expect(command).toContainText(
    `npm install --global @work-shape/catalyst-cli@${PUBLISHED_CLI_VERSION} `
  );
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
