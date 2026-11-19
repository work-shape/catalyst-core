import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { openDataStoreAdvanced } from "./data-store-page";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Pictures of the page of a published Data Store, for a person to look at: its lead line, the
// rows of its first table with the switch to the second, the line of what uses it and the
// folded Settings, in German, light and dark, at 1280. It runs only with DS_PAGE_SHOTS=1 and
// writes to test-results/ds-page.
const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

const SHOTS = resolve("test-results/ds-page");
const TITLE = "Kundenanfragen";
const WORKFLOW = "Anfragen einlesen";

const REQUESTS = [
  ["A-1001", "Ines Albrecht", "Angebot für 40 Lizenzen", "offen", "2026-11-02"],
  ["A-1002", "Jonas Brandt", "Rückfrage zur Rechnung 2291", "beantwortet", "2026-11-03"],
  ["A-1003", "Mara Celik", "Termin für die Einführung", "offen", "2026-11-03"],
  ["A-1004", "Tobias Dorn", "Zugang für zwei neue Kolleginnen", "beantwortet", "2026-11-05"],
  ["A-1005", "Lea Engel", "Export der Daten als Tabelle", "in Arbeit", "2026-11-06"],
  ["A-1006", "Paul Fischer", "Vertrag um ein Jahr verlängern", "offen", "2026-11-09"],
  ["A-1007", "Nora Graf", "Schulung für das Vertriebsteam", "in Arbeit", "2026-11-10"],
  ["A-1008", "Emil Hartmann", "Neue Lieferadresse", "beantwortet", "2026-11-12"],
  ["A-1009", "Clara Imhoff", "Angebot für den Standort Nord", "offen", "2026-11-13"],
  ["A-1010", "Felix Jansen", "Frage zur Kündigungsfrist", "offen", "2026-11-16"]
] as const;

const storeFiles = (store: string) => [
  {
    path: "store.yaml",
    text: [
      `id: ${store}`,
      `name: ${TITLE}`,
      "description: Jede Anfrage einer Kundin oder eines Kunden mit ihrem Stand, und wer sie stellt.",
      ""
    ].join("\n")
  },
  {
    path: "migrations/0001_init.sql",
    text: [
      "create table anfragen (",
      "  nummer text primary key,",
      "  kunde text not null,",
      "  anliegen text not null,",
      "  stand text not null,",
      "  eingegangen date not null",
      ");",
      "create table kunden (",
      "  name text primary key,",
      "  ort text not null",
      ");",
      ""
    ].join("\n")
  }
];

/** A Workflow that adds rows to the store, so the page names something that uses it. */
const workflowConfig = (id: string, store: string) => ({
  name: id,
  manifest: {
    id,
    name: WORKFLOW,
    description: "Liest neue Anfragen ein.",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Von Hand starten", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "store",
        name: "Ablegen",
        type: "operation",
        operation: `data_store.${store}.insert`,
        input: {}
      },
      { id: "result", name: "Ergebnis", type: "output", input: {} }
    ]
  }
});

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

/** Opens the page in German and one theme, and waits for its rows. */
async function view(page: Page, store: string, theme: "light" | "dark"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(`/build/data-stores/${store}`);
  await page.evaluate((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:theme", chosen);
    window.localStorage.setItem("vivd-catalyst:build-scope", "instance");
  }, theme);
  await page.reload();
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
  await expect(page.locator('[data-data-store-rows="anfragen"] tbody tr')).toHaveCount(
    REQUESTS.length
  );
  await expect(page.locator("[data-data-store-used-by-line]")).toContainText(WORKFLOW);
}

/**
 * The whole page in one picture. The content scrolls inside the page, not the window, so the
 * window is made as tall as the content first.
 */
async function picture(page: Page, label: string): Promise<void> {
  const extra = await page.locator("[data-asset-settings]").evaluate((element) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const overflowY = getComputedStyle(parent).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        return parent.scrollHeight - parent.clientHeight;
      }
    }
    return 0;
  });
  await page.setViewportSize({ width: 1280, height: 900 + Math.max(0, extra) });
  await page.screenshot({
    path: resolve(SHOTS, `ds-page-${label}.png`),
    fullPage: true,
    animations: "disabled"
  });
}

test.describe("pictures of the page of a Data Store", () => {
  test.skip(process.env.DS_PAGE_SHOTS !== "1", "Runs only with DS_PAGE_SHOTS=1.");

  test("the page with two tables and ten rows, light, dark and with Settings open", async ({
    page
  }) => {
    test.setTimeout(180_000);
    const tag = randomUUID().replaceAll("-", "").slice(0, 8);
    const store = `shots-${tag}`;
    const workflow = `shots-flow-${tag}`;
    const storeUrl = `${apiBaseUrl}/api/v1/assets/data_store/${store}`;
    const workflowUrl = `${apiBaseUrl}/api/v1/assets/workflow/${workflow}`;
    await mkdir(SHOTS, { recursive: true });
    await signIn(page);
    const put = await requestWithOrigin(page, "put", storeUrl, {
      data: { expectedRevision: null, files: storeFiles(store) }
    });
    expect(put.ok(), await put.text()).toBe(true);
    try {
      const published = await requestWithOrigin(page, "post", `${storeUrl}/publish`, {
        data: { revision: 1 }
      });
      expect(published.ok(), await published.text()).toBe(true);
      await expect
        .poll(
          async () =>
            (await page.request.get(`${apiBaseUrl}/api/v1/data-stores/${store}/describe`)).status(),
          { timeout: 30_000 }
        )
        .toBe(200);
      const insert = (table: string, rows: Record<string, string>[]) =>
        requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/data-stores/${store}/insert`, {
          data: { table, rows }
        });
      const requests = await insert(
        "anfragen",
        REQUESTS.map(([nummer, kunde, anliegen, stand, eingegangen]) => ({
          nummer,
          kunde,
          anliegen,
          stand,
          eingegangen
        }))
      );
      expect(requests.ok(), await requests.text()).toBe(true);
      const customers = await insert(
        "kunden",
        REQUESTS.slice(0, 4).map(([, name], index) => ({
          name,
          ort: ["Leipzig", "Kassel", "Bremen", "Ulm"][index] ?? "Leipzig"
        }))
      );
      expect(customers.ok(), await customers.text()).toBe(true);
      const saved = await requestWithOrigin(page, "put", workflowUrl, {
        data: { expectedRevision: null, config: workflowConfig(workflow, store) }
      });
      expect(saved.ok(), await saved.text()).toBe(true);
      const live = await requestWithOrigin(page, "post", `${workflowUrl}/publish`, {
        data: { revision: 1 }
      });
      expect(live.ok(), await live.text()).toBe(true);

      for (const theme of ["light", "dark"] as const) {
        await view(page, store, theme);
        await picture(page, `de-${theme}`);
      }
      await view(page, store, "light");
      await openDataStoreAdvanced(page);
      await expect(page.locator('[data-data-store-table="anfragen"]')).toBeVisible();
      await picture(page, "de-light-settings");
    } finally {
      for (const assetUrl of [workflowUrl, storeUrl]) {
        if ((await page.request.get(assetUrl)).ok()) {
          await requestWithOrigin(page, "post", `${assetUrl}/delete`, {
            data: { expectedRevision: await assetRevision(page, assetUrl) }
          });
        }
      }
    }
  });
});
