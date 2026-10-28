import { requestWithOrigin } from "./request-with-origin";
import { shootSurface } from "./surface-shots";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";

const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

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

test("a run of three analyses at the same time shows them side by side, and its replay shows them overlap", async ({
  page
}) => {
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width < 600 ? 844 : 860 });
    const canvas = await openSample(page, "monthly-analysis/runs/run-analysis", "de");
    const block = canvas.locator('[data-slot="flow-group"][data-flow-id="analyses"]');
    await expect(block.locator('[data-slot="flow-lane"]')).toHaveText([
      /Umsatz/u,
      /Kosten/u,
      /Risiken/u
    ]);
    await expect(block.locator('[data-slot="flow-join-label"]')).toHaveText(
      "Weiter, wenn alle fertig sind"
    );
    // The lanes say how long each path took, to the second as the timeline does; the costs,
    // two steps long, took longest.
    await expect(block.locator('[data-lane-id="costs"]')).toContainText("3 Min. 33 Sek.");
    const step = (id: string) => boxOf(canvas.locator(`[data-flow-id="${id}"]`));
    const [revenue, costs, risks] = await Promise.all([
      step("revenue_trend"),
      step("cost_groups"),
      step("risk_rating")
    ]);
    if (width >= 600) {
      // Side by side: the first step of each lane on one line, one column after the other.
      expect(Math.abs(revenue.top - costs.top)).toBeLessThan(2);
      expect(Math.abs(costs.top - risks.top)).toBeLessThan(2);
      expect(revenue.right).toBeLessThan(costs.left);
      expect(costs.right).toBeLessThan(risks.left);
    } else {
      // Too narrow for two columns: the lanes stand one under the other.
      expect(revenue.bottom).toBeLessThan(costs.top);
      expect(costs.bottom).toBeLessThan(risks.top);
    }
    // The chain of risk tests is one fork with three ways out.
    await expect(canvas.locator('[data-flow-id="high_risk"]')).toContainText("Sonst wenn");
    await expect(canvas.locator('[data-slot="flow-node"][data-flow-id="medium_risk"]')).toHaveCount(
      0
    );

    // The timeline: the three paths begin at the same moment, and the costs bar is longest.
    const replay = page.locator("[data-run-replay]");
    await replay.locator("[data-replay-open]").click();
    const timeline = replay.getByRole("list", { name: "Zeitverlauf des Laufs" });
    const bar = (id: string) =>
      boxOf(timeline.locator(`[data-row-id="${id}"] [data-slot="timeline-bar"]`));
    const [revenueBar, costsBar, risksBar] = await Promise.all([
      bar("analyses/revenue"),
      bar("analyses/costs"),
      bar("analyses/risks")
    ]);
    expect(Math.abs(revenueBar.left - costsBar.left)).toBeLessThan(1);
    expect(Math.abs(costsBar.left - risksBar.left)).toBeLessThan(1);
    expect(costsBar.right).toBeGreaterThan(revenueBar.right);
    expect(revenueBar.right).toBeGreaterThan(risksBar.right);

    // Played back to the moment after the load, the three analyses run at once.
    await replay.getByRole("button", { name: "Zum Anfang" }).click();
    await replay.locator("[data-replay-forward]").click();
    await expect(replay.locator("[data-replay-moment]")).toContainText("Zeitpunkt 2 von 9");
    await expect(replay.locator("[data-replay-moment]")).toContainText(
      "Beginnt: Analysen, Umsatz analysieren, Kosten gruppieren, Risiken bewerten"
    );
    for (const lane of ["revenue", "costs", "risks"]) {
      await expect(block.locator(`[data-lane-id="${lane}"]`)).toHaveAttribute(
        "data-status",
        "running"
      );
    }
    for (const id of ["revenue_trend", "cost_groups", "risk_rating"]) {
      await expect(canvas.locator(`[data-flow-id="${id}"]`)).toHaveAttribute(
        "data-status",
        "running"
      );
    }
    await expect(canvas.locator('[data-flow-id="cost_outliers"]')).toHaveAttribute(
      "data-status",
      "idle"
    );
    await shootSurface(page, `workflow-parallel-replay-de-${width}`, async () => {
      await expect(canvas.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
    });
    // The whole run again: every lane is through.
    await replay.getByRole("button", { name: "Ganzer Lauf" }).click();
    await expect(block.locator('[data-lane-id="costs"]')).toHaveAttribute("data-status", "done");
    await shootSurface(page, `workflow-parallel-run-de-${width}`, async () => {
      await expect(canvas.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
    });

    // The inner test of the chain is a row of the fork that opens its own panel and says
    // how it went.
    const fork = canvas.locator('[data-slot="flow-node"][data-flow-id="high_risk"]');
    const mediumRow = fork.locator('[data-exit="medium_risk:then"]');
    await expect(mediumRow).toHaveAttribute("data-status", "done");
    await expect(mediumRow).toContainText("Sonst wenn: Mittleres Risiko?");
    await mediumRow.locator('[data-slot="flow-row-open"]').click();
    const panel = page.locator('[data-step-panel="medium_risk"]');
    await expect(panel).toContainText("Mittleres Risiko?");
    await expect(mediumRow).toHaveAttribute("data-selected", "");
    await expect(fork).not.toHaveAttribute("data-selected", "");
    // The view brings the fork the row stands in clear of the panel.
    await expect
      .poll(async () => {
        const [row, sheet] = await Promise.all([boxOf(mediumRow), boxOf(panel)]);
        return width >= 600 ? row.right <= sheet.left : row.bottom <= sheet.top;
      })
      .toBe(true);
    await shootSurface(page, `workflow-else-chain-de-${width}`, async () => {
      await expect(panel).toBeVisible();
    });
    // The first test is the fork itself, with a panel of its own.
    await fork.locator('[data-slot="flow-main"]').click();
    await expect(page.locator('[data-step-panel="high_risk"]')).toBeVisible();
    await expect(mediumRow).not.toHaveAttribute("data-selected", "");
    await page.keyboard.press("Escape");
  }
});

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
async function openSample(page: Page, at: string, lang = "en"): Promise<Locator> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: adminUser.email, password: adminUser.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto(`/ui-library/workflows?lang=${lang}&at=${at}`);
  const canvas = page.getByTestId("workflow-canvas");
  await expect(canvas.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
  return canvas;
}
