import { requestWithOrigin } from "./request-with-origin";
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
