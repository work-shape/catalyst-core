import type { Page } from "@playwright/test";
import { signIn } from "./inbox-fixtures";
import { expect, test } from "./test";

// The agent gives the chat it runs in a title. The rail and the chat's header show it while the
// page stays as it is, and the title the job writes for a new conversation does not replace it.
// Fails without the change: the tool does not exist, and a chat's header keeps its old title.

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const RENAME = "platform.conversations.rename";

const call = (title: string) => `/tool ${RENAME} ${JSON.stringify({ title })}`;
const railRow = (page: Page, title: string) =>
  page.getByTestId("conversation-row").filter({ hasText: title });

/** A reload would lose the mark this sets. */
const markThePage = (page: Page) =>
  page.evaluate(() => {
    document.documentElement.dataset.samePage = "yes";
  });
const stayedOnThePage = (page: Page) =>
  page.evaluate(() => document.documentElement.dataset.samePage === "yes");

test("the title the agent gives shows at once, in the rail and the dock's head, and stays", async ({
  page
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, superadmin);
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await markThePage(page);

  // In the first run, in the full chat. The rail shows the title, and the tool's row says so.
  const first = "Sample Customer Ltd";
  await page.getByPlaceholder(/^(?:Message|Nachricht)$/u).fill(call(first));
  await page.getByRole("button", { name: /^(?:Send message|Nachricht senden)$/u }).click();
  await expect(railRow(page, first)).toHaveCount(1);
  expect(await stayedOnThePage(page)).toBe(true);
  await page.getByRole("button", { name: /^Work history/u }).click();
  await expect(page.getByText("Rename the chat")).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat" }).getByText(first).first()).toBeVisible();

  // Long enough for the title job of the first message: the title is still the agent's.
  await page.waitForTimeout(5_000);
  await expect(railRow(page, first)).toHaveCount(1);
  await page.reload();
  await expect(railRow(page, first)).toHaveCount(1);

  // In the dock beside a page: its head and the rail change while the page stays.
  const [, workspace, conversation] =
    new URL(page.url()).pathname.match(/^\/w\/([^/]+)\/c\/([^/]+)$/u) ?? [];
  await page.goto(`/w/${workspace ?? ""}/agents?chat=${conversation ?? ""}`);
  const dock = page.locator("[data-dock-chat]");
  const head = dock.locator("header").first();
  await expect(head).toContainText(first);
  await markThePage(page);
  const second = "Other Customer Ltd";
  await dock.getByPlaceholder("Message").fill(call(second));
  await dock.getByPlaceholder("Message").press("Enter");
  await expect(head).toContainText(second);
  await expect(railRow(page, second)).toHaveCount(1);
  await expect(railRow(page, first)).toHaveCount(0);
  expect(await stayedOnThePage(page)).toBe(true);
});
