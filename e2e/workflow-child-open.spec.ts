import { requestWithOrigin } from "./request-with-origin";
import { shootSurface } from "./surface-shots";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";

const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

// EW-13: a `workflow` step opens the Workflow it starts as a Workflow of its own, and in a run
// the run it started. A reader who may not read that Workflow sees that it is one and nothing
// of it. Over the sample Workflows of `/ui-library/workflows`, on a phone, light and dark.

for (const scheme of ["light", "dark"] as const) {
  test(`"Open" on a child Workflow step leads to the child and to its run, at 390 px ${scheme}`, async ({
    page
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });

    // The step names the Workflow it starts and opens it as a Workflow of its own.
    const canvas = await openSample(page, "quarter-close");
    const panel = await openStep(page, canvas, "remind");
    await expect(panel).toContainText("Send reminders");
    await shootSurface(page, `workflow-child-step-${scheme}-390`, async () => {
      await expect(panel).toBeVisible();
    });
    await panel.getByRole("button", { name: "Open the workflow" }).click();
    await expect(page).toHaveURL(/at=quarter-close%2Fopen%2Fsend-reminders/u);
    const child = page.getByTestId("workflow-canvas");
    await expect(child.locator('[data-flow-id="open_findings"]')).toBeAttached();
    const way = page.getByRole("navigation", { name: "Where you are" });
    await expect(way).toContainText("Quarter close");
    await expect(way).toContainText("Send reminders");
    await shootSurface(page, `workflow-child-opened-${scheme}-390`, async () => {
      await expect(child.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
    });
    // The browser's way back leads to the parent.
    await page.goBack();
    await expect(page).toHaveURL(/at=quarter-close(&|$)/u);

    // In a run the same step leads to the run it started.
    const run = await openSample(page, "quarter-close/runs/run-quarter");
    const runPanel = await openStep(page, run, "remind");
    await runPanel.getByRole("tab", { name: "This run", exact: true }).click();
    await runPanel.getByRole("button", { name: "Open its run" }).click();
    await expect(page).toHaveURL(/at=send-reminders%2Fruns%2Frun-reminders/u);
    await expect(page.getByTestId("workflow-run-page")).toBeVisible();
  });

  test(`a child Workflow the reader may not read is named by its kind and does not open, at 390 px ${scheme}`, async ({
    page
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 390, height: 844 });

    const canvas = await openSample(page, "quarter-close", "en", "&hide=send-reminders");
    const node = canvas.locator('[data-slot="flow-node"][data-flow-id="remind"]');
    await expect(node).toContainText("Starts a workflow you may not read");
    // Neither its name nor "Open": the node keeps the step's own name and says why.
    await expect(node.locator('[data-slot="flow-chip"]')).toHaveCount(0);
    await expect(node.locator('[data-slot="flow-action"]')).toHaveCount(0);
    const panel = await openStep(page, canvas, "remind");
    await expect(panel.locator("[data-child-hidden]")).toHaveText("A workflow you may not read");
    await expect(panel).toContainText("Starts a workflow you may not read");
    await expect(panel.getByRole("button", { name: "Open the workflow" })).toHaveCount(0);
    await shootSurface(page, `workflow-child-hidden-${scheme}-390`, async () => {
      await expect(panel).toBeVisible();
    });

    // Its run neither opens from the parent's run.
    const run = await openSample(
      page,
      "quarter-close/runs/run-quarter",
      "en",
      "&hide=send-reminders"
    );
    const runPanel = await openStep(page, run, "remind");
    await runPanel.getByRole("tab", { name: "This run", exact: true }).click();
    await expect(runPanel.getByRole("button", { name: "Open its run" })).toHaveCount(0);
  });
}

/** Opens one address of the samples page and waits until its canvas has laid out the graph. */
async function openSample(page: Page, at: string, lang = "en", extra = ""): Promise<Locator> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: adminUser.email, password: adminUser.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto(`/ui-library/workflows?lang=${lang}&at=${at}${extra}`);
  const canvas = page.getByTestId("workflow-canvas");
  await expect(canvas.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
  return canvas;
}

/** Selects a step on the canvas and waits for its panel, a bottom sheet on a phone. */
async function openStep(page: Page, canvas: Locator, stepId: string): Promise<Locator> {
  // Fitted to a phone the graph is drawn compact: a press on the node opens it.
  await canvas.locator(`[data-slot="flow-node"][data-flow-id="${stepId}"]`).click();
  const panel = page.locator(`[data-step-panel="${stepId}"]`);
  await expect(panel).toBeVisible();
  return panel;
}
