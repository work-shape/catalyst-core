import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
/**
 * The windows the detail is read in: wide enough for two columns, a laptop, a small laptop or
 * tablet, a phone, and dark.
 */
const WINDOWS = [
  { width: 1680, height: 900, theme: "light" },
  { width: 1280, height: 800, theme: "light" },
  { width: 1024, height: 768, theme: "light" },
  { width: 390, height: 844, theme: "light" },
  { width: 1280, height: 800, theme: "dark" }
] as const;

interface Box {
  name: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The content is wider than the box, so it runs under what stands beside it or off the page. */
  overflows: boolean;
}

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function boxesOf(cards: Locator): Promise<Box[]> {
  return cards.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return {
        name: element.querySelector("h2")?.textContent ?? "",
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        overflows: element.scrollWidth > element.clientWidth
      };
    })
  );
}

/** The names of every two cards whose boxes share an area. Cards that only touch do not. */
function overlappingPairs(boxes: readonly Box[]): string[] {
  const pairs: string[] = [];
  for (const [index, a] of boxes.entries()) {
    for (const b of boxes.slice(index + 1)) {
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        pairs.push(`${a.name} / ${b.name}`);
      }
    }
  }
  return pairs;
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

test("a user's detail keeps its cards apart and in the window, and each right's switch in its card", async ({
  page
}) => {
  // A user of this test's own, with a long name, so the head and the cards meet a real one.
  const timestamp = Date.now();
  const shown = {
    displayLabel: `E2E Layout Annemarie Schwarzenberger-Hohenlohe ${timestamp}`,
    email: `e2e-users-detail-${timestamp}@example.test`
  };
  await page.addInitScript(() => {
    window.localStorage.setItem("vivd-catalyst:locale", "de");
  });
  await signInViaApi(page, superadminUser);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/instance/users`, {
    data: { displayLabel: shown.displayLabel, email: shown.email, roles: ["user"] }
  });
  expect(created.ok()).toBe(true);
  const { id: shownId } = z.object({ id: z.string() }).parse(await created.json());

  try {
    const settings = page.getByRole("region", { name: "Einstellungen" });
    const cards = settings.locator("[data-card]");
    const rights = cards.filter({ has: page.getByRole("heading", { name: "Rechte" }) });
    // The detail is opened once for each theme and read in each of its windows: a window is a
    // size the open page takes, as when a person resizes it, and a load per window took the
    // test's time.
    let opened: string | undefined;
    for (const { theme, ...window } of WINDOWS) {
      const at = `at ${window.width} ${theme}`;
      await page.setViewportSize(window);
      if (opened !== theme) {
        if (opened === undefined) await page.goto("/settings/instance/users");
        await page.evaluate((value) => localStorage.setItem("vivd-catalyst:theme", value), theme);
        await page.goto("/settings/instance/users");
        await page
          .getByRole("searchbox", { name: "Benutzer suchen", exact: true })
          .fill(shown.email);
        await page.getByRole("button", { name: `${shown.displayLabel} ${shown.email}` }).click();
        opened = theme;
      }
      await expect(settings.getByRole("heading", { name: "Profil", exact: true })).toBeVisible();
      await expect(settings.getByRole("heading", { name: "Konto", exact: true })).toBeVisible();
      await shoot(page, `users-detail-${window.width}-de-${theme}`);

      // Soft, so every window is read and pictured before the test reports.
      const boxes = await boxesOf(cards);
      expect.soft(overlappingPairs(boxes), at).toEqual([]);
      const overflowing = boxes.filter((box) => box.overflows || box.right > window.width);
      expect
        .soft(
          overflowing.map((box) => box.name),
          at
        )
        .toEqual([]);
      const [rightsBox] = await boxesOf(rights);
      if (!rightsBox) {
        throw new Error("The detail shows no card Rechte");
      }
      const switches = await boxesOf(rights.getByRole("switch"));
      expect(switches.length).toBeGreaterThan(0);
      for (const toggle of switches) {
        expect.soft(toggle.left, at).toBeGreaterThanOrEqual(rightsBox.left);
        expect.soft(toggle.right, at).toBeLessThanOrEqual(rightsBox.right);
      }

      await rights.getByRole("switch").last().scrollIntoViewIfNeeded();
      await shoot(page, `users-detail-${window.width}-de-${theme}-rights`);
    }
  } finally {
    await requestWithOrigin(page, "delete", `${apiBaseUrl}/api/v1/instance/users/${shownId}`);
  }
});
