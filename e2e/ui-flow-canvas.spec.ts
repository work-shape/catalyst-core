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
