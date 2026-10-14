import type { Locator, Page } from "@playwright/test";
import { expect } from "./test";

// The Tools section of an agent's page: a chip per package, per own tool and per Connection, a
// picker that adds the others, and a panel per chip with its tools (TOOLS-1).

/** The chip of a package (`package:<group>`), own tool (`own:<tool>`) or Connection. */
export const toolChip = (tools: Locator, key: string) =>
  tools.locator(`[data-tool-package="${key}"]`);

/** Adds what the picker offers under `label`, with all its tools on. */
export async function addToolPackage(page: Page, tools: Locator, label: string): Promise<void> {
  await tools.getByRole("button", { name: /^(Tools|Werkzeuge): / }).click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("option", { name: label }).first().click();
  await page.keyboard.press("Escape");
  await expect(picker).toBeHidden();
}

/** Opens a chip's panel and answers it. */
export async function openToolPackage(page: Page, tools: Locator, key: string): Promise<Locator> {
  const panel = page.locator(`[data-tool-panel="${key}"]`);
  await toolChip(tools, key).locator("button[aria-haspopup]").click();
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes the open panel. */
export async function closeToolPackage(page: Page): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-tool-panel]")).toHaveCount(0);
}

/** Removes a chip and every tool of it the agent can drop. */
export async function removeToolPackage(tools: Locator, key: string): Promise<void> {
  await toolChip(tools, key)
    .getByRole("button", { name: /^(Remove|Entfernen)$/u })
    .click();
  await expect(toolChip(tools, key)).toHaveCount(0);
}
