import type { Locator } from "@playwright/test";
import { expect } from "./test";

// The Tools section of an agent's page: a row per package, per own tool and per Connection, with
// how many of its tools are on, a switch for all of them and its tools folded below (TOOLS-1).

/** The row of a package (`package:<group>`), own tool (`own:<tool>`) or Connection. */
export const toolRow = (tools: Locator, key: string) =>
  tools.locator(`[data-tool-package="${key}"]`);

/**
 * The switch of a row, which turns all its tools on or off. It can be partly on, so assistive
 * technology reads it as a tri-state check box.
 */
export const toolRowSwitch = (tools: Locator, key: string) =>
  toolRow(tools, key).getByRole("checkbox", { name: /^(All tools of|Alle Werkzeuge von) /u });

/** Turns all tools of a row on or off with its switch. */
export async function switchToolPackage(tools: Locator, key: string, on: boolean): Promise<void> {
  const control = toolRowSwitch(tools, key);
  await control.click();
  await expect(control).toHaveAttribute("aria-checked", on ? "true" : "false");
}

/** Folds a row's tools out and answers the row. */
export async function openToolPackage(tools: Locator, key: string): Promise<Locator> {
  const row = toolRow(tools, key);
  await row.locator("button[aria-expanded=false]").click();
  await expect(row.getByRole("group")).toBeVisible();
  return row;
}

/** Folds a row's tools away. */
export async function closeToolPackage(tools: Locator, key: string): Promise<void> {
  const row = toolRow(tools, key);
  await row.locator("button[aria-expanded=true]").click();
  await expect(row.getByRole("group")).toHaveCount(0);
}
