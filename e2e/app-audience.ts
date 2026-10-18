import type { Locator } from "@playwright/test";
import { expect } from "./test";

/**
 * Answers "For whom?" in an App's Publish dialog with the owning workspace (SHARE-1): the second
 * choice in the instance's order. A first publish proposes "Only me", so a spec in which
 * another member uses the App says so here, and waits until Publish may be clicked again.
 */
export async function chooseWorkspaceAudience(dialog: Locator): Promise<void> {
  const choice = dialog.getByTestId("app-publish-audience").getByRole("radio").nth(1);
  await choice.click();
  await expect(choice).toBeChecked();
  await expect(
    dialog.getByRole("button", { name: /^(?:Publish|Veröffentlichen)$/u })
  ).toBeEnabled();
}
