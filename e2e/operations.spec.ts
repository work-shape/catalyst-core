import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";

// Instance > Operations after reads stopped leaving runs: the page opens on the changing
// calls, an allowed read is on no view of it, and a read that failed is under the reads.
// Fails without OP-READS: the page had no filter for the effect, opened on every call, and
// every load of the interface left a row for `platform.context.get`.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;
/** No spec creates an agent of this name, so reading it fails with `NOT_FOUND`. */
const MISSING_AGENT = "op_reads_missing_agent";
const EFFECT_FILTER = /^(?:Filter by effect|Nach Wirkung filtern)$/u;

test("the Operations page opens on changing calls and lists a read only when it failed", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 180_000 : 60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);

  // An allowed read names no run. A read that fails names the run that records it.
  const context = await page.request.get(`${apiBaseUrl}/api/v1/context`);
  expect(context.status()).toBe(200);
  expect(context.headers()["operation-run-id"]).toBeUndefined();
  const failed = await page.request.get(`${apiBaseUrl}/api/v1/assets/agent/${MISSING_AGENT}`);
  expect(failed.status()).toBe(404);
  const failedRunId = failed.headers()["operation-run-id"];
  expect(failedRunId).toEqual(expect.any(String));

  // Build reads the context and lists the agents: reads that are allowed.
  await page.goto("/build/agents");
  await expect(page.getByRole("list", { name: "Agents" })).toBeVisible();

  const asked: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/v1/operations/runs") asked.push(url.search);
  });
  await page.goto("/settings/instance/operations");
  await expect(page.getByRole("heading", { name: "Operations", level: 1 })).toBeVisible();
  const effect = page
    .locator("[data-operation-run-filters]")
    .getByRole("combobox", { name: EFFECT_FILTER });
  const rows = page.locator("tr[data-operation-run-id]");
  const failedRow = page.locator(`tr[data-operation-run-id="${failedRunId}"]`);
  const listed = () => page.locator("tr[data-operation-run-id], [data-operation-runs-empty]");
  const allowedReads = rows.filter({ hasText: /platform\.context\.get|assets\.list/u });
  const readsNote = page.locator("[data-operation-runs-reads-note]");
  const READS_NOTE =
    /^(?:Successful reading calls are not recorded\. A reading call appears here only when it was refused, failed or was marked\.|Erfolgreiche lesende Aufrufe werden nicht aufgezeichnet\. Ein lesender Aufruf erscheint hier nur, wenn er abgelehnt wurde, fehlgeschlagen ist oder markiert war\.)$/u;

  // It opens on the changing calls and asks the server for nothing else.
  await expect(effect).toHaveValue("changing");
  await expect(listed().first()).toBeVisible();
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((search) => search.includes("effect=changing"))).toBe(true);
  await expect(failedRow).toHaveCount(0);
  await expect(allowedReads).toHaveCount(0);
  await expect(readsNote).toHaveCount(0);
  await shoot(page, "operations-default", async () => {
    await expect(listed().first()).toBeVisible();
  });

  // The reads: the one that failed is there, the allowed ones are on no view.
  await effect.selectOption("reading");
  await expect(failedRow).toHaveAttribute("data-status", "failed");
  await expect(failedRow).toContainText("assets.get");
  await expect(allowedReads).toHaveCount(0);
  await expect(readsNote).toHaveText(READS_NOTE);
  await shoot(page, "operations-reads", async () => {
    await effect.selectOption("reading");
    await expect(failedRow).toBeVisible();
    await expect(readsNote).toHaveText(READS_NOTE);
  });

  // An instance without a refused or failed read: the same sentence is the empty text, once.
  const noReads = /\/api\/v1\/operations\/runs\?.*effect=reading/u;
  await page.route(noReads, (route) => route.fulfill({ json: { items: [] } }));
  const empty = page.locator("[data-operation-runs-empty]");
  await shoot(page, "operations-reads-empty", async () => {
    await effect.selectOption("reading");
    await expect(empty).toContainText(
      /Successful reading calls are not recorded\.|Erfolgreiche lesende Aufrufe werden nicht aufgezeichnet\./u
    );
    await expect(readsNote).toHaveCount(0);
  });
  await effect.selectOption("reading");
  await expect(empty).toContainText("Successful reading calls are not recorded.");
  await expect(readsNote).toHaveCount(0);
  await page.unroute(noReads);

  await effect.selectOption({ index: 2 });
  await expect(effect).toHaveValue("");
  await expect(failedRow).toBeVisible();
  await expect(allowedReads).toHaveCount(0);
  await expect(readsNote).toHaveText(READS_NOTE);
  await shoot(page, "operations-all", async () => {
    await effect.selectOption({ index: 2 });
    await expect(failedRow).toBeVisible();
  });

  // Clearing the filters is the view the page opens with.
  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(effect).toHaveValue("changing");
  await expect(failedRow).toHaveCount(0);
});

/** The same view in both languages and both themes, 1280 wide. */
async function shoot(page: Page, name: string, ready: () => Promise<void>): Promise<void> {
  if (!shotsDir) return;
  await mkdir(shotsDir, { recursive: true });
  for (const locale of ["en", "de"] as const) {
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(
        ([localeValue, themeValue]) => {
          window.localStorage.setItem("vivd-catalyst:locale", localeValue);
          window.localStorage.setItem("vivd-catalyst:theme", themeValue);
        },
        [locale, theme] as const
      );
      await page.reload();
      await ready();
      await page.screenshot({ path: join(shotsDir, `${name}-${theme}-${locale}-1280.png`) });
    }
  }
  await page.evaluate(() => {
    window.localStorage.removeItem("vivd-catalyst:locale");
    window.localStorage.removeItem("vivd-catalyst:theme");
  });
  await page.reload();
  await ready();
}
