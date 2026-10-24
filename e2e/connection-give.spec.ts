import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { ALLOWED_URL, plantConnection, removeConnection } from "./connection-fixtures";
import { signIn } from "./inbox-fixtures";
import { sendToolCall } from "./page-surface-fixtures";
import {
  assetBaseRevision,
  assetRevision,
  publishAgentDraft,
  readAgentDraft,
  readAsset,
  requestWithOrigin
} from "./request-with-origin";
import { expect, test } from "./test";

// "Einem Agenten geben" (CS-5d) in the conversation: the agent offers a card for a Connection's
// approved tools; the person picks the agent, sees it named with the tools, and confirms, which
// gives the agent the tools as one live revision (`agents.give_tools`). The agent of the same
// conversation calls the new tool from the next message. An agent with somebody else's draft
// gets the tools live too, and the draft keeps its author and content, gains the tools and can
// still be published. Fails without the change: a draft by somebody else refuses the give.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** Changes every agent of the instance, from `tests/fixtures/e2e-app.yaml`. */
const admin = { email: "e2e-admin@example.test", password: "e2e-admin-password" };
const OFFER_TOOL = "platform.connections.offer_to_agent";
const agentPath = (name: string) => `${apiBaseUrl}/api/v1/assets/agent/${name}`;

const toolNamesSchema = z.object({ toolNames: z.array(z.string()).optional() });

async function toolNamesOf(page: Page, name: string): Promise<string[]> {
  const asset = await readAsset(page, agentPath(name));
  return toolNamesSchema.parse(asset?.config ?? {}).toolNames ?? [];
}

function agentConfig(name: string, displayName: string, instructions: string) {
  return {
    name,
    displayName,
    description: "Answers with the tools of a fixture Connection.",
    modelBindingId: "primary",
    instructions,
    toolNames: [OFFER_TOOL]
  };
}

