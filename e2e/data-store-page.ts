import type { Page } from "@playwright/test";
import { expect } from "./test";

// The page of a Data Store: its rows first, and everything else folded under Settings, the
// technical part under Advanced inside them.

async function unfold(page: Page, selector: string): Promise<void> {
  const trigger = page.locator(selector);
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

/** Unfolds Settings, where what fills the store and who reads it wait. */
export async function openDataStoreSettings(page: Page): Promise<void> {
  await unfold(page, "[data-asset-settings-trigger]");
}

/** Unfolds Advanced inside Settings: the status, the tables with their columns, the test copy. */
export async function openDataStoreAdvanced(page: Page): Promise<void> {
  await openDataStoreSettings(page);
  await unfold(page, "[data-data-store-advanced-trigger]");
}
