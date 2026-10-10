import type { Page } from "@playwright/test";
import { expect } from "./test";

/**
 * Answers the conflict notice of a Build page: asks for the newer version and confirms that the
 * changes on the page go. The page then starts again from what the instance holds.
 */
export async function loadNewerVersion(page: Page): Promise<void> {
  await page
    .locator("[data-build-conflict]")
    .getByRole("button", { name: "Load the newer version", exact: true })
    .click();
  const question = page.getByRole("dialog", { name: "Load the newer version?", exact: true });
  await expect(question).toContainText("Changes on this page that are not saved are lost.");
  await question.getByRole("button", { name: "Load the newer version", exact: true }).click();
  await expect(question).toBeHidden();
}
