import { requestWithOrigin } from "./request-with-origin";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

interface Rect {
  id: string;
  group: boolean;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// The large example has a condition with two exits, a parallel part, a loop body and a subflow.
test("the large graph opens showing all of itself, and no part of it overlaps another", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = await openCanvas(page, "flow-large");

  const frame = await rectOf(canvas);
  const parts = await partsOf(canvas);
  // Every kind of structure is on the canvas.
  expect(parts.filter((part) => part.group).length).toBeGreaterThanOrEqual(2);
  expect(parts.filter((part) => !part.group).length).toBeGreaterThanOrEqual(10);
  await expect(canvas.locator('[data-slot="flow-row"]')).toHaveCount(2);
  await expect(canvas.locator('[data-slot="flow-stack"]')).toHaveCount(1);

  // Fit on open: nothing of the graph stands outside the canvas.
  expect(
    parts.filter(
      (part) =>
        part.left < frame.left ||
        part.top < frame.top ||
        part.right > frame.right ||
        part.bottom > frame.bottom
    )
  ).toEqual([]);

  // Two parts are apart, or one is a group that holds the other whole.
  const overlaps: string[] = [];
  for (const [index, a] of parts.entries()) {
    for (const b of parts.slice(index + 1)) {
      const apart =
        a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
      if (!apart && !(a.group && holds(a, b)) && !(b.group && holds(b, a))) {
        overlaps.push(`${a.id} / ${b.id}`);
      }
    }
  }
  expect(overlaps).toEqual([]);

  // The graph can be read but not rearranged: a drag on a node moves nothing against the others.
  const first = canvas.locator('[data-slot="flow-node"]').first();
  const second = canvas.locator('[data-slot="flow-node"]').nth(1);
  const gap = async () => (await rectOf(second)).left - (await rectOf(first)).left;
  const before = await gap();
  const start = await rectOf(first);
  await page.mouse.move(start.left + 20, start.top + 12);
  await page.mouse.down();
  await page.mouse.move(start.left + 120, start.top + 90, { steps: 6 });
  await page.mouse.up();
  expect(Math.abs((await gap()) - before)).toBeLessThan(0.5);
});

test("the focus walks the nodes in the order of the flow, Enter opens the panel and Escape closes it", async ({
  page
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const canvas = await openCanvas(page, "flow-large");
  const focused = () =>
    page.evaluate(() => document.activeElement?.getAttribute("data-flow-id") ?? null);

  const nodes = canvas.locator("[data-flow-id]");
  await nodes.first().focus();
  const start = await focused();
  expect(start).not.toBeNull();
  await page.keyboard.press("Tab");
  const next = await focused();
  expect(next).not.toBeNull();
  expect(next).not.toBe(start);
  // The node that follows stands further along the flow.
  const startBox = await rectOf(canvas.locator(`[data-flow-id="${start ?? ""}"]`));
  const nextBox = await rectOf(canvas.locator(`[data-flow-id="${next ?? ""}"]`));
  expect(nextBox.left).toBeGreaterThan(startBox.left);

  const panel = canvas.locator('[data-slot="side-panel"]');
  await expect(panel).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute("data-placement", "float");
  await expect(canvas.locator(`[data-flow-id="${next ?? ""}"]`)).toHaveAttribute(
    "aria-current",
    "true"
  );
  // The panel covers no part of the node it is about.
  const panelBox = await rectOf(panel);
  expect(
    (await rectOf(canvas.locator(`[data-flow-id="${next ?? ""}"]`))).right
  ).toBeLessThanOrEqual(panelBox.left);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  expect(await focused()).toBe(next);
});

test("below 600 px the graph runs top to bottom and the panel is a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const wide = await openCanvas(page, "flow-large");
  await expect(wide).toBeVisible();
  await page.setViewportSize({ width: 390, height: 800 });
  const canvas = page.locator('[data-gallery-sample="flow-large"] [data-slot="flow-canvas"]');
  await expect
    .poll(async () => {
      const parts = (await partsOf(canvas)).filter((part) => !part.group);
      const [first, second] = parts;
      return first && second
        ? second.top > first.bottom && Math.abs(second.left - first.left) < 1
        : false;
    })
    .toBe(true);

  await canvas.locator('[data-slot="flow-node"]').first().click();
  const panel = canvas.locator('[data-slot="side-panel"]');
  await expect(panel).toHaveAttribute("data-placement", "sheet");
  // The sheet rises into place, so its edges are read until they stand still.
  await expect
    .poll(async () => {
      const frame = await rectOf(canvas);
      const sheet = await rectOf(panel);
      return Math.abs(sheet.bottom - frame.bottom) < 1 && Math.abs(sheet.left - frame.left) < 1;
    })
    .toBe(true);
});

function holds(outer: Rect, inner: Rect): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.right <= outer.right &&
    inner.bottom <= outer.bottom
  );
}

async function rectOf(locator: Locator): Promise<Rect> {
  return locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      id: element.getAttribute("data-flow-id") ?? "",
      group: element.getAttribute("data-slot") === "flow-group",
      left: box.left,
      top: box.top,
      right: box.right,
      bottom: box.bottom
    };
  });
}

/** Every node frame and every group of a canvas, where it stands on the screen. */
async function partsOf(canvas: Locator): Promise<Rect[]> {
  return canvas.locator("[data-flow-id]").evaluateAll((elements) =>
    elements.map((element) => {
      const frame = element.querySelector(':scope > [data-slot="flow-frame"]') ?? element;
      const box = frame.getBoundingClientRect();
      return {
        id: element.getAttribute("data-flow-id") ?? "",
        group: element.getAttribute("data-slot") === "flow-group",
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom
      };
    })
  );
}

/** Opens the Canvas section of the gallery and waits until one sample has laid out its graph. */
async function openCanvas(page: Page, sample: string): Promise<Locator> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: adminUser.email, password: adminUser.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/ui-library");
  await page
    .getByRole("navigation", { name: "Sections of the UI library" })
    .getByRole("button", { name: "Canvas", exact: true })
    .click();
  const canvas = page.locator(`[data-gallery-sample="${sample}"] [data-slot="flow-canvas"]`);
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas.locator('[data-slot="flow-engine"][data-ready]')).toBeVisible();
  return canvas;
}