async function deleteAgent(page: Page, name: string): Promise<void> {
  const found = await page.request.get(agentPath(name));
  if (found.ok()) {
    await requestWithOrigin(page, "post", `${agentPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(page, agentPath(name)) }
    });
  }
}

test("the agent's offer gives a Connection's tools to the agent, which calls them in the same conversation", async ({
  page,
  browser,
  // The test stores an agent; the turn on the agents holds the one on the Namespaces.
  instanceAgentsChange: _instanceAgentsChange,
  // It plants a Connection no release config names.
  releaseConnections: _releaseConnections
}) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 8);
  const name = `e2e_give_${tag}`;
  const displayName = `Give probe ${tag}`;
  const connection = {
    id: `cfga_${randomUUID()}`,
    name: `e2e_${tag}`,
    displayName: "Sample business",
    url: ALLOWED_URL,
    authScheme: "none" as const,
    operations: [{ name: "echo", effect: "reading" as const, exposure: ["agent"], enabled: true }]
  };
  const echo = `connection.${connection.name}.echo`;
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page, superadmin);
  await plantConnection(connection);
  const stored = await requestWithOrigin(page, "put", agentPath(name), {
    data: {
      expectedRevision: await assetBaseRevision(page, agentPath(name)),
      availableIn: "all",
      config: agentConfig(name, displayName, "Help with the sample business.")
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
  const adminContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  try {
    expect(await toolNamesOf(page, name)).toEqual([OFFER_TOOL]);

    // A chat with the agent, from its card on the Agents page.
    await page.goto("/");
    await expect(page).toHaveURL(/\/w\/[^/]+/u);
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .getByRole("button", { name: "Agents", exact: true })
      .click();
    await page
      .getByRole("region", { name: "Agents" })
      .getByRole("listitem")
      .filter({ has: page.getByRole("heading", { name: displayName, exact: true }) })
      .getByRole("button", { name: "Start chat" })
      .click();
    await expect(page).toHaveURL(/\/w\/[^/]+$/u);

    // The agent offers the give; the card lists the tools and changes nothing yet.
    await sendToolCall(page, OFFER_TOOL, { connection: connection.name, agent: name });
    await expect(page).toHaveURL(/\/w\/[^/]+\/c\/[^/]+/u);
    const conversation = page.url();
    const card = page.locator(
      `[data-testid="connection-give-card"][data-connection="${connection.name}"]`
    );
    await expect(card.locator(`[data-connection-give-card-tool="${echo}"]`)).toBeVisible();
    expect(await toolNamesOf(page, name)).toEqual([OFFER_TOOL]);

    // The agent the agent named is chosen; the question names it and the tool.
    await card.locator("[data-connection-give]").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator(`[data-connection-give-agent="${name}"]`)).toBeVisible();
    await expect(dialog.getByRole("radio", { name: displayName })).toBeChecked();
    await dialog.locator("[data-connection-give-next]").click();
    const ask = dialog.locator(`[data-connection-give-ask="${name}"]`);
    await expect(ask).toContainText(`Give ${displayName} 1 tool of Sample business?`);
    await expect(ask.locator(`[data-connection-give-tool="${echo}"]`)).toBeVisible();
    await expect(ask).toContainText(`${displayName} gets these tools live at once.`);
    await expect(ask.locator("[data-connection-give-draft]")).toHaveCount(0);
    expect(await toolNamesOf(page, name)).toEqual([OFFER_TOOL]);

    // The confirmation publishes the agent with the tool, as one revision and no draft.
    const before = await assetRevision(page, agentPath(name));
    await dialog.locator("[data-connection-give-confirm]").click();
    await expect(dialog.locator('[data-connection-give-outcome="published"]')).toBeVisible();
    expect(await toolNamesOf(page, name)).toEqual([OFFER_TOOL, echo]);
    expect(await assetRevision(page, agentPath(name))).toBe(before + 1);
    expect(await readAgentDraft(page, agentPath(name))).toBeNull();
    await dialog.locator("[data-connection-give-done]").click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(card.locator("[data-connection-give-card-given]")).toContainText(
      `Given to ${displayName}.`
    );
    // The conversation hears it once, as the person, and its agent goes on by itself.
    await expect(
      page.getByText(
        `Local agent response: I received "${displayName} (${name}) now has 1 tool of Sample business (${connection.name}): ${echo}."`
      )
    ).toHaveCount(1);

    // In the same conversation, the agent calls the new tool from the next message.
    await sendToolCall(page, echo, { text: `given ${tag}` });
    expect(page.url()).toBe(conversation);
    await expect(page.getByText(`given ${tag}`).last()).toBeVisible();

    // Somebody else's draft: the give still goes live, and the draft stays theirs.
    await signIn(adminPage, admin);
    const live = await assetRevision(adminPage, agentPath(name));
    const drafted = await requestWithOrigin(adminPage, "put", agentPath(name), {
      data: {
        expectedRevision: live,
        expectedDraftRevision: null,
        config: agentConfig(name, displayName, "A draft of the admin.")
      }
    });
    expect(drafted.ok(), await drafted.text()).toBe(true);
    const adminDraft = await readAgentDraft(adminPage, agentPath(name));
    expect(adminDraft).not.toBeNull();

    const other = {
      ...connection,
      id: `cfga_${randomUUID()}`,
      name: `e2e_other_${tag}`,
      displayName: "Other business"
    };
    const otherEcho = `connection.${other.name}.echo`;
    await plantConnection(other);
    try {
      await sendToolCall(page, OFFER_TOOL, { connection: other.name, agent: name });
      const otherCard = page.locator(
        `[data-testid="connection-give-card"][data-connection="${other.name}"]`
      );
      await otherCard.locator("[data-connection-give]").click();
      await expect(dialog.locator(`[data-connection-give-agent="${name}"]`)).toBeVisible();
      await expect(dialog.getByRole("radio", { name: displayName })).toBeChecked();
      await dialog.locator("[data-connection-give-next]").click();
      const otherAsk = dialog.locator(`[data-connection-give-ask="${name}"]`);
      await expect(otherAsk).toContainText(`Give ${displayName} 1 tool of Other business?`);
      await expect(otherAsk.locator("[data-connection-give-draft]")).toContainText(
        `${displayName} has an unpublished draft. It stays unpublished as it is and gets these tools too.`
      );
      await dialog.locator("[data-connection-give-confirm]").click();
      await expect(dialog.locator('[data-connection-give-outcome="published"]')).toBeVisible();

      // Live: what was live plus the tool, as one revision.
      expect(await assetRevision(page, agentPath(name))).toBe(live + 1);
      expect(await toolNamesOf(page, name)).toEqual([OFFER_TOOL, echo, otherEcho]);
      const liveAsset = await readAsset(page, agentPath(name));
      expect(liveAsset?.config.instructions).toBe("Help with the sample business.");

      // The draft keeps its author and content, gains the tool, and is based on the new live.
      const after = await readAgentDraft(adminPage, agentPath(name));
      expect(after?.author.displayLabel).toBe(adminDraft?.author.displayLabel);
      expect(after?.config.instructions).toBe("A draft of the admin.");
      expect(after?.config.toolNames).toEqual([OFFER_TOOL, otherEcho]);
      expect(after?.baseRevision).toBe(live + 1);
      expect(after?.stale).toBe(false);
      await dialog.locator("[data-connection-give-done]").click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      // And it can still be published by its author.
      await publishAgentDraft(adminPage, agentPath(name));
      expect(await readAgentDraft(adminPage, agentPath(name))).toBeNull();
      expect(await toolNamesOf(page, name)).toEqual([OFFER_TOOL, otherEcho]);
    } finally {
      await removeConnection(other.id);
    }
  } finally {
    await adminContext.close();
    await deleteAgent(page, name);
    await removeConnection(connection.id);
  }
});
