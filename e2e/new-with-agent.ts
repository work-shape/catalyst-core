import type { Page } from "@playwright/test";

/**
 * Presses a New of a kind no person writes by hand, such as Workflows and Apps, or the empty
 * list's "Build one with the agent". New asks what the new one should do first: its
 * "Build with the agent" then opens the dock with the kind's started sentence. The empty list's
 * offer opens the dock at once.
 */
export async function newWithAgent(page: Page, name: RegExp | string): Promise<void> {
  await page.getByRole("button", { name }).first().click();
  const brief = page
    .getByRole("dialog")
    .filter({ has: page.locator("[data-build-with-agent-brief]") });
  if ((await brief.count()) > 0) {
    await brief
      .getByRole("button", { name: /^(?:Build with the agent|Mit dem Agenten bauen)$/u })
      .click();
  }
}
