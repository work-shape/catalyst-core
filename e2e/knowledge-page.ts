import type { Page } from "@playwright/test";
import { expect } from "./test";

// The page of a Knowledge Base of documents: one line with Add documents, the list, and
// everything else folded under Settings.

/** Unfolds Settings, where the name, the availability, the status and the test search wait. */
export async function openKnowledgeSettings(page: Page): Promise<void> {
  const trigger = page.locator("[data-asset-settings-trigger]");
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

/**
 * Opens what Add documents offers. Where the instance offers synced sources the button is a
 * menu of both ways in; where it does not, it opens the Add dialog itself.
 */
export async function chooseAddDocuments(page: Page, way: "files" | "folder"): Promise<void> {
  await page.locator("[data-knowledge-add]").click();
  // Whether it is a menu is known once the Connections are read, so what opened is looked at.
  const item = page.locator(`[data-knowledge-add-${way}]`);
  const opened = way === "files" ? item.or(page.locator("[data-knowledge-upload]")).first() : item;
  await expect(opened).toBeVisible();
  if ((await item.count()) > 0) await item.click();
}
