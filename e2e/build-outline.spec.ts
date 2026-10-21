import { type Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const NARROW = { width: 390, height: 844 };
const WIDE = { width: 1280, height: 800 };

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
}

// Fails with the sections in a `SubRail`: they stood left of the content and looked like the
// list of pages in Build and Settings.
test("an agent's sections are an outline right of the content: its mark follows the scroll and a click scrolls", async ({
  page
}) => {
  await signInViaApi(page, superadminUser);
  await page.setViewportSize(WIDE);
  await page.goto("/build/agents/research_assistant");
  const heading = (name: string) =>
    page.locator("form").getByRole("heading", { name, exact: true });
  await expect(heading("Overview")).toBeVisible();
  const outline = page.getByRole("navigation", { name: "On this page" });
  const current = outline.locator("[aria-current]");
  const head = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  // The language switch of the texts, on the bar that stays pinned under the head.
  const textsIn = page.getByRole("radiogroup", { name: "Texts in" });
  const bar = page.locator("[data-page-bar]").filter({ has: textsIn });
  // How far a heading stands below everything pinned at the top: the head and the bar under it.
  const below = async (name: string) => {
    const pinned = [await head.boundingBox(), await bar.boundingBox()];
    const box = await heading(name).boundingBox();
    if (!box || pinned.some((pin) => !pin)) {
      return Number.NaN;
    }
    return box.y - Math.max(...pinned.map((pin) => (pin ? pin.y + pin.height : 0)));
  };
  // The switch is in view right under the head, nothing covers it, and it switches the texts
  // and back. Playwright's click refuses an element another one covers.
  const expectSwitchUsable = async () => {
    await expect(textsIn).toBeInViewport();
    const headBox = await head.boundingBox();
    const barBox = await bar.boundingBox();
    if (!headBox || !barBox) {
      throw new Error("The head or the language bar has no box.");
    }
    expect(Math.abs(barBox.y - (headBox.y + headBox.height))).toBeLessThanOrEqual(1);
    const radios = textsIn.getByRole("radio");
    await expect(radios).toHaveCount(2);
    const shown = (await radios.nth(0).getAttribute("aria-checked")) === "true" ? 0 : 1;
    await radios.nth(1 - shown).click();
    await expect(radios.nth(1 - shown)).toBeChecked();
    await radios.nth(shown).click();
    await expect(radios.nth(shown)).toBeChecked();
    await expect(textsIn).toBeInViewport();
  };

  // The column left of the content is free, and the outline is to the right of it at the page's
  // edge: the content is centred in the room between the page's gutter and the outline's column.
  // Nothing on the page looks like the kinds' rail any more.
  const headBox = await head.boundingBox();
  const contentBox = await page.locator("form").boundingBox();
  const outlineBox = await outline.boundingBox();
  if (!headBox || !contentBox || !outlineBox) {
    throw new Error("The head, the content or the outline has no box.");
  }
  const gutter = 24;
  const freeLeft = contentBox.x - (headBox.x + gutter);
  const freeRight = outlineBox.x - gutter - (contentBox.x + contentBox.width);
  expect(freeLeft).toBeGreaterThanOrEqual(0);
  expect(Math.abs(freeLeft - freeRight)).toBeLessThanOrEqual(1);
  expect(contentBox.width).toBeLessThanOrEqual(704);
  expect(outlineBox.x + outlineBox.width).toBeLessThanOrEqual(headBox.x + headBox.width - gutter);
  expect(outlineBox.x + outlineBox.width).toBeGreaterThan(headBox.x + headBox.width - gutter - 1);
  await expect(page.getByRole("navigation", { name: "Kinds in Studio" })).toHaveCount(0);
  await expect(current).toHaveText("Overview");

  // A click scrolls the section up under the page's head and the language bar, and hands its
  // heading the focus. The switch stays where it was, in view and usable.
  await expect(bar).toHaveCount(1);
  await outline.getByRole("link", { name: /^Tools/u }).click();
  await expect(current).toHaveText(/^Tools/u);
  await expect.poll(() => below("Tools")).toBeLessThan(40);
  await expect.poll(() => below("Tools")).toBeGreaterThanOrEqual(0);
  await expect(heading("Tools")).toBeFocused();
  await expect(page).toHaveURL(/\/build\/agents\/research_assistant$/u);
  await expectSwitchUsable();

  // A title above its fields is larger than their labels, so it is not taken for one.
  const fontSize = (element: Element) => getComputedStyle(element).fontSize;
  expect(await heading("Tools").evaluate(fontSize)).toBe("16px");
  expect(await page.locator("form label").first().evaluate(fontSize)).toBe("14px");

  // Scrolls what scrolls the page to a place, or by a distance, and answers where it is then.
  const scrollPage = (to: "top" | "end" | number) =>
    page.locator("form").evaluate((form, where) => {
      for (let parent = form.parentElement; parent; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowY;
        if (
          (overflow === "auto" || overflow === "scroll") &&
          parent.scrollHeight > parent.clientHeight
        ) {
          if (typeof where === "number") {
            parent.scrollBy({ top: where });
          } else {
            parent.scrollTo({ top: where === "top" ? 0 : parent.scrollHeight });
          }
          return {
            top: parent.scrollTop,
            atEnd: parent.scrollTop + parent.clientHeight >= parent.scrollHeight - 1
          };
        }
      }
      return { top: 0, atEnd: true };
    }, to);

  // The first entry is the top of the page: the language switch above the first section shows.
  await outline.getByRole("link", { name: "Overview" }).click();
  await expect(current).toHaveText("Overview");
  expect((await scrollPage(0)).top).toBe(0);
  await expect(page.getByRole("radiogroup", { name: "Texts in" })).toBeInViewport();
  await expect(heading("Overview")).toBeFocused();

  // The focus line of a link is whole: the outline scrolls on its own and clips what leaves it.
  // A key was pressed last, so the focus the test hands over is shown as the keyboard's.
  await page.keyboard.press("Tab");
  await outline.getByRole("link", { name: /^Tools/u }).focus();
  const focused = outline.locator("a:focus-visible");
  await expect(focused).toHaveText(/^Tools/u);
  const ring = await focused.evaluate((link) => {
    const style = getComputedStyle(link);
    const reach = Math.max(
      0,
      Number.parseFloat(style.outlineOffset) + Number.parseFloat(style.outlineWidth)
    );
    const box = link.getBoundingClientRect();
    const clip = (link.closest("nav") ?? link).getBoundingClientRect();
    return {
      width: Number.parseFloat(style.outlineWidth),
      left: box.left - reach - clip.left,
      right: clip.right - box.right - reach
    };
  });
  expect(ring.width).toBe(2);
  expect(ring.left).toBeGreaterThanOrEqual(0);
  expect(ring.right).toBeGreaterThanOrEqual(0);

  // The mark follows the scrolling.
  await scrollPage("top");
  await expect(current).toHaveText("Overview");
  await heading("Instructions").evaluate((element) => {
    element.closest("section")?.scrollIntoView({ block: "start" });
  });
  await expect(current).toHaveText("Instructions");
  // Scrolling to the end marks every section in its turn, the ones the page ends too early for
  // as well: "Starter prompts" cannot reach the head and was never marked. The last one is
  // marked at the end of the page.
  await scrollPage("top");
  await expect(current).toHaveText("Overview");
  const marked: string[] = [];
  for (let place = await scrollPage(0); !place.atEnd; place = await scrollPage(40)) {
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(done)));
    const name = ((await current.textContent()) ?? "").replace(/\d+$/u, "");
    if (marked[marked.length - 1] !== name) {
      marked.push(name);
    }
  }
  expect(marked).toEqual([
    "Overview",
    "Instructions",
    "Model",
    "Skills",
    "Tools",
    "Starter prompts",
    "Available in"
  ]);
  // The steps of 40 can stop a pixel short of the end, which the loop counts as the end: where
  // the page scrolls one pixel past a multiple of 40, the last section is still a pixel away.
  await scrollPage("end");
  await expect(current).toHaveText("Who may use it");
  await expect(current).toHaveCount(1);
  // At the end of the page the switch is still pinned in view.
  await expectSwitchUsable();

  // On a phone it is one line above the content that names the section in view.
  await page.setViewportSize(NARROW);
  await expect(outline.getByRole("link").first()).toBeHidden();
  const choice = outline.getByRole("combobox");
  await scrollPage("top");
  await expect(choice).toBeVisible();
  await expect
    .poll(() =>
      choice.evaluate((element) =>
        element instanceof HTMLSelectElement ? element.selectedOptions[0]?.label : undefined
      )
    )
    .toBe("Overview");
  const tools = await choice
    .locator("option")
    .filter({ hasText: /^Tools/u })
    .textContent();
  // The section rests under the head and language bar as tall as they are on this screen.
  await choice.selectOption({ label: tools ?? "" });
  await expect.poll(() => below("Tools")).toBeLessThan(40);
  expect(await below("Tools")).toBeGreaterThanOrEqual(0);
  await expectSwitchUsable();
  await expectNoSidewaysScroll(page);
});
