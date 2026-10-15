import type { Page } from "@playwright/test";
import { shoot, shotsDir, signIn } from "./inbox-fixtures";
import { assetBaseRevision, assetRevision, requestWithOrigin } from "./request-with-origin";
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

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;

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
  // A card names the agent and what it does: its starter prompts wait in the chat with it.
  await expect(defaultCard.getByRole("button", { name: PROMPT_TITLE })).toHaveCount(0);
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
  await expect(start).toHaveAccessibleName(`Start chat with ${OTHER_AGENT}`);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await expect(startPageAgent(page)).toHaveAccessibleName(`Select agent: ${OTHER_AGENT}`);
  const composer = page.getByRole("textbox", { name: "Message" });
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");

  // A press dragged across what the agent does, as when selecting it, starts nothing.
  await openAgents(page);
  const what = defaultCard.getByText("Help with application and document review.");
  const whatBox = await what.boundingBox();
  const fromX = whatBox?.x ?? 0;
  const atY = (whatBox?.y ?? 0) + (whatBox?.height ?? 0) / 2;
  await page.mouse.move(fromX + 2, atY);
  await page.mouse.down();
  await page.mouse.move(fromX + (whatBox?.width ?? 0) - 2, atY, { steps: 5 });
  await page.mouse.up();
  await expect(page).toHaveURL(/\/w\/[^/]+\/agents$/u);

  // The whole card starts the chat: a click on what the agent does lands on Start chat, whose
  // area lies over the text, so the pointer is sent there by force.
  // The starter prompts of the default agent stand in the empty chat with it.
  await what.click({ force: true });
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  await expect(startPageAgent(page)).toHaveAccessibleName(`Select agent: ${DEFAULT_AGENT}`);
  await expect(page.getByRole("button", { name: PROMPT_TITLE })).toBeVisible();
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
  await expect(
    defaultCard.getByRole("button", { name: `Chat starten mit ${DEFAULT_AGENT}`, exact: true })
  ).toBeVisible();
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

  // The link stands above the card that starts a chat, and keeps its own way.
  await edit.click();
  await expect(page).toHaveURL(/\/build\/agents\/research_assistant$/u);
  await expect(page.getByRole("region", { name: "Studio" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: OTHER_AGENT })).toBeVisible();
  // The way back is the browser's: the cards are where they were.
  await page.goBack();
  await expect(card(page, OTHER_AGENT)).toBeVisible();
});

// A stored agent can name a model the instance no longer has (SA-0). Writes refuse such a
// reference, so the read of the real API is served with the fields the server then adds.
test("a builder reads on an agent's page what of it is unavailable and that it cannot chat", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(
    ({ pathname }) => pathname === "/api/v1/assets/agent/research_assistant",
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      const response = await route.fetch();
      const body: Record<string, unknown> = await response.json();
      await route.fulfill({
        response,
        json: {
          ...body,
          chatAvailable: false,
          unavailableTools: [{ name: "crm.lookup", reason: "unknown_tool" }],
          unavailableSkills: [],
          unavailableModels: [
            { name: "retired-model", field: "modelBindingId", reason: "unknown_model" }
          ]
        }
      });
    }
  );
  await signIn(page, builder);
  await page.goto("/build/agents/research_assistant");
  const form = page.locator("form");

  const notice = form.locator("[data-agent-chat-unavailable]");
  await expect(notice).toContainText("This agent cannot chat");
  await expect(notice).toContainText("Nobody can chat with it until its model is changed.");
  await expect(form.locator("[data-agent-unavailable]")).toHaveText(
    "Not available: crm.lookup (tool does not exist on this instance), " +
      "retired-model (model does not exist on this instance)"
  );
});

test("a builder who renames an agent in Studio finds the new name on its card", async ({
  page,
  // The probe agent is offered in every workspace while it exists, so the tests that count
  // the agents of the instance wait for this one.
  instanceAgentsChange: _instanceAgentsChange
}) => {
  test.setTimeout(90_000);
  const name = "e2e_rename_probe";
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, builder);
  const remove = async () => {
    if ((await page.request.get(agentPath(name))).ok()) {
      await requestWithOrigin(page, "post", `${agentPath(name)}/delete`, {
        data: { expectedRevision: await assetRevision(page, agentPath(name)) }
      });
    }
  };
  await remove();
  const created = await requestWithOrigin(page, "put", agentPath(name), {
    data: {
      expectedRevision: await assetBaseRevision(page, agentPath(name)),
      availableIn: "all",
      config: {
        name,
        displayName: "Rename Probe",
        modelProviderId: "local",
        instructions: "A probe of the Agents page tests.",
        toolNames: []
      }
    }
  });
  expect(created.ok()).toBe(true);
  try {
    // The page has read the workspace's agents before the rename.
    await page.reload();
    await openAgents(page);
    await card(page, "Rename Probe").getByRole("link", { name: "Edit in Studio" }).click();
    await expect(page).toHaveURL(new RegExp(`/build/agents/${name}$`, "u"));
    await page.getByRole("textbox", { name: /^Display name/u }).fill("Renamed Probe");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toHaveCount(0);

    // Back on the Agents page without a reload, the card carries the saved name.
    await rail(page).getByRole("button", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL(/\/w\/[^/]+\/agents$/u);
    await expect(card(page, "Renamed Probe")).toBeVisible();
    await expect(card(page, "Rename Probe")).toHaveCount(0);
  } finally {
    await remove();
  }
});

test("a builder who cancels a new agent stays on the Agents page", async ({
  page,
  instanceAgents: _instanceAgents
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, builder);
  await openAgents(page);
  const agentsUrl = page.url();

  // The dialog opens on the page itself, and Cancel, Escape and the close button leave the
  // reader where they were.
  const newAgent = page.getByRole("button", { name: "New agent", exact: true });
  const dialog = page.getByRole("dialog", { name: "New agent", exact: true });
  await newAgent.click();
  await expect(dialog).toBeVisible();
  expect(page.url()).toBe(agentsUrl);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toBe(agentsUrl);
  await expect(card(page, DEFAULT_AGENT)).toBeVisible();
  // The focus returns to the button that opened the dialog, whichever way it was left.
  await expect(newAgent).toBeFocused();

  await newAgent.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toBe(agentsUrl);
  await expect(newAgent).toBeFocused();

  await newAgent.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(page.url()).toBe(agentsUrl);
  await expect(newAgent).toBeFocused();

  // Continue leads to Studio with the new agent's page, named as typed; nothing is stored
  // before it is created there.
  await newAgent.click();
  await dialog.getByRole("textbox", { name: /^Display name/u }).fill("Not Yet Stored");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page).toHaveURL(/\/build\/agents$/u);
  await expect(page.getByRole("heading", { level: 1, name: "Not Yet Stored" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Display name/u })).toHaveValue("Not Yet Stored");
  expect((await page.request.get(agentPath("not_yet_stored"))).status()).toBe(404);
});
