import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { shoot, shotsDir, signIn } from "./inbox-fixtures";
import { expect, test } from "./test";

// UXA-2: a form that creates an asset asks for its name first. The address is made from the
// name under "Advanced", follows it until somebody types one, and is checked while typing: a
// taken or malformed address is named at the field and Continue waits. Fails without the
// change: the id was a field of its own beside the name, and a taken id was only refused by
// the first save on the asset's page.

/** Reads and writes every agent and skill of the instance. */
const builder = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";

/** The agent of `tests/fixtures/e2e-assets` whose address the new one asks for. */
const TAKEN_TITLE = "Application Assistant";

const rail = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const address = (dialog: Locator) => dialog.locator('[data-name-with-address-field="address"]');
const nameField = (dialog: Locator) => dialog.locator('[data-name-with-address-field="name"]');

async function openAgents(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/w\/[^/]+/u);
  await rail(page).getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/agents$/u);
}

/** Opens the dialog from the Agents page, in either language. */
async function openNewAgent(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: /^(New agent|Neuer Agent)$/u }).click();
  const dialog = page.getByRole("dialog");
  await expect(nameField(dialog)).toBeVisible();
  return dialog;
}

async function openNewSkill(page: Page): Promise<Locator> {
  await page.goto("/build/skills");
  await page
    .getByRole("button", { name: /^(New skill|Neue Fähigkeit|Neuer Skill)$/u })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(nameField(dialog)).toBeVisible();
  return dialog;
}

test("a new agent's address follows its name, names a taken one while typing and keeps one typed by hand", async ({
  page,
  instanceAgents: _instanceAgents
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, builder);
  await openAgents(page);
  const dialog = await openNewAgent(page);
  const fold = dialog.getByRole("button", { name: "Advanced", exact: true });
  const proceed = dialog.getByRole("button", { name: "Continue", exact: true });
  await expect(fold).toHaveAttribute("aria-expanded", "false");

  // The fixture's agent holds the address the name makes: the fold opens with the reason.
  await nameField(dialog).fill(TAKEN_TITLE);
  await expect(dialog.getByRole("alert")).toHaveText(
    "This address is taken. Choose another name or address."
  );
  await expect(address(dialog)).toHaveValue("application_assistant");
  await expect(proceed).toBeDisabled();

  // Another name moves the address with it; the fold stays open and the reason goes.
  const suffix = randomUUID().slice(0, 8);
  await nameField(dialog).fill(`Travel Helper ${suffix}`);
  await expect(address(dialog)).toHaveValue(`travel_helper_${suffix}`);
  await expect(address(dialog)).toHaveAttribute("data-address-check", "free");
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(proceed).toBeEnabled();

  // Typed by hand, the address stays when the name changes again.
  const typed = `travel-${suffix}`;
  await address(dialog).fill(typed);
  await nameField(dialog).fill(`Travel Expenses ${suffix}`);
  await expect(address(dialog)).toHaveValue(typed);

  // The name check uses the agent schema too: path segments a browser drops are refused.
  for (const invalid of [".", ".."]) {
    await address(dialog).fill(invalid);
    await expect(dialog.getByRole("alert")).toHaveText(/^This address does not work\./u);
    await expect(proceed).toBeDisabled();
  }
  await address(dialog).fill(typed);

  // What it should do goes onto the new agent's page with its name; nothing is stored yet.
  await dialog
    .getByRole("textbox", { name: /^What should it do\?/u })
    .fill("Answers questions about travel expenses.");
  await expect(address(dialog)).toHaveAttribute("data-address-check", "free");
  await proceed.click();
  await expect(
    page.getByRole("heading", { level: 1, name: `Travel Expenses ${suffix}` })
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Description/u })).toHaveValue(
    "Answers questions about travel expenses."
  );
  expect((await page.request.get(`${apiBaseUrl}/api/v1/assets/agent/${typed}`)).status()).toBe(404);
});

test("a skill's address that breaks the rule for names is named while typing and blocks Continue", async ({
  page
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, builder);
  const dialog = await openNewSkill(page);
  await nameField(dialog).fill("Expense guide");
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  await address(dialog).fill("-expense guide");
  await expect(dialog.getByRole("alert")).toHaveText(/^This address does not work\./u);
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await address(dialog).fill(`expense_guide_${randomUUID().slice(0, 8)}`);
  await expect(dialog.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
});

test("pictures of the three create forms", async ({ page, instanceAgents: _instanceAgents }) => {
  test.skip(!shotsDir, "Takes pictures only for E2E_SHOTS_DIR");
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, builder);
  const widths = [1280, 390];
  await openAgents(page);

  // The agent's form with a taken address: the fold opened by itself, with the reason.
  await shoot(
    page,
    "new-agent-taken",
    async () => {
      const dialog = await openNewAgent(page);
      await nameField(dialog).fill(TAKEN_TITLE);
      await expect(address(dialog)).toHaveAttribute("data-address-check", "refused");
      // The chevron turns as the fold opens.
      await expect(dialog.locator("[data-name-with-address-fold]")).toHaveAttribute(
        "data-state",
        "open"
      );
    },
    widths
  );
  // The skill's form: the name first, the address made from it under "Advanced".
  await shoot(
    page,
    "new-skill",
    async () => {
      const dialog = await openNewSkill(page);
      await nameField(dialog).fill("Expense guide");
      await dialog
        .getByRole("button", { name: "Advanced", exact: true })
        .or(dialog.getByRole("button", { name: "Erweitert", exact: true }))
        .click();
      await expect(address(dialog)).toHaveAttribute("data-address-check", "free");
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
