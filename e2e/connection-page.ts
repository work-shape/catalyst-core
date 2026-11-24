import type { Locator } from "@playwright/test";
import { expect } from "./test";

// The page of a Connection: its sign-in and what agents may do with it first, and everything
// else folded under Settings. The New connection dialog: the named services first, and an MCP
// server or a REST API folded under "Your own connection".

async function unfold(trigger: Locator): Promise<void> {
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

/** Unfolds the MCP server and the REST API in the New connection dialog. */
export async function openOwnConnection(dialog: Locator): Promise<void> {
  await unfold(dialog.locator("[data-connection-own-trigger]"));
}
