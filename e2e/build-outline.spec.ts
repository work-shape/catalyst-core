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
  const heading = (name: string) => page.locator("form").getByRole("heading", { name });
  await expect(heading("Overview")).toBeVisible();
  const outline = page.getByRole("navigation", { name: "On this page" });
  const current = outline.locator("[aria-current]");
  const head = page.locator("header").filter({ has: page.getByRole("heading", { level: 1 }) });
  const below = async (name: string) => {
    const headBox = await head.boundingBox();
    const box = await heading(name).boundingBox();
    return headBox && box ? box.y - (headBox.y + headBox.height) : Number.NaN;
  };

  // The column left of the content is free: the content starts at the page's gutter, and the
  // outline is to the right of it. Nothing on the page looks like the kinds' rail any more.
  const headBox = await head.boundingBox();
  const contentBox = await page.locator("form").boundingBox();
  const outlineBox = await outline.boundingBox();
  expect(contentBox?.x).toBe((headBox?.x ?? 0) + 24);
  expect(contentBox?.width).toBeLessThanOrEqual(704);
  expect(outlineBox?.x).toBeGreaterThanOrEqual((contentBox?.x ?? 0) + (contentBox?.width ?? 0));
  await expect(page.getByRole("navigation", { name: "Kinds in Build" })).toHaveCount(0);
  await expect(current).toHaveText("Overview");

  // A click scrolls the section up to the page's head and hands its heading the focus.
  await outline.getByRole("link", { name: /^Tools/u }).click();
  await expect(current).toHaveText(/^Tools/u);
  await expect.poll(() => below("Tools")).toBeLessThan(40);
  await expect.poll(() => below("Tools")).toBeGreaterThanOrEqual(0);
  await expect(heading("Tools")).toBeFocused();
  await expect(page).toHaveURL(/\/build\/agents\/research_assistant$/u);

  // The mark follows the scrolling.
  const scrollPage = (to: "top" | "end") =>
    page.locator("form").evaluate((form, where) => {
      for (let parent = form.parentElement; parent; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowY;
        if (
          (overflow === "auto" || overflow === "scroll") &&
          parent.scrollHeight > parent.clientHeight
        ) {
          parent.scrollTo({ top: where === "top" ? 0 : parent.scrollHeight });
          return;
        }
      }
    }, to);
  await scrollPage("top");
  await expect(current).toHaveText("Overview");
  await heading("Instructions").evaluate((element) => {
    element.closest("section")?.scrollIntoView({ block: "start" });
  });
  await expect(current).toHaveText("Instructions");
  await scrollPage("end");
  await expect(current).toHaveCount(1);
  await expect(current).not.toHaveText("Overview");

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
  await choice.selectOption({ label: tools ?? "" });
  await expect.poll(() => below("Tools")).toBeLessThan(40);
  await expectNoSidewaysScroll(page);
});
