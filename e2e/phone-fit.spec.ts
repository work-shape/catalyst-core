import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

// Chat clarity and phone fit (UXA-7a): a reply's table scrolls sideways inside the message with
// the library's edge fade, a page head folds the actions it has no room for into "…", and the
// palette names each Settings page with its group. Fails without the table of the library in a
// reply: the message cut the fifth column off at 390 px and said nothing of it.

/** Where the pictures of a run go. Without it the test takes none. */
const shotsDir = process.env.E2E_SHOTS_DIR;

/** The person of this spec, from `tests/fixtures/e2e-users/phone-fit.yaml`. No other spec uses them. */
const person = { email: "e2e-phone-fit@example.test", password: "e2e-phone-fit-password" };

/**
 * The fixture model answers with the message in its own sentence. A blank line before the table
 * and after it keeps that sentence out of the table, so the reply holds a table of five columns.
 */
const TABLE = [
  "The customers of the quarter:",
  "",
  "| Rank | Customer | Segment | Orders | Revenue |",
  "| --- | --- | --- | --- | --- |",
  "| 1 | Velunara Nuvarek AG | Hospitality | 128 | 412,300 EUR |",
  "| 2 | Velunara Fenvilo GmbH | Hospitality | 97 | 388,150 EUR |",
  "| 3 | Velunara Talumet KG | Retail | 84 | 301,900 EUR |",
  "| 4 | Tavolumi Mirevul GmbH | Hospitality | 66 | 254,020 EUR |",
  "| 5 | Lumavoti Vesulon KG | Logistics | 51 | 198,700 EUR |",
  "",
  "That is all."
].join("\n");

type Locale = "en" | "de";
type Theme = "light" | "dark";
type Variant = readonly [Locale, Theme];
const enLight: Variant = ["en", "light"];
const deLight: Variant = ["de", "light"];
const variants: readonly Variant[] = [enLight, ["en", "dark"], deLight, ["de", "dark"]];

const words = {
  en: {
    selectAgent: "Select agent",
    search: "Search",
    users: "Instance › Users",
    message: "Message",
    more: "More actions",
    history: "History"
  },
  de: {
    selectAgent: "Agent auswählen",
    search: "Suchen",
    users: "Instanz › Benutzer",
    message: "Nachricht",
    more: "Weitere Aktionen",
    history: "Verlauf"
  }
} satisfies Record<Locale, Record<string, string>>;

