import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Pictures of the page of a Workflow, for a person to look at: its lead line, when it runs,
// "Start now", its steps on the canvas, its runs and its Settings, folded and with "Advanced"
// open, in German, light and dark, at 1280. The Workflow runs every Monday, has a few steps and
// one run. It runs only with WORKFLOW_PAGE_SHOTS=1 and writes to test-results/workflow-page
// (WORKFLOW_PAGE_SHOTS_DIR names another directory).
const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

const SHOTS = resolve(process.env.WORKFLOW_PAGE_SHOTS_DIR ?? "test-results/workflow-page");
const TITLE = "Wochenbericht";

const COUNT = `
import json, sys
json.load(sys.stdin)
with open("output.json", "w") as out:
    json.dump({"open": 12, "new": 4}, out)
`;
const REPORT = `
import json, sys
data = json.load(sys.stdin)
with open("output.json", "w") as out:
    json.dump({"report": f"{data['open']} offene Anfragen, davon {data['new']} neu."}, out)
`;

const workflowConfig = (id: string) => ({
  name: id,
  manifest: {
    id,
    name: TITLE,
    description:
      "Zählt jede Woche die offenen Anfragen und schreibt daraus einen kurzen Bericht für das Team.",
    inputs: { type: "object" },
    outputs: { type: "object", properties: { report: { type: "string", title: "Bericht" } } },
    limits: { duration: "2h" },
    steps: [
      {
        id: "start",
        name: "Start",
        type: "trigger",
        triggers: [
          { kind: "schedule", cron: "0 8 * * 1", timeZone: "Europe/Berlin" },
          { kind: "manual" }
        ]
      },
      {
        id: "count",
        name: "Anfragen zählen",
        description: "Zählt die offenen und die neuen Anfragen.",
        type: "code",
        file: "count.py",
        input: {},
        inputSchema: { type: "object" },
        outputSchema: { type: "object" }
      },
      {
        id: "report",
        name: "Bericht schreiben",
        description: "Fasst die Zahlen in einem Satz zusammen.",
        type: "code",
        file: "report.py",
        input: {
          open: { ref: { step: "count", path: "open" } },
          new: { ref: { step: "count", path: "new" } }
        },
        inputSchema: { type: "object" },
        outputSchema: { type: "object" }
      },
      {
        id: "result",
        name: "Ergebnis",
        type: "output",
        input: { report: { ref: { step: "report", path: "report" } } }
      }
    ]
  },
  files: [
    { path: "steps/count.py", content: COUNT },
    { path: "steps/report.py", content: REPORT }
  ]
});

async function signIn(page: Page): Promise<void> {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(signedIn.ok(), await signedIn.text()).toBe(true);
}

/** Opens one tab of the page in German and one theme, and waits for its name. */
async function view(page: Page, path: string, theme: "light" | "dark"): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await page.goto(path);
  await page.evaluate((chosen) => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
    window.localStorage.setItem("vivd-catalyst:theme", chosen);
  }, theme);
  await page.reload();
  await expect(page.getByRole("heading", { name: TITLE, level: 1 })).toBeVisible();
}

/**
 * The whole of a tab in one picture. Where its content scrolls inside the page, not the window,
 * the window is made as tall as the content first.
 */
async function picture(page: Page, label: string, content?: string): Promise<void> {
  if (content !== undefined) {
    const extra = await page.locator(content).evaluate((element) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        const overflowY = getComputedStyle(parent).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") {
          return parent.scrollHeight - parent.clientHeight;
        }
      }
      return 0;
    });
    await page.setViewportSize({ width: 1280, height: 900 + Math.max(0, extra) });
  }
  await page.screenshot({
    path: resolve(SHOTS, `workflow-page-${label}.png`),
    fullPage: true,
    animations: "disabled"
  });
}

test.describe("pictures of a Workflow's page", () => {
  test.skip(process.env.WORKFLOW_PAGE_SHOTS !== "1", "Runs only with WORKFLOW_PAGE_SHOTS=1.");

  test("de: the canvas light and dark, the runs, and the Settings folded and open", async ({
    page
  }) => {
    test.setTimeout(300_000);
    const id = `shots-${randomUUID().slice(0, 8)}`;
    const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
    await mkdir(SHOTS, { recursive: true });
    await signIn(page);
    const put = await requestWithOrigin(page, "put", assetUrl, {
      data: { expectedRevision: null, config: workflowConfig(id) }
    });
    expect(put.ok(), await put.text()).toBe(true);
    const published = await requestWithOrigin(page, "post", `${assetUrl}/publish`, {
      data: { revision: await assetRevision(page, assetUrl) }
    });
    expect(published.ok(), await published.text()).toBe(true);
    const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
      data: { name: `Büro ${id.slice(-4)}` }
    });
    expect(created.ok(), await created.text()).toBe(true);
    const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;

    // One run, ended, so the list of runs has a row.
    const started = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workflows/${id}/runs`,
      { data: {} }
    );
    expect(started.ok(), await started.text()).toBe(true);
    const runId = z.object({ id: z.string() }).parse(await started.json()).id;
    await expect
      .poll(
        async () =>
          z
            .object({ status: z.string() })
            .parse(
              await (await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`)).json()
            ).status,
        { timeout: 120_000 }
      )
      .toBe("done");

    const base = `/w/${workspaceId}/workflows/${id}`;
    for (const theme of ["light", "dark"] as const) {
      await view(page, base, theme);
      await expect(page.getByTestId("workflow-canvas")).toBeVisible();
      await expect(page.getByTestId("workflow-canvas")).toContainText("Bericht schreiben");
      await picture(page, `de-${theme}`);
    }
    await view(page, `${base}/runs`, "light");
    await expect(
      page.getByRole("list", { name: "Läufe" }).getByRole("listitem").first()
    ).toBeVisible();
    await picture(page, "de-light-runs");

    await view(page, `${base}/settings`, "light");
    await expect(page.locator("[data-workflow-settings]")).toBeVisible();
    await picture(page, "de-light-settings", "[data-workflow-settings]");
    // "Advanced" unfolds what the engine and other systems need, where the page folds it.
    const advanced = page.locator("[data-workflow-advanced-trigger]");
    if ((await advanced.count()) > 0) {
      await page.setViewportSize({ width: 1280, height: 900 });
      await advanced.click();
      await expect(advanced).toHaveAttribute("aria-expanded", "true");
      await picture(page, "de-light-settings-advanced", "[data-workflow-settings]");
      await view(page, `${base}/settings`, "dark");
      await page.locator("[data-workflow-advanced-trigger]").click();
      await picture(page, "de-dark-settings-advanced", "[data-workflow-settings]");
    }
  });
});
