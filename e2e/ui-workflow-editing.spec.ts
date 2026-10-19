import type { Page } from "@playwright/test";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";

async function openGallery(page: Page) {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: "e2e-admin@example.test", password: "e2e-admin-password", rememberMe: true }
  });
  expect(response.ok()).toBe(true);
  await page.goto("/ui-library");
}

for (const mode of ["light", "dark"] as const) {
  for (const width of [1440, 390]) {
    test(`editing library parts by keyboard in ${mode} at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 640 });
      await openGallery(page);
      await page
        .getByRole("group", { name: "Mode", exact: true })
        .getByRole("button", { name: mode === "light" ? "Light" : "Dark", exact: true })
        .click();
      const section = async (name: string) => {
        const select = page.getByRole("combobox", { name: "Sections of the UI library" });
        if (await select.isVisible()) await select.selectOption({ label: name });
        else
          await page
            .getByRole("navigation", { name: "Sections of the UI library" })
            .getByRole("button", { name, exact: true })
            .click();
      };
      await section("Forms");
      const sourced = page
        .locator('[data-gallery-entry="SourcedValueField"] [data-slot="sourced-value-field"]')
        .first();
      await sourced.getByRole("radio", { name: "Fixed", exact: true }).focus();
      await page.keyboard.press("ArrowRight");
      await expect(sourced.getByRole("radio", { name: "From a step" })).toBeFocused();
      await page.keyboard.press("Space");
      await expect(sourced.getByRole("radio", { name: "From a step" })).toBeChecked();
      const picker = sourced.getByRole("button");
      await picker.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("listbox")).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(picker).toContainText("Load the clients");
      await expect(picker).toBeFocused();

      const fields = page
        .locator('[data-gallery-entry="FieldListEditor"] [data-slot="field-list-editor"]')
        .first();
      await fields.getByRole("button", { name: "Add field", exact: true }).focus();
      await page.keyboard.press("Enter");
      await fields.getByLabel("Name", { exact: true }).fill("Answer");
      await fields.getByRole("switch", { name: "Required" }).focus();
      await page.keyboard.press("Space");
      await expect(fields.getByRole("switch", { name: "Required" })).toBeChecked();
      await fields.getByRole("button", { name: "Remove: Answer", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(fields.getByLabel("Name", { exact: true })).toHaveCount(0);

      const schedule = page
        .locator('[data-gallery-entry="ScheduleField"] [data-slot="schedule-field"]')
        .first();
      await schedule.getByLabel("Repeats", { exact: true }).selectOption("week");
      await schedule.getByRole("checkbox", { name: "Friday" }).focus();
      await page.keyboard.press("Space");
      await expect(schedule.getByRole("checkbox", { name: "Friday" })).toBeChecked();
      await schedule.getByLabel("Time zone", { exact: true }).fill("UTC");
      await expect(schedule.getByLabel("Time zone", { exact: true })).toHaveValue("UTC");

      // Switch away and back twice, so examples remount with their documented initial state.
      for (let i = 0; i < 2; i++) {
        await section("Canvas");
        await section("Forms");
      }
      await section("Canvas");
      const point = page
        .locator('[data-gallery-entry="FlowInsertPoint"] [data-slot="flow-insert-point"]')
        .first();
      await point.focus();
      await page.keyboard.press("Enter");
      await expect(point).toHaveAttribute("aria-pressed", "true");
      const marked = page
        .locator('[data-gallery-entry="Flow change marks"] [data-slot="flow-node"]')
        .first();
      await marked.focus();
      await page.keyboard.press("Enter");
      await expect(marked).toHaveAttribute("aria-current", "true");

      const frame = page.locator('[data-gallery-sample="side-panel-tall"]');
      const panel = frame.locator('[data-slot="side-panel"]');
      await panel.scrollIntoViewIfNeeded();
      const geometry = await panel.evaluate((element) => {
        const frame = element.parentElement?.getBoundingClientRect();
        const panel = element.getBoundingClientRect();
        return { ratio: frame ? panel.height / frame.height : 0, width: panel.width };
      });
      if (width === 390) expect(geometry.ratio).toBeCloseTo(0.92, 1);
      const body = panel.locator('[data-slot="side-panel-body"]');
      await body.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const save = panel
        .locator('[data-slot="side-panel-footer"]')
        .getByRole("button", { name: "Save changes", exact: true });
      await expect(save).toBeInViewport();
      await save.focus();
      await page.keyboard.press("Enter");
      await expect(panel).toContainText("Changes saved");
      const shotsDir = process.env.E2E_SHOTS_DIR;
      if (shotsDir)
        await panel.screenshot({ path: `${shotsDir}/editing-panel-${mode}-${width}.png` });
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);

      await page
        .getByRole("group", { name: "Language" })
        .getByRole("button", { name: "DE", exact: true })
        .click();
      await expect(page.locator('[data-slot="flow-change"]').first()).toHaveText("Neu");
      await marked.scrollIntoViewIfNeeded();
      if (shotsDir) await page.screenshot({ path: `${shotsDir}/editing-${mode}-${width}.png` });
    });
  }
}
