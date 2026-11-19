import type { Locator, Page } from "@playwright/test";
import { expect } from "./test";

// The page of a Connection: its sign-in and what agents may do with it first, and everything
// else folded under Settings. The New connection dialog: the named services first, and an MCP
// server or a REST API folded under "Your own connection".

async function unfold(trigger: Locator): Promise<void> {
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

/**
 * Unfolds Settings, where the name, the address, the people, the availability and who may use
 * the Connection wait.
 */
export async function openConnectionSettings(page: Page): Promise<void> {
  await unfold(page.locator("[data-asset-settings-trigger]"));
}

/** Unfolds what one operation calls and takes, who may call it, and the way to take it off. */
export async function openOperationDetails(page: Page, operation: string): Promise<void> {
  await unfold(page.locator(`[data-connection-operation-more="${operation}"]`));
}

/** Unfolds the MCP server and the REST API in the New connection dialog. */
export async function openOwnConnection(dialog: Locator): Promise<void> {
  await unfold(dialog.locator("[data-connection-own-trigger]"));
}
