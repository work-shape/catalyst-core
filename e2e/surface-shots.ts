import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";

const shotsDir = process.env.E2E_SHOTS_DIR;

/** One picture of the journey as it stands, only when screenshots were requested. */
export async function shootSurface(
  page: Page,
  name: string,
  ready: () => Promise<void>,
  _widths?: readonly number[]
): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  await ready();
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}