async function signIn(page: Page): Promise<void> {
  const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
    headers: { Origin: uiOrigin },
    data: { ...person, rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  // The instance knows a person of the config from their first call on.
  expect((await page.request.get(`${apiOrigin}/api/v1/me`)).ok()).toBe(true);
}

/** Loads `path` in a language and a theme at a width. Both are read when the interface loads. */
async function show(
  page: Page,
  path: string,
  [locale, theme]: Variant,
  width: number
): Promise<void> {
  await page.evaluate(
    ([chosenLocale, chosenTheme]) => {
      localStorage.setItem("vivd-catalyst:locale", chosenLocale);
      localStorage.setItem("vivd-catalyst:theme", chosenTheme);
    },
    [locale, theme] as const
  );
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-vivd-theme", theme);
}

async function shoot(page: Page, name: string): Promise<void> {
  if (!shotsDir) {
    return;
  }
  await mkdir(shotsDir, { recursive: true });
  await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
}

/** The box of a reply's table that scrolls sideways. */
function tableBox(page: Page): Locator {
  return page
    .locator('[data-role="assistant"] [data-streamdown="table-wrapper"] [data-slot="table-box"]')
    .last();
}

test("at 390 a reply's table of five columns scrolls sideways inside the message", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 300_000 : 120_000);
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const composer = page.getByRole("textbox", { name: "Message" });
  await composer.fill(TABLE);
  await composer.press("Enter");
  const box = tableBox(page);
  await expect(box.locator("th")).toHaveText(["Rank", "Customer", "Segment", "Orders", "Revenue"]);
  // The whole reply is in, so no picture is taken while it streams.
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("registered tool");
  await expect(page).toHaveURL(/\/c\/[^/]+$/u);
  const conversation = new URL(page.url()).pathname;

  // The table is wider than the message: its box scrolls, and the page does not.
  const sizes = () =>
    box.evaluate((element) => ({
      scrolls: element.scrollWidth > element.clientWidth + 1,
      page: document.documentElement.scrollWidth,
      window: window.innerWidth,
      fade: getComputedStyle(element).maskImage
    }));
  await expect.poll(async () => (await sizes()).scrolls).toBe(true);
  const atStart = await sizes();
  expect(atStart.page).toBeLessThanOrEqual(atStart.window);
  // The edge that hides columns fades, and says so with its shade; the start edge hides none.
  expect(atStart.fade).toContain("linear-gradient");
  const frame = box.locator("xpath=..");
  await expect(frame.locator('[data-slot="table-edge-shade"][data-side="end"]')).toHaveCount(1);
  await expect(frame.locator('[data-slot="table-edge-shade"][data-side="start"]')).toHaveCount(0);
  // Whether the last column stands whole inside the box, to a pixel of rounding.
  const revenueShows = () =>
    box.evaluate((element) => {
      const cell = element.querySelector("th:last-child");
      if (!cell) throw new Error("The table has no head cell.");
      const shown = element.getBoundingClientRect();
      const { left, right } = cell.getBoundingClientRect();
      return left >= shown.left - 1 && right <= shown.right + 1;
    });
  expect(await revenueShows()).toBe(false);

  // Scrolled to its end, the last column stands whole in the box and the start edge fades.
  await box.evaluate((element) => element.scrollTo({ left: element.scrollWidth }));
  await expect.poll(revenueShows).toBe(true);
  await expect(frame.locator('[data-slot="table-edge-shade"][data-side="start"]')).toHaveCount(1);
  await expect(frame.locator('[data-slot="table-edge-shade"][data-side="end"]')).toHaveCount(0);
  expect((await sizes()).page).toBeLessThanOrEqual(atStart.window);

  // At phone width the head is a band with its fade, so nothing passes under the controls.
  // From 768 px up the thread scrolls to the window's top, and the agent picker floats over it
  // on a light fade.
  const lightFade = page.locator("#workspace-content > header [data-header-fade]");
  expect(await bandDrawn(page)).toBe(true);
  expect(await fadeDrawn(page)).toBe(true);
  await expect(lightFade).toBeHidden();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(lightFade).toBeVisible();
  expect(await bandDrawn(page)).toBe(false);
  expect(await fadeDrawn(page)).toBe(false);

  if (!shotsDir) {
    return;
  }
  // A second turn, so the thread has something to scroll in a wide window too.
  await composer.fill(TABLE);
  await composer.press("Enter");
  await expect(page.locator('[data-role="assistant"]')).toHaveCount(2);
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("registered tool");
  for (const variant of variants) {
    for (const width of [390, 1280]) {
      await show(page, conversation, variant, width);
      await expect(tableBox(page).locator("th")).toHaveCount(5);
      await shoot(page, `chat-table-${String(width)}-${variant[1]}-${variant[0]}`);
      // The table scrolled to its end, and the thread scrolled so that the first reply's table
      // passes the window's top: under the band at 390, under the floating picker at 1280.
      await page
        .locator('[data-role="assistant"]')
        .first()
        .evaluate((message) => {
          const table = message.querySelector<HTMLElement>('[data-slot="table-box"]');
          table?.scrollTo({ left: table.scrollWidth, behavior: "instant" });
          table?.scrollIntoView({ block: "start", behavior: "instant" });
        });
      await shoot(page, `chat-table-scrolled-${String(width)}-${variant[1]}-${variant[0]}`);
    }
  }
});

test("the palette names each Settings page with its group", async ({ page }) => {
  test.setTimeout(shotsDir ? 300_000 : 60_000);
  await signIn(page);
  await page.goto("/");
  for (const variant of shotsDir ? variants : [enLight, deLight]) {
    for (const width of shotsDir ? [390, 1280] : [390]) {
      const [locale, theme] = variant;
      await show(page, "/", variant, width);
      // The keys reach the page once something in it has the focus.
      await page.getByRole("textbox", { name: words[locale].message }).click();
      await page.keyboard.press("ControlOrMeta+k");
      const palette = page.getByRole("dialog", { name: words[locale].search });
      await expect(
        palette.getByRole("option", { name: words[locale].users, exact: true })
      ).toBeVisible();
      await shoot(page, `palette-${String(width)}-${theme}-${locale}`);
      await page.keyboard.press("Escape");
      await expect(palette).toBeHidden();

      // The agent picker opens at its first option.
      const picker = page
        .getByRole("region", { name: "Chat" })
        .getByRole("button", { name: words[locale].selectAgent });
      if ((await picker.count()) > 0) {
        await picker.click();
        const list = page.getByRole("listbox");
        await expect(list.getByRole("option").first()).toBeInViewport({ ratio: 1 });
        await shoot(page, `agent-picker-${String(width)}-${theme}-${locale}`);
        await page.keyboard.press("Escape");
        await expect(list).toHaveCount(0);
      }
    }
  }
});

/** The labels of the visible buttons of a head that do not show whole. */
function cutLabels(head: Locator): Promise<(string | null)[]> {
  return head.getByRole("button").evaluateAll((buttons) =>
    buttons
      .filter((button) => button.checkVisibility())
      .filter((button) => button.scrollWidth > button.clientWidth + 1)
      .map((button) => button.textContent)
  );
}

