import type { Page } from "@playwright/test";
import { shoot, shotsDir, signIn } from "./inbox-fixtures";
import { expect, test } from "./test";

// The Agents page: its row in the rail, the cards of the agents a person may use in the open
// workspace, and the two ways from a card into a chat. Fails without the page: the rail had no
// Agents row, and a person met an agent only in the picker of a conversation.

/** A member without a right on an agent: no Studio row, and no way into Studio from a card. */
const member = { email: "e2e-user@example.test", password: "e2e-user-password" };
/** Reads and writes every agent of the instance. */
const builder = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

/** The agents of `tests/fixtures/e2e-assets`, and the one starter prompt of the first. */
const DEFAULT_AGENT = "Application Assistant";
const OTHER_AGENT = "Research Assistant";
const PROMPT_TITLE = "Find review risks";
const PROMPT_TEXT =
  "List the most important application or document review risks I should check first.";

const rail = (page: Page) => page.getByRole("navigation", { name: "Main navigation" });
const agentsArea = (page: Page) => page.getByRole("region", { name: /^(Agents|Agenten)$/u });
const card = (page: Page, agent: string) =>
  agentsArea(page)
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: agent, exact: true }) });
/** The agent a message on the start page would go to. */
const startPageAgent = (page: Page) =>
  page.getByRole("region", { name: "Chat" }).getByRole("button", { name: "Select agent" });

async function openAgents(page: Page): Promise<void> {
  // The row has an address once the workspace is open: a click before that stays on the start page.
  await expect(page).toHaveURL(/\/w\/[^/]+/u);
  await rail(page).getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/agents$/u);
  await expect(card(page, DEFAULT_AGENT)).toBeVisible();
}

test("a member finds the agents of the workspace under New chat and starts a chat from a card", async ({
  page,
  instanceAgents: _instanceAgents
}) => {
  test.setTimeout(shotsDir ? 300_000 : 60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, member);
  const navigation = rail(page);

  // The row stands directly under New chat, and a member has no Studio row.
  const rows = navigation.getByRole("button", { name: /^(New chat|Agents|Apps|Inbox)/u });
  await expect(rows.nth(0)).toHaveAccessibleName(/^New chat/u);
  await expect(rows.nth(1)).toHaveAccessibleName("Agents");
  await expect(navigation.getByRole("button", { name: "Studio", exact: true })).toHaveCount(0);

  await openAgents(page);
  // The page is an area of its own: its title has the focus, and its row is the current one.
  await expect(page.getByRole("heading", { level: 1, name: "Agents" })).toBeFocused();
  await expect(navigation.locator('[aria-current="true"]')).toHaveAccessibleName("Agents");
  await expect(page.locator("header").getByRole("button", { name: "Select agent" })).toHaveCount(0);

  const defaultCard = card(page, DEFAULT_AGENT);
  const otherCard = card(page, OTHER_AGENT);
  await expect(defaultCard).toContainText("Help with application and document review.");
  await expect(defaultCard).toContainText("Default agent");
  await expect(otherCard).not.toContainText("Default agent");
  // A member changes nothing here and is not led to where agents are changed.
  await expect(agentsArea(page).getByRole("link", { name: "Edit in Studio" })).toHaveCount(0);
  await shoot(
    page,
    "agents-member",
    () => expect(card(page, DEFAULT_AGENT)).toBeVisible(),
    [1440, 390]
  );

  // Start chat opens a new conversation with that agent, by the keyboard as by a click.
  const start = otherCard.getByRole("button", { name: "Start chat" });
  await start.focus();
  await expect(start).toHaveAccessibleDescription(OTHER_AGENT);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await expect(startPageAgent(page)).toHaveAccessibleName(`Select agent: ${OTHER_AGENT}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");

  // A suggestion opens one with its text in the composer, ready to be finished and sent.
  await openAgents(page);
  await defaultCard.getByRole("button", { name: PROMPT_TITLE }).click();
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await expect(startPageAgent(page)).toHaveAccessibleName(`Select agent: ${DEFAULT_AGENT}`);
  await expect(composer).toHaveValue(PROMPT_TEXT);
  await expect(composer).toBeFocused();
  // Nothing was sent: the text is the person's to change.
  await composer.fill("");
});

test("the Agents page reads in German and keeps inside a phone's width", async ({
  page,
  instanceAgents: _instanceAgents
}) => {
  // Signing in waits for the rail, which a phone keeps in a drawer: the window narrows after it.
  await signIn(page, member);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.reload();

  // On a phone the rail is a drawer, and the row closes it.
  await page.getByRole("button", { name: "Seitenleiste öffnen" }).click();
  await page
    .getByRole("navigation", { name: "Hauptnavigation" })
    .getByRole("button", { name: "Agenten", exact: true })
    .click();
  await expect(page).toHaveURL(/\/w\/[^/]+\/agents$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Agenten" })).toBeVisible();
  const defaultCard = card(page, DEFAULT_AGENT);
  await expect(defaultCard.getByRole("button", { name: "Chat starten" })).toBeVisible();
  await expect(defaultCard).toContainText("Standardagent");

  // The title starts below the button that opens the drawer, and nothing reaches past the window.
  const opener = await page.getByRole("button", { name: "Seitenleiste öffnen" }).boundingBox();
  const title = await page.getByRole("heading", { level: 1, name: "Agenten" }).boundingBox();
  expect(title?.y ?? 0).toBeGreaterThanOrEqual((opener?.y ?? 0) + (opener?.height ?? 0));
  const cardBox = await defaultCard.boundingBox();
  expect(cardBox?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((cardBox?.x ?? 0) + (cardBox?.width ?? 0)).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
});

test("a builder is led from a card to the agent's page in Studio", async ({
  page,
  instanceAgents: _instanceAgents
}) => {
  test.setTimeout(shotsDir ? 300_000 : 60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, builder);
  await expect(rail(page).getByRole("button", { name: "Studio", exact: true })).toBeVisible();

  await openAgents(page);
  const edit = card(page, OTHER_AGENT).getByRole("link", { name: "Edit in Studio" });
  await expect(edit).toHaveAccessibleDescription(OTHER_AGENT);
  await expect(edit).toHaveAttribute("href", "/build/agents/research_assistant");
  await shoot(
    page,
    "agents-builder",
    () => expect(card(page, DEFAULT_AGENT)).toBeVisible(),
    [1440, 390]
  );

  await edit.click();
  await expect(page).toHaveURL(/\/build\/agents\/research_assistant$/u);
  await expect(page.getByRole("region", { name: "Studio" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: OTHER_AGENT })).toBeVisible();
  // The way back is the browser's: the cards are where they were.
  await page.goBack();
  await expect(card(page, OTHER_AGENT)).toBeVisible();
});
