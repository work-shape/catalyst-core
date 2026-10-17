import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { removeServicePrincipal } from "./connection-fixtures";
import { requestWithOrigin } from "./request-with-origin";
import type { Locator, Page, Route } from "@playwright/test";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

test("an unpublished Workflow names its configured account under the heading in both locales", async ({
  page,
  accessState: _accessState
}) => {
  const id = `e2e-runas-${randomUUID().slice(0, 8)}`;
  const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: {
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    {
      data: { displayLabel: "Draft automation", permissions: ["config_assets.read"] }
    }
  );
  expect(created.ok()).toBe(true);
  const { principal }: { principal: { id: string; name: string } } = await created.json();
  try {
    const saved = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: id,
          manifest: {
            id,
            name: "Draft account check",
            runAs: principal.name,
            inputs: { type: "object", additionalProperties: false },
            outputs: {
              type: "object",
              properties: { done: { type: "integer" } },
              required: ["done"]
            },
            steps: [
              { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
              { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
            ]
          }
        }
      }
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const workspace = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workspaces/personal`,
      {}
    );
    expect(workspace.ok()).toBe(true);
    const personal: { id: string } = await workspace.json();
    await page.setViewportSize({ width: 1280, height: 900 });
    for (const locale of ["en", "de"]) {
      await page.goto("/");
      await page.evaluate(
        (language) => window.localStorage.setItem("vivd-catalyst:locale", language),
        locale
      );
      await page.goto(`/w/${personal.id}/workflows/${id}`);
      const workflow = page.getByTestId("workflow-page");
      await expect(workflow.getByRole("heading", { level: 1 })).toHaveText("Draft account check");
      await expect(workflow.locator("[data-workflow-draft]")).toHaveAttribute(
        "data-workflow-draft",
        "unpublished"
      );
      await expect(
        workflow.getByText(
          locale === "de" ? "Läuft als Draft automation" : "Runs as Draft automation"
        )
      ).toBeVisible();
      if (process.env.E2E_SHOTS_DIR) {
        await mkdir(process.env.E2E_SHOTS_DIR, { recursive: true });
        await page.screenshot({
          path: join(process.env.E2E_SHOTS_DIR, `workflow-draft-head-${locale}-1280.png`),
          animations: "disabled"
        });
      }
    }
  } finally {
    await requestWithOrigin(page, "post", `${assetUrl}/delete`, { data: { expectedRevision: 1 } });
    await removeServicePrincipal(principal.id);
  }
});

interface Box {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// The Workflow pages over the sample Workflows and runs of `/ui-library/workflows`, which hold
// every state of the drawing whatever the instance's own Workflows are.

test("a Workflow opens with all of its drawing in view: the loop, the two paths and the parallel part", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = await openSample(page, "quarter-close");

  await expect(
    canvas.locator('[data-slot="flow-group"][data-flow-id="each_client"]')
  ).toBeVisible();
  await expect(canvas.locator('[data-slot="flow-group"][data-flow-id="at_once"]')).toBeVisible();
  await expect(canvas.locator('[data-flow-id="any_findings"]')).toBeVisible();
  const frame = await boxOf(canvas);
  const parts = await partsOf(canvas);
  expect(parts.length).toBeGreaterThanOrEqual(12);
  expect(
    parts
      .filter(
        (part) =>
          part.left < frame.left ||
          part.top < frame.top ||
          part.right > frame.right ||
          part.bottom > frame.bottom
      )
      .map((part) => part.id)
  ).toEqual([]);
  // The canvas carries no mark of the library it is drawn with.
  await expect(canvas.locator(".react-flow__attribution")).toHaveCount(0);
});

test("a Workflow a step opens has its own address: Back leads one level up and the start is the child's", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = await openSample(page, "quarter-close");
  const trail = page.locator('[data-slot="breadcrumb"]');
  const heading = page.getByRole("heading", { level: 1 });
  await expect(trail).toHaveCount(0);

  await canvas
    .locator('[data-flow-id="remind"]')
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(page).toHaveURL(/at=quarter-close%2Fopen%2Fsend-reminders/u);
  await expect(trail.locator('[aria-current="page"]')).toHaveText("Send reminders");
  await expect(heading).toHaveText("Send reminders");
  const child = page.getByTestId("workflow-canvas");
  await expect(child.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
  await expect(child.locator('[data-flow-id="open_findings"]')).toBeVisible();
  await expect(child.locator('[data-flow-id="each_client"]')).toHaveCount(0);

  // The start asks about the Workflow that is shown, not the one the reader came from.
  await page.getByRole("button", { name: "Start now", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Send reminders");
  await expect(dialog).not.toContainText("Quarter close");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.goBack();
  await expect(trail).toHaveCount(0);
  await expect(heading).toHaveText("Quarter close");
  await expect(
    page.getByTestId("workflow-canvas").locator('[data-flow-id="each_client"]')
  ).toBeVisible();

  await page.goForward();
  await expect(heading).toHaveText("Send reminders");
  await trail.getByRole("link", { name: "Quarter close", exact: true }).click();
  await expect(heading).toHaveText("Quarter close");
});

test("a done step shows what it returned as rows, and a failed run dims what it did not reach", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const done = await openSample(page, "monthly-booking-check/runs/run-done");
  await done.locator('[data-flow-id="clients"]').click();
  const panel = done.locator('[data-step-panel="clients"]');
  await panel.getByRole("tab", { name: "This run", exact: true }).click();
  await expect(panel).toContainText("600 to “For each client”");
  const output = panel.locator("[data-step-output]");
  await expect(output.getByRole("columnheader")).toHaveText(["Number", "Name", "Client since"]);
  await expect(output.getByRole("row")).toHaveCount(7);
  await expect(output).toContainText("Nordlicht GmbH");
  // The loop's failed share stands in the failure colour.
  await expect(done.locator('[data-slot="flow-failed"]')).toHaveText("3 failed");

  const failed = await openSample(page, "monthly-booking-check/runs/run-failed");
  await expect(failed.locator('[data-flow-id="each_client"]')).toHaveAttribute(
    "data-status",
    "skipped"
  );
  await expect(failed.locator('[data-flow-id="result"]')).toHaveAttribute("data-status", "skipped");
  // A run says who started it; how else it could start belongs to the Workflow's own page.
  await expect(failed.locator('[data-flow-id="start"]')).not.toContainText("someone starts it");
});

test("folding a loop leaves it where it was, and the entries' filter stays above the list", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = await openSample(page, "monthly-booking-check/runs/run-running");
  const loop = canvas.locator('[data-slot="flow-group"][data-flow-id="each_client"]');
  const before = await boxOf(loop);
  await loop.locator('[data-slot="flow-fold"]').click();
  await expect(loop).toHaveAttribute("data-collapsed", "");
  await expect
    .poll(async () => {
      const after = await boxOf(loop);
      return Math.abs(after.left - before.left) < 1 && Math.abs(after.top - before.top) < 1;
    })
    .toBe(true);
  await loop.locator('[data-slot="flow-fold"]').click();
  await expect(canvas.locator('[data-flow-id="bookings"]')).toBeVisible();
  const again = await boxOf(loop);
  expect(Math.abs(again.left - before.left)).toBeLessThan(1);
  expect(Math.abs(again.top - before.top)).toBeLessThan(1);

  await loop.getByRole("button", { name: "Show the 3 failed", exact: true }).click();
  const entries = canvas.locator("[data-loop-entries]");
  await entries.getByRole("radio", { name: /All/u }).click();
  const filter = entries.getByRole("radiogroup");
  const top = (await boxOf(filter)).top;
  await canvas.locator('[data-slot="side-panel-body"]').evaluate((body) => body.scrollTo(0, 600));
  // The filter stands at the top of what scrolls, and no row shows above it.
  const body = await boxOf(canvas.locator('[data-slot="side-panel-body"]'));
  const held = await boxOf(entries.locator(":scope > div").first());
  expect(Math.abs((await boxOf(filter)).top - top)).toBeLessThan(2);
  expect(Math.abs(held.top - body.top)).toBeLessThan(2);
});

test("the focus walks the steps, Enter opens the step's panel and Escape closes it", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = await openSample(page, "monthly-booking-check");
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-flow-id") ?? null);

  await canvas.locator('[data-flow-id="start"]').focus();
  await page.keyboard.press("Tab");
  expect(await focused()).toBe("clients");
  expect((await boxOf(canvas.locator('[data-flow-id="clients"]'))).left).toBeGreaterThan(
    (await boxOf(canvas.locator('[data-flow-id="start"]'))).left
  );
  const panel = canvas.locator('[data-slot="side-panel"]');
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-placement", "float");
  await expect(canvas.locator('[data-flow-id="clients"]')).toHaveAttribute("aria-current", "true");
  expect((await boxOf(canvas.locator('[data-flow-id="clients"]'))).right).toBeLessThanOrEqual(
    (await boxOf(panel)).left
  );
  await expect(canvas.locator('[data-step-panel="clients"]')).toContainText("Load the clients");
  await expect(canvas.locator('[data-step-panel="clients"]')).toContainText("Bookings");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(await focused()).toBe("clients");
});

test("a panel that opens is given room: no step stands under it, and closing it gives the room back", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = await openSample(page, "monthly-booking-check");
  const last = canvas.locator('[data-flow-id="result"]');
  const open = await boxOf(last);

  // The first step is in view wherever the panel stands, so nothing has to move for its sake.
  await canvas.locator('[data-flow-id="start"]').click();
  const panel = canvas.locator('[data-slot="side-panel"]');
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => {
      const edge = (await boxOf(panel)).left;
      return (await partsOf(canvas)).filter((part) => part.right > edge).map((part) => part.id);
    })
    .toEqual([]);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect.poll(async () => Math.round((await boxOf(last)).right)).toBe(Math.round(open.right));
});

test("a failed run opens on the step that failed, and a loop at work lists its failed entries", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const failed = await openSample(page, "monthly-booking-check/runs/run-failed");
  await expect(failed.locator('[data-flow-id="clients"]')).toHaveAttribute("data-status", "failed");
  await expect(failed.locator('[data-step-panel="clients"]')).toBeVisible();
  await expect(failed.locator('[data-step-panel="clients"]')).toContainText(
    "The workflow may not do this: its account lacks the right “connection.use”."
  );

  const running = await openSample(page, "monthly-booking-check/runs/run-running");
  const loop = running.locator('[data-slot="flow-group"][data-flow-id="each_client"]');
  await expect(loop).toContainText("212 of 600");
  // The steps of the loop are drawn once, with counts, whatever the number of clients.
  await expect(running.locator('[data-flow-id="bookings"]')).toHaveCount(1);
  await loop.getByRole("button", { name: "Show the 3 failed", exact: true }).click();
  const entries = running.locator("[data-loop-entries]");
  await expect(entries).toBeVisible();
  await expect(entries.getByRole("listitem")).toHaveCount(3);
});

test("a reader sees a Workflow and its runs, and no start and no cancel", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const start = page.getByRole("button", { name: "Start now" });
  // The same pages as one who may start: the control is there to be missed.
  await openSample(page, "monthly-booking-check");
  await expect(start).toBeVisible();

  const canvas = await openSample(page, "monthly-booking-check&as=reader");
  await expect(canvas.locator("[data-flow-id]").first()).toBeVisible();
  await expect(start).toHaveCount(0);

  await page.getByRole("link", { name: "Runs", exact: true }).click();
  await expect(page.getByTestId("workflow-runs-page")).toBeVisible();
  await expect(start).toHaveCount(0);

  await openSample(page, "monthly-booking-check/runs/run-running&as=reader");
  await expect(page.getByTestId("workflow-run-page")).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel run" })).toHaveCount(0);
  await openSample(page, "monthly-booking-check/runs/run-done&as=reader");
  await expect(page.getByRole("button", { name: "Run again" })).toHaveCount(0);
});

test("on a phone the Workflow runs top to bottom and a step opens as a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const canvas = await openSample(page, "monthly-booking-check");
  await expect
    .poll(async () => {
      const first = await boxOf(canvas.locator('[data-flow-id="start"]'));
      const second = await boxOf(canvas.locator('[data-flow-id="clients"]'));
      return second.top > first.bottom && Math.abs(second.left - first.left) < 1;
    })
    .toBe(true);

  // The controls stand on a strip the graph ends above, so they cover no step of a Workflow
  // taller than the screen.
  const strip = await boxOf(canvas.locator('[data-slot="flow-strip"]'));
  const controls = await boxOf(canvas.locator('[data-slot="flow-controls"]'));
  expect(controls.top).toBeGreaterThanOrEqual(strip.top);
  expect(controls.bottom).toBeLessThanOrEqual(strip.bottom + 1);

  // A Workflow too wide to be read at the phone's width opens whole.
  const large = await openSample(page, "quarter-close");
  const frame = await boxOf(large);
  const ground = await boxOf(large.locator('[data-slot="flow-strip"]'));
  expect(
    (await partsOf(large))
      .filter((part) => part.top < frame.top || part.bottom > ground.top || part.left < frame.left)
      .map((part) => part.id)
  ).toEqual([]);
  await openSample(page, "monthly-booking-check");

  await canvas.locator('[data-flow-id="clients"]').click();
  const panel = canvas.locator('[data-slot="side-panel"]');
  await expect(panel).toHaveAttribute("data-placement", "sheet");
  await expect
    .poll(async () => {
      const frame = await boxOf(canvas);
      const sheet = await boxOf(panel);
      return Math.abs(sheet.bottom - frame.bottom) < 1 && Math.abs(sheet.left - frame.left) < 1;
    })
    .toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
});

// A run whose step wrote a dataset (EW-12a). The Workflow is one of this test's own; the run and
// its step runs are answered by routes, since a run that writes a dataset needs a step that
// streams rows, which the suite's instance has no connector for. The answers are of the
// contract's shape, so the page maps and shows them as it would the instance's own.
test("a step that wrote a dataset says its rows, size and columns, and shows none of its rows", async ({
  page,
  accessState: _accessState
}) => {
  const id = `e2e-dataset-${randomUUID().slice(0, 8)}`;
  const runId = `wr_${id}`;
  const assetUrl = `${apiBaseUrl}/api/v1/assets/workflow/${id}`;
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: {
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { displayLabel: "Dataset automation", permissions: ["config_assets.read"] } }
  );
  expect(created.ok()).toBe(true);
  const { principal }: { principal: { id: string; name: string } } = await created.json();
  const times = {
    createdAt: "2026-10-12T09:00:00.000Z",
    startedAt: "2026-10-12T09:00:01.000Z",
    finishedAt: "2026-10-12T09:00:09.000Z"
  };
  const dataset = {
    id: "wds_e2e_clients",
    rowSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        since: { type: ["integer", "null"] },
        active: { type: "boolean" }
      },
      required: ["name"]
    },
    rowCount: 12_480,
    bytes: 3_355_443,
    state: "complete"
  };
  const reference = { $dataset: dataset.id, rowCount: dataset.rowCount, bytes: dataset.bytes };
  const output = JSON.stringify({ clients: reference });
  try {
    const saved = await requestWithOrigin(page, "put", assetUrl, {
      data: {
        expectedRevision: null,
        config: {
          name: id,
          manifest: {
            id,
            name: "Dataset export",
            runAs: principal.name,
            inputs: { type: "object", additionalProperties: false },
            outputs: { type: "object" },
            steps: [
              { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
              { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
            ]
          }
        }
      }
    });
    expect(saved.ok(), await saved.text()).toBe(true);
    const workspace = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workspaces/personal`,
      {}
    );
    expect(workspace.ok()).toBe(true);
    const personal: { id: string } = await workspace.json();

    // The API stands on another origin than the page, so an answer made here carries the CORS
    // headers the instance would send, or the browser refuses it and the page never draws.
    const answer = (route: Route, json: unknown) =>
      route.fulfill({
        json,
        headers: {
          "access-control-allow-origin": new URL(page.url()).origin,
          "access-control-allow-credentials": "true"
        }
      });
    // The client checks every answer against its operation's schema and reads a mismatch as a
    // server of another release, so each answer carries every field the contract requires.
    const stepRun = (stepId: string, stepType: string) => ({
      id: `wsr_${stepId}`,
      runId,
      stepId,
      stepType,
      key: stepId,
      status: "done",
      attempt: 1,
      ...times
    });
    await page.route(`**/api/v1/workflow-runs/${runId}`, (route) =>
      answer(route, {
        id: runId,
        workflow: id,
        definitionRevisionId: `${id}-revision`,
        mode: "live",
        trigger: "manual",
        status: "done",
        principal: { id: principal.id, name: principal.name, displayLabel: "Dataset automation" },
        startedBy: { kind: "user", id: "user_e2e", label: "Superadmin" },
        rootRunId: runId,
        depth: 0,
        stepRunCount: 2,
        deadlineAt: "2026-10-12T10:00:00.000Z",
        ...times,
        outputPreview: { text: output, truncated: false },
        datasets: [dataset]
      })
    );
    await page.route(`**/api/v1/workflow-runs/${runId}/steps?*`, (route) =>
      answer(route, {
        items: [
          stepRun("start", "trigger"),
          {
            ...stepRun("result", "output"),
            outputPreview: { text: output, truncated: false },
            datasets: [dataset]
          }
        ]
      })
    );

    const canvas = page.getByTestId("workflow-canvas");
    const panel = canvas.locator('[data-slot="side-panel"]');
    const result = canvas.locator('[data-flow-id="result"]');
    const datasets = panel.locator("[data-step-datasets]");
    const open = async () => {
      await page.goto(`/w/${personal.id}/workflows/${id}/runs/${runId}`);
      await expect(canvas.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
      // A run that ended without a failure opens on no step.
      await expect(panel).toHaveCount(0);
    };
    /** Opens the result step on what the run made of it, and reads its datasets. */
    const showDatasets = async () => {
      await result.click();
      await expect(canvas.locator('[data-step-panel="result"]')).toBeVisible();
      await panel.getByRole("tab", { name: "This run", exact: true }).click();
      await expect(datasets).toBeVisible();
      await expect(datasets.getByRole("heading", { name: "Datasets" })).toBeVisible();
      await expect(datasets).toContainText("Clients");
      await expect(datasets).toContainText("12,480 rows, 3.2 MB");
      const columns = datasets.getByRole("definition");
      await expect(datasets.getByRole("term")).toHaveText(["name", "since", "active"]);
      await expect(columns).toHaveText(["Text", "Whole number", "Yes or no"]);
      // The rows stay with the run: no table, no row, no download, and no internal id.
      await expect(panel.getByRole("table")).toHaveCount(0);
      await expect(panel.getByRole("row")).toHaveCount(0);
      await expect(panel.getByRole("button", { name: /download/iu })).toHaveCount(0);
      await expect(panel.getByText(dataset.id)).toHaveCount(0);
      await expect(
        panel.getByRole("button", { name: "Technical details", exact: true })
      ).toHaveAttribute("aria-expanded", "false");
    };

    await page.setViewportSize({ width: 1440, height: 900 });
    await open();
    await showDatasets();
    await expect(result).toHaveAttribute("aria-current", "true");
    // Another step of the run says nothing of the dataset; coming back shows it again.
    await canvas.locator('[data-flow-id="start"]').click();
    await expect(canvas.locator('[data-step-panel="start"]')).toBeVisible();
    await expect(result).not.toHaveAttribute("aria-current", "true");
    await expect(datasets).toHaveCount(0);
    await showDatasets();
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(result).not.toHaveAttribute("aria-current", "true");

    // On a phone the step opens as a sheet, and the dataset fits inside it.
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await showDatasets();
    await expect(panel).toHaveAttribute("data-placement", "sheet");
    await datasets.scrollIntoViewIfNeeded();
    const sheet = await boxOf(panel);
    const section = await boxOf(datasets);
    expect(section.left).toBeGreaterThanOrEqual(sheet.left);
    expect(section.right).toBeLessThanOrEqual(sheet.right + 1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    ).toBe(true);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);

    // In dark mode the panel is dark and the counts read on it at the contrast of body text.
    await page.emulateMedia({ colorScheme: "dark" });
    await page.setViewportSize({ width: 1440, height: 900 });
    await open();
    await expect
      .poll(() =>
        page
          .locator("main")
          .first()
          .evaluate((element) => element.classList.contains("dark"))
      )
      .toBe(true);
    await showDatasets();
    const [background, text] = await Promise.all([
      luminanceOf(panel, "backgroundColor"),
      luminanceOf(datasets.getByText("12,480 rows, 3.2 MB"), "color")
    ]);
    expect(background).toBeLessThan(0.2);
    expect((text + 0.05) / (background + 0.05)).toBeGreaterThanOrEqual(4.5);
  } finally {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await requestWithOrigin(page, "post", `${assetUrl}/delete`, { data: { expectedRevision: 1 } });
    await removeServicePrincipal(principal.id);
  }
});

