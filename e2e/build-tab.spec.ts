import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { apiBaseUrl, reviewer, signIn } from "./inbox-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// UXA-3: Build in the dock on an existing agent's page holds an agent that builds, and its
// conversation is about that agent. It opened an empty chat with the picked agent instead,
// greeted "What should the new agent do?" with new-agent examples.

const shotsDir = process.env.E2E_SHOTS_DIR;
const chatColumn = (page: Page) => page.locator("[data-dock-chat]");

async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

test("Build beside an agent with a draft starts a conversation about that agent with the agent that builds", async ({
  page
}) => {
  await signIn(page, reviewer);
  await page.evaluate(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await page.setViewportSize({ width: 1440, height: 900 });
  const tag = randomUUID().replaceAll("-", "").slice(0, 8);
  const agent = `build_tab_${tag}`;
  const title = `Angebote ${tag}`;
  const agentUrl = `${apiBaseUrl}/api/v1/assets/agent/${agent}`;
  const config = (instructions: string) => ({
    name: agent,
    displayName: title,
    description: "Schreibt Angebote.",
    modelBindingId: "primary",
    instructions
  });
  const live = await requestWithOrigin(page, "put", agentUrl, {
    data: { expectedRevision: null, availableIn: "all", config: config("eins") }
  });
  expect(live.ok(), await live.text()).toBe(true);
  const { revision } = z
    .object({ revision: z.number() })
    .parse(await (await page.request.get(agentUrl)).json());
  // A second save writes the agent's draft: "Chat" beside it then opens Try.
  const draft = await requestWithOrigin(page, "put", agentUrl, {
    data: { expectedRevision: revision, expectedDraftRevision: null, config: config("zwei") }
  });
  expect(draft.ok(), await draft.text()).toBe(true);

  await page.goto(`/build/agents/${agent}`);
  await page.getByRole("button", { name: "Chat", exact: true }).click();
  const tabs = page.getByTestId("dock-tabs");
  await expect(tabs.getByRole("tab", { name: "Ausprobieren", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  await tabs.getByRole("tab", { name: "Bauen", exact: true }).click();
  await expect(tabs.getByRole("tab", { name: "Bauen", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  );
  // The conversation is about this agent, with the suite's agent that builds.
  await expect(chatColumn(page)).toContainText(`Was soll sich an „${title}“ ändern?`);
  await expect(page.getByTestId("dock-head")).toContainText("Application Assistant");
  await expect(page.getByTestId("dock-head")).toContainText(`Arbeitet an: ${title}`);
  await expect(chatColumn(page)).not.toContainText("Was soll der neue Agent tun?");
  await expect(chatColumn(page)).not.toContainText("Kundenfragen beantworten");
  await shoot(page, "build-tab-about-agent");
});
