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

// The Workflow pages over the sample Workflows and runs of `/ui-library/workflows`: the
// instance runs no Workflow until the engine's slice is in.

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
  // The library's mark of the canvas it draws with stays on the page.
  await expect(canvas.locator(".react-flow__attribution")).toBeVisible();
});

test("a step that starts another Workflow opens it in place, and the trail leads back", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = await openSample(page, "quarter-close");
  const trail = page.locator('[data-slot="breadcrumb"]');
  await expect(trail).toHaveCount(0);

  await canvas
    .locator('[data-flow-id="remind"]')
    .getByRole("button", { name: "Open", exact: true })
    .click();
  await expect(trail).toBeVisible();
  await expect(trail.locator('[aria-current="page"]')).toHaveText("Send reminders");
  const child = page.getByTestId("workflow-canvas");
  await expect(child.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
  await expect(child.locator('[data-flow-id="open_findings"]')).toBeVisible();
  await expect(child.locator('[data-flow-id="each_client"]')).toHaveCount(0);

  await trail.getByRole("button", { name: "Quarter close", exact: true }).click();
  await expect(trail).toHaveCount(0);
  await expect(
    page.getByTestId("workflow-canvas").locator('[data-flow-id="each_client"]')
  ).toBeVisible();
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
  const panel = canvas.locator('[data-slot="side-panel"]');
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-placement", "float");
  await expect(canvas.locator('[data-step-panel="clients"]')).toContainText("Load the clients");
  await expect(canvas.locator('[data-step-panel="clients"]')).toContainText("Bookings");

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(await focused()).toBe("clients");
});

test("a failed run opens on the step that failed, and a loop at work lists its failed entries", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const failed = await openSample(page, "monthly-booking-check/runs/run-failed");
  await expect(failed.locator('[data-flow-id="clients"]')).toHaveAttribute("data-status", "failed");
  await expect(failed.locator('[data-step-panel="clients"]')).toBeVisible();
  await expect(failed.locator('[data-step-panel="clients"]')).toContainText(
    "The workflow may not do this: it lacks a right."
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

  await canvas.locator('[data-flow-id="clients"]').click();
  const panel = canvas.locator('[data-slot="side-panel"]');
  await expect(panel).toHaveAttribute("data-placement", "sheet");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
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
