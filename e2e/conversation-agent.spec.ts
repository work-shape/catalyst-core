import type { Page } from "@playwright/test";
import { z } from "zod";
import { test } from "./chat-fixtures";
import { shootSurface } from "./surface-shots";
import { expect } from "./test";

// T30: a conversation keeps the agent it was held with. The pick for a new conversation stays
// with new ones, a pick in one conversation stays in it, and after a switch or a reload each
// conversation shows and runs with its own agent. Fails where the agent is one state of the
// page: the older conversation then shows the agent picked last.

const FIRST = { name: "application_assistant", label: "Application Assistant" };

const SECOND = { name: "research_assistant", label: "Research Assistant" };

const headerAgent = (page: Page) =>
  page.locator("header").getByRole("button", { name: /^Agent auswählen:/u });

const startPageAgent = (page: Page) =>
  page.getByRole("region", { name: "Chat" }).getByRole("button", { name: /^Agent auswählen/u });

const runRequestSchema = z.object({ agentName: z.string().optional() });

const composer = (page: Page) => page.getByPlaceholder("Nachricht", { exact: true });

async function send(page: Page, text: string): Promise<{ agentName?: string }> {
  const request = page.waitForRequest(
    (candidate) =>
      candidate.method() === "POST" &&
      /^\/api\/v1\/conversations(?:\/[^/]+)?\/runs$/u.test(new URL(candidate.url()).pathname)
  );
  await composer(page).fill(text);
  await composer(page).press("Enter");
  const body = runRequestSchema.parse((await request).postDataJSON());
  await expect(page.locator('[data-role="assistant"]').last()).toContainText(text);
  return body;
}

async function openConversation(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "Seitenleiste öffnen" }).click();
  await page.getByTestId("conversation-row").filter({ hasText: title }).click();
}

test("each conversation opens and answers with its own agent, after a switch and a reload", async ({
  page
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem("vivd-catalyst:locale", "de"));
  const stamp = Date.now();
  const firstText = `Erste Unterhaltung ${stamp}`;
  const secondText = `Zweite Unterhaltung ${stamp}`;

  await page.goto("/");
  await expect(startPageAgent(page)).toHaveAccessibleName(`Agent auswählen: ${FIRST.label}`);
  expect((await send(page, firstText)).agentName).toBe(FIRST.name);
  const firstUrl = page.url();
  await expect(headerAgent(page)).toHaveAccessibleName(`Agent auswählen: ${FIRST.label}`);

  // A new conversation with the other agent.
  await page.getByRole("button", { name: "Seitenleiste öffnen" }).click();
  await page.getByRole("button", { name: "Neuer Chat", exact: true }).first().click();
  await startPageAgent(page).click();
  await page.getByRole("option", { name: SECOND.label }).click();
  expect((await send(page, secondText)).agentName).toBe(SECOND.name);
  const secondUrl = page.url();
  expect(secondUrl).not.toBe(firstUrl);
  await expect(headerAgent(page)).toHaveAccessibleName(`Agent auswählen: ${SECOND.label}`);

  // Back and forth: each shows its own agent, twice.
  for (let round = 0; round < 2; round += 1) {
    await openConversation(page, firstText);
    await expect(page).toHaveURL(firstUrl);
    await expect(headerAgent(page)).toHaveAccessibleName(`Agent auswählen: ${FIRST.label}`);
    await openConversation(page, secondText);
    await expect(page).toHaveURL(secondUrl);
    await expect(headerAgent(page)).toHaveAccessibleName(`Agent auswählen: ${SECOND.label}`);
  }
  await shootSurface(page, "t30-switch-second-390-de", () =>
    expect(headerAgent(page)).toHaveAccessibleName(`Agent auswählen: ${SECOND.label}`)
  );
  await openConversation(page, firstText);
  await shootSurface(page, "t30-switch-first-390-de", () =>
    expect(headerAgent(page)).toHaveAccessibleName(`Agent auswählen: ${FIRST.label}`)
  );
  // Sending continues with the conversation's agent.
  expect((await send(page, `${firstText} weiter`)).agentName).toBe(FIRST.name);

  // A reload reads the agent from the conversation.
  await page.goto(secondUrl);
  await expect(headerAgent(page)).toHaveAccessibleName(`Agent auswählen: ${SECOND.label}`);
  await page.goto(firstUrl);
  await shootSurface(page, "t30-reload-390-de", () =>
    expect(headerAgent(page)).toHaveAccessibleName(`Agent auswählen: ${FIRST.label}`)
  );
  // After the reload a new conversation starts with the default: no conversation's agent
  // carries over into it.
  await page.getByRole("button", { name: "Seitenleiste öffnen" }).click();
  await page.getByRole("button", { name: "Neuer Chat", exact: true }).first().click();
  await expect(startPageAgent(page)).toHaveAccessibleName(`Agent auswählen: ${FIRST.label}`);
});