/**
 * The relative luminance (0 dark to 1 light) of an element's computed colour. The colour is
 * painted on a canvas and read back, so any CSS colour form (`oklch`, `rgb`) is read alike.
 */
async function luminanceOf(
  locator: Locator,
  property: "color" | "backgroundColor"
): Promise<number> {
  return locator.evaluate((element, which) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d");
    if (context === null) {
      return Number.NaN;
    }
    context.fillStyle = getComputedStyle(element)[which];
    context.fillRect(0, 0, 1, 1);
    const [red = 0, green = 0, blue = 0] = context.getImageData(0, 0, 1, 1).data;
    const linear = (channel: number) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
  }, property);
}

async function boxOf(locator: Locator): Promise<Box> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      id: element.getAttribute("data-flow-id") ?? "",
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom
    };
  });
}

/** Every node frame and every group of a canvas, where it stands on the screen. */
async function partsOf(canvas: Locator): Promise<Box[]> {
  return canvas.locator("[data-flow-id]").evaluateAll((elements) =>
    elements.map((element) => {
      const frame = element.querySelector(':scope > [data-slot="flow-frame"]') ?? element;
      const box = frame.getBoundingClientRect();
      return {
        id: element.getAttribute("data-flow-id") ?? "",
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom
      };
    })
  );
}

/** Opens one address of the samples page and waits until its canvas has laid out the graph. */
async function openSample(page: Page, at: string): Promise<Locator> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: adminUser.email, password: adminUser.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto(`/ui-library/workflows?lang=en&at=${at}`);
  const canvas = page.getByTestId("workflow-canvas");
  await expect(canvas.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
  return canvas;
}
