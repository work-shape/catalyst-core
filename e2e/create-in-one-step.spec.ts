import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { shoot, shotsDir, signIn } from "./inbox-fixtures";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// UXA-2, as New opens a kind's page (studio-chat-entry): "New agent" and "New skill" open the
// empty page of the new asset, with no dialog in front. Its id is made from the name typed
// there, and an id that is taken is said while typing, before the first save. The name check
// of the create dialog stays where a dialog still starts an asset, as a copy or a connection.

/** Reads and writes every agent and skill of the instance. */
const builder = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";

const rail = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const address = (dialog: Locator) => dialog.locator('[data-name-with-address-field="address"]');
const nameField = (dialog: Locator) => dialog.locator('[data-name-with-address-field="name"]');
const nameRefused = (page: Page) => page.locator("[data-new-asset-name-refused]");

async function openAgents(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/w\/[^/]+/u);
  await rail(page).getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/agents$/u);
}

/** "New skill" on Studio's list: the empty page of a new skill. */
async function openNewSkill(page: Page): Promise<void> {
  await page.goto("/build/skills");
  await page
    .getByRole("button", { name: /^(New skill|Neue Fähigkeit|Neuer Skill)$/u })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { level: 1, name: /^(New skill|Neuer Skill)$/u })
  ).toBeVisible();
}

test("New agent opens its empty page, whose name makes the id and stores nothing yet", async ({
  page,
  instanceAgents: _instanceAgents
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, builder);
  await openAgents(page);
  await page.getByRole("button", { name: /^(New agent|Neuer Agent)$/u }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("heading", { level: 1, name: "New agent" })).toBeVisible();

  const suffix = randomUUID().slice(0, 8);
  await page
    .getByRole("textbox", { name: /^Display name/u })
    .first()
    .fill(`Travel Expenses ${suffix}`);
  await page
    .getByRole("textbox", { name: /^Description/u })
    .first()
    .fill("Answers questions about travel expenses.");
  await expect(
    page.getByRole("heading", { level: 1, name: `Travel Expenses ${suffix}` })
  ).toBeVisible();
  await expect(nameRefused(page)).toHaveCount(0);
  expect(
    (await page.request.get(`${apiBaseUrl}/api/v1/assets/agent/travel-expenses-${suffix}`)).status()
  ).toBe(404);
});

test("a new skill's name whose id is taken is said while typing", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, builder);
  const suffix = randomUUID().slice(0, 8);
  const taken = `expense-guide-${suffix}`;
  const stored = await requestWithOrigin(
    page,
    "put",
    `${apiBaseUrl}/api/v1/assets/skill/${taken}`,
    {
      data: {
        expectedRevision: null,
        config: {
          name: taken,
          title: `Expense guide ${suffix}`,
          description: "How expenses are claimed.",
          content: "# Expense guide"
        }
      }
    }
  );
  expect(stored.ok(), await stored.text()).toBe(true);
  try {
    await openNewSkill(page);
    const title = page.getByRole("textbox", { name: /^Title/u }).first();
    await title.fill(`Expense guide ${suffix}`);
    await expect(nameRefused(page)).toHaveText(`The id ${taken} is taken. Give it another name.`);
    await title.fill(`Expense guide for travel ${suffix}`);
    await expect(nameRefused(page)).toHaveCount(0);
  } finally {
    const url = `${apiBaseUrl}/api/v1/assets/skill/${taken}`;
    await requestWithOrigin(page, "delete", url, {
      data: { expectedRevision: await assetRevision(page, url) }
    });
  }
});

test("pictures of the new agent's page and the connection's create form", async ({
  page,
  instanceAgents: _instanceAgents
}) => {
  test.skip(!shotsDir, "Takes pictures only for E2E_SHOTS_DIR");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, builder);
  const widths = [1280, 390];
  await openAgents(page);

  // New agent: its empty page in Studio.
  await shoot(
    page,
    "new-agent-page",
    async () => {
      await page.goto("/build/agents");
      await page.getByRole("button", { name: /^(New agent|Neuer Agent)$/u }).click();
      await expect(
        page.getByRole("heading", { level: 1, name: /^(New agent|Neuer Agent)$/u })
      ).toBeVisible();
    },
    widths
  );
  // The New connection form: name, address and key, with the id under "Technical details".
  await shoot(
    page,
    "new-connection",
    async () => {
      await page.goto("/build/connections");
      await page
        .getByRole("button", { name: /^(New connection|Neue Verbindung)$/u })
        .first()
        .click();
      const dialog = page.getByRole("dialog").first();
      await dialog.locator('[data-connection-type="mcp"]').getByRole("button").click();
      await nameField(dialog).fill("Ticket system");
      await dialog.locator("[data-name-with-address-fold]").click();
      await expect(address(dialog)).toHaveAttribute("data-address-check", "free");
    },
    widths
  );
});