test("a page head folds the actions it has no room for into its … menu", async ({ page }) => {
  test.setTimeout(shotsDir ? 300_000 : 60_000);
  await signIn(page);
  await page.goto("/");
  for (const variant of shotsDir ? variants : [deLight]) {
    const [locale, theme] = variant;
    const word = words[locale];
    // The library's head at the width of a phone's: the secondary actions stand in its menu,
    // first in it, and the name and the primary action keep their whole labels.
    await show(page, "/ui-library", variant, 1280);
    await page
      .getByRole("navigation", {
        name: locale === "en" ? "Sections of the UI library" : "Abschnitte der UI-Bibliothek"
      })
      .getByRole("button", {
        name: locale === "en" ? "Page structure" : "Seitenaufbau",
        exact: true
      })
      .click();
    // The section rail is a row of buttons only in a wide window; the head wraps as on a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    const sample = page.locator('[data-gallery-sample="header-folded"]');
    const sampleHead = sample.locator("header[data-page-head]");
    await expect(sampleHead.getByRole("button", { name: word.history, exact: true })).toHaveCount(
      0
    );
    expect(await cutLabels(sampleHead)).toEqual([]);
    await sample.scrollIntoViewIfNeeded();
    await expect(sampleHead.getByRole("heading", { level: 2 })).toBeInViewport({ ratio: 1 });
    await shoot(page, `head-gallery-folded-390-${theme}-${locale}`);
    await sampleHead.getByRole("button", { name: word.more, exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu.getByRole("menuitem").nth(1)).toHaveText(word.history);
    await shoot(page, `head-gallery-menu-390-${theme}-${locale}`);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // A Studio page at both widths: every action is a whole button or an item of the menu.
    for (const width of [390, 1280]) {
      await show(page, "/build/agents/research_assistant", variant, width);
      const head = page.locator("header[data-page-head]");
      await expect(head.getByRole("heading", { level: 1 })).toBeVisible();
      const more = head.getByRole("button", { name: word.more, exact: true });
      await expect(more).toBeVisible();
      expect(await cutLabels(head)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width
      );
      const historyButton = head.getByRole("button", { name: word.history, exact: true });
      if ((await historyButton.count()) === 0) {
        await more.click();
        await expect(page.getByRole("menuitem", { name: word.history, exact: true })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
      } else {
        await expect(historyButton).toBeInViewport({ ratio: 1 });
      }
      await shoot(page, `head-${String(width)}-${theme}-${locale}`);
    }
  }
});

/** Whether the band under the sidebar button is drawn: its background is not transparent. */
function bandDrawn(page: Page): Promise<boolean> {
  return page
    .locator("#workspace-content > header")
    .first()
    .evaluate((band) => getComputedStyle(band).backgroundColor !== "rgba(0, 0, 0, 0)");
}

/** Scrolls whatever scrolls the main area down, as a reader on a phone does. */
async function scrollMainArea(page: Page): Promise<void> {
  await page.locator("#workspace-content").evaluate((area) => {
    for (const node of area.querySelectorAll<HTMLElement>("*")) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight) {
        node.scrollTop = 240;
      }
    }
  });
}

/** Whether the fade under the band is drawn, for what scrolls up under the band. */
function fadeDrawn(page: Page): Promise<boolean> {
  return page
    .locator("#workspace-content > header")
    .first()
    .evaluate((band) => {
      const fade = getComputedStyle(band, "::after");
      return fade.display !== "none" && fade.backgroundImage !== "none";
    });
}

// Fails with the band on every page: it covered a pinned detail head, its name and its actions,
// and the area name a Settings page's sub-rail shows beside the sidebar button. A list, whose
// head scrolls away, keeps the band and its fade, so nothing passes under the sidebar button.
test("the band under the sidebar button gives way to a pinned head and stays over a list", async ({
  page
}) => {
  test.setTimeout(shotsDir ? 300_000 : 90_000);
  await signIn(page);
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+/u);
  const workspace = /\/w\/([^/]+)/u.exec(page.url())?.[1] ?? "";
  for (const variant of shotsDir ? variants : [deLight]) {
    const [locale, theme] = variant;
    for (const [name, path, band] of [
      ["apps-list", `/w/${workspace}/apps`, true],
      // The sub-rail's line with the area's name is the band of a Settings page.
      ["settings-users", "/settings/instance/users", false]
    ] as const) {
      await show(page, path, variant, 390);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await bandDrawn(page), path).toBe(band);
      expect(await fadeDrawn(page), path).toBe(band);
      if (!band) await expect(page.locator("[data-subrail-title]"), path).toBeVisible();
      // A short window, so the page has something to scroll.
      await page.setViewportSize({ width: 390, height: 560 });
      await scrollMainArea(page);
      await shoot(page, `band-${name}-scrolled-390-${theme}-${locale}`);
    }
    for (const width of [390, 1280]) {
      await show(page, "/settings/instance/infrastructure", variant, width);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await shoot(page, `infrastructure-head-${String(width)}-${theme}-${locale}`);
    }
    await show(page, "/build/agents/research_assistant", variant, 390);
    await expect(page.locator("header[data-page-head]").getByRole("heading")).toBeVisible();
    expect(await bandDrawn(page)).toBe(false);
  }
});
