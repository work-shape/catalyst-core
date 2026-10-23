import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The gallery entries of the parts of a Send email step (MAIL-3): MailPreview, RecipientField
// and TemplateTextField, light and dark at 1280 and light at 390, with nothing scrolling sideways.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const adminUser = { email: "e2e-admin@example.test", password: "e2e-admin-password" };

const entries = [
  ["Data", "MailPreview"],
  ["Forms", "RecipientField"],
  ["Forms", "TemplateTextField"]
] as const;

test("the gallery shows MailPreview, RecipientField and TemplateTextField light, dark and at 390", async ({
  page
}) => {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...adminUser, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/ui-library");
  for (const [section, name] of entries) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page
      .getByRole("navigation", { name: "Sections of the UI library" })
      .getByRole("button", { name: section, exact: true })
      .click();
    await expect(page.locator("[data-gallery-section] h2").first()).toHaveText(section);
    await chooseMode(page, "Light");
    await shoot(page, name, "light-1280");
    await chooseMode(page, "Dark");
    await shoot(page, name, "dark-1280");
    await chooseMode(page, "Light");
    await page.setViewportSize({ width: 390, height: 844 });
    await shoot(page, name, "light-390");
    // Nothing of the entry scrolls sideways at a phone's width.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  }
});

async function chooseMode(page: Page, mode: string): Promise<void> {
  const choice = page.getByRole("group", { name: "Mode" }).getByRole("button", { name: mode });
  await choice.click();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
}

async function shoot(page: Page, name: string, label: string): Promise<void> {
  const entry = page.locator(`[data-gallery-entry="${name}"]`).first();
  await entry.scrollIntoViewIfNeeded();
  await expect(entry).toBeVisible();
  const path = test.info().outputPath(`evidence-gallery-${name}-${label}.png`);
  await entry.screenshot({ path, animations: "disabled" });
  await test.info().attach(`gallery-${name}-${label}`, { path, contentType: "image/png" });
}
