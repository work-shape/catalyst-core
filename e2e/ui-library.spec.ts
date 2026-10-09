import { requestWithOrigin } from "./request-with-origin";
import { expect, test, type Locator, type Page } from "@playwright/test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const normalUser = { email: "e2e-user@example.test", password: "e2e-user-password" };
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

// The default theme's raised surface: in dark the fill carries the lift, so it differs from the page.
const darkPopover = "color-mix(in srgb, #ededed 6%, #1b1b1b)";

test("the UI library gallery opens for an administrator and for nobody else", async ({
  page,
  browser
}) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await expect(page.getByRole("heading", { name: "UI library", level: 1 })).toBeVisible();
  await expect(page.locator("[data-gallery-entry]")).not.toHaveCount(0);

  const memberContext = await browser.newContext();
  const memberPage = await memberContext.newPage();
  await signInViaApi(memberPage, normalUser);
  await memberPage.goto("/ui-library");
  await expect(memberPage).not.toHaveURL(/ui-library/u);
  await expect(memberPage.locator("[data-ui-gallery]")).toHaveCount(0);
  await memberContext.close();
});

test("the gallery switches mode, theme and language without touching the application", async ({
  page
}) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  const applicationMode = await page.locator("html").getAttribute("data-vivd-theme");

  await choose(page, "Mode", "Both");
  const light = page.locator('[data-gallery-mode="light"]');
  const dark = page.locator('[data-gallery-mode="dark"]');
  await expect(light).toBeVisible();
  await expect(dark).toBeVisible();
  expect(await token(light, "--background")).toBe("#ffffff");
  expect(await token(dark, "--background")).toBe("#1b1b1b");
  expect(await token(dark, "--primary")).toBe("#ededed");

  await choose(page, "Theme", "Teal accent");
  expect(await token(light, "--primary")).toBe("#0f766e");
  expect(await token(dark, "--primary")).toBe("#2dd4bf");
  expect(await token(dark, "--background")).toBe("#1b1b1b");

  await choose(page, "Theme", "Previous default");
  expect(await token(light, "--background")).toBe("#fffdfa");

  // The group's own name changes with the language, so the choice is checked by its effect.
  await page.getByRole("group", { name: "Language" }).getByRole("button", { name: "DE" }).click();
  await expect(page.getByRole("heading", { name: "UI-Bibliothek", level: 1 })).toBeVisible();
  await expect(page.getByRole("group", { name: "Modus" })).toBeVisible();

  expect(await page.locator("html").getAttribute("data-vivd-theme")).toBe(applicationMode);
});

test("overlays in a dark root show that root's theme, also inside a dialog", async ({ page }) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  await choose(page, "Mode", "Dark");
  const root = page.locator('[data-gallery-mode="dark"]');
  // The overlay container is the root's last child, so an overlay is inside the themed root.
  const overlays = root.locator(":scope > [data-catalyst-overlays]");
  await expect(overlays).toHaveCount(1);

  // Tooltip: the gallery holds one open.
  const tooltip = overlays.locator("[data-side]").filter({ hasText: "Copy the link" }).first();
  await expect(tooltip).toBeVisible();
  expect(await token(tooltip, "--popover")).toBe(darkPopover);

  // Hover card.
  await root.getByRole("button", { name: "Context" }).hover();
  const hoverCard = overlays.locator("[data-side]").filter({ hasText: "context window" });
  await expect(hoverCard).toBeVisible();
  expect(await token(hoverCard, "--popover")).toBe(darkPopover);
  expect(await backgroundOf(hoverCard)).not.toBe(await backgroundOf(root));
  await page.mouse.move(0, 0);

  // Dialog: native, in the top layer, with a container of its own for what opens inside it.
  await root.getByRole("button", { name: "Open dialog md" }).click();
  const dialog = root.getByRole("dialog", { name: "Delete agent" });
  await expect(dialog).toBeVisible();
  expect(await token(dialog, "--popover")).toBe(darkPopover);
  expect(await dialog.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("16px");

  // Opening focuses the close button, and that shows no tooltip.
  await expect(dialog.locator("[data-catalyst-overlays] [data-side]")).toHaveCount(0);

  await dialog.getByRole("button", { name: "Copy the link" }).hover();
  const tooltipInDialog = dialog.locator("[data-catalyst-overlays] [data-side]");
  await expect(tooltipInDialog).toBeVisible();
  expect(await token(tooltipInDialog, "--popover")).toBe(darkPopover);

  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("the base theme's measures hold in the gallery", async ({ page }) => {
  await signInViaApi(page, adminUser);
  await page.goto("/ui-library");
  const root = page.locator("[data-gallery-mode]").first();
  const style = (locator: Locator, property: string) =>
    locator.evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property);

  // Fields and the default button are 36 px high.
  const input = root.locator('[data-gallery-entry="Input"] input').first();
  const select = root.locator('[data-gallery-entry="Select"] select').first();
  const button = root.locator('[data-gallery-entry="Button"] button').first();
  expect((await input.boundingBox())?.height).toBe(36);
  expect((await select.boundingBox())?.height).toBe(36);
  expect((await button.boundingBox())?.height).toBe(36);

  // Radius: 8 for a control, 12 for a card.
  expect(await style(button, "border-radius")).toBe("8px");
  expect(await style(input, "border-radius")).toBe("8px");
  const card = root.locator('[data-gallery-entry="Card"] [data-padding]').first();
  expect(await style(card, "border-radius")).toBe("12px");

  // Nothing has a shadow at rest.
  expect(await style(card, "box-shadow")).toBe("none");
  expect(await style(button, "box-shadow")).toBe("none");
  expect(await style(input, "box-shadow")).toBe("none");

  // Focus is one 2 px line: in place of the border on a field, 2 px outside a button.
  await input.focus();
  expect(await style(input, "outline-width")).toBe("2px");
  expect(await style(input, "outline-style")).toBe("solid");
  expect(await style(input, "outline-offset")).toBe("-2px");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await button.focus();
  await page.keyboard.press("Tab");
  const focusedButton = root.locator('[data-gallery-entry="Button"] button:focus-visible');
  await expect(focusedButton).toHaveCount(1);
  expect(await style(focusedButton, "outline-width")).toBe("2px");
  expect(await style(focusedButton, "outline-offset")).toBe("2px");

  // Icon stroke: 1.5 at 16 and 20 px, 2 at 12 px.
  const icons = root.locator('[data-gallery-entry="icons"] svg');
  expect(await style(icons.nth(0), "stroke-width")).toBe("2px");
  expect(await style(icons.nth(1), "stroke-width")).toBe("1.5px");
  expect(await style(icons.nth(3), "stroke-width")).toBe("1.5px");
});

async function choose(page: Page, group: string, option: string): Promise<void> {
  const button = page.getByRole("group", { name: group }).getByRole("button", { name: option });
  await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

function token(locator: Locator, name: string): Promise<string> {
  return locator.evaluate(
    (element, property) => getComputedStyle(element).getPropertyValue(property).trim(),
    name
  );
}

function backgroundOf(locator: Locator): Promise<string> {
  return locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function signInViaApi(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}
