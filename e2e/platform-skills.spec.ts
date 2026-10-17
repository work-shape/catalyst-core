import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { type Locator, type Page } from "@playwright/test";
import { expect, test } from "./test";
import { assetRevision, requestWithOrigin } from "./request-with-origin";

// The skills that ship with the platform, in Studio: marked "Platform", read-only, and copied
// into an ordinary skill of the instance. The shipped skill here is the product docs,
// `platform-docs`. Fails without the change: the docs were no stored skill, so the Skills list
// did not show them.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
/** Where the pictures of the list, the read-only page and the copy go. Unset, none is taken. */
const shotsDir = process.env.E2E_SHOTS_DIR;
const superadminUser = {
  email: "e2e-superadmin@example.test",
  password: "e2e-superadmin-password"
};
const GUIDE_TITLE = "Platform documentation";
const skillPath = (name: string) => `${apiBaseUrl}/api/v1/assets/skill/${name}`;

async function signInViaApi(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadminUser, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

async function deleteSkill(page: Page, name: string): Promise<void> {
  if ((await page.request.get(skillPath(name))).ok()) {
    await requestWithOrigin(page, "post", `${skillPath(name)}/delete`, {
      data: { expectedRevision: await assetRevision(page, skillPath(name)) }
    });
  }
}

/**
 * The shipped skill's row, and not that of a copy another test of this file holds at the same
 * time: the copy's title starts with the same words.
 */
function shippedGuide(list: Locator): Locator {
  return list
    .getByRole("listitem")
    .filter({ hasText: GUIDE_TITLE })
    .filter({ has: list.page().locator('[data-skill-origin="release"]') });
}

async function shot(page: Page, name: string): Promise<void> {
  if (shotsDir) {
    await mkdir(shotsDir, { recursive: true });
    await page.screenshot({ path: join(shotsDir, `${name}.png`), animations: "disabled" });
  }
}

for (const theme of ["light", "dark"] as const) {
  test(`a skill the platform ships is marked Platform, read-only, and copied to edit (${theme})`, async ({
    page
  }) => {
    test.setTimeout(90_000);
    // A copy of its own per theme: the id of a deleted copy is created again against its delete.
    const copyName = `e2e-guide-copy-${theme}`;
    await page.addInitScript(
      (chosen) => window.localStorage.setItem("vivd-catalyst:theme", chosen),
      theme
    );
    await signInViaApi(page);
    await deleteSkill(page, copyName);
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/build/skills");
      const list = page.getByRole("list", { name: "Skills" });
      const guide = shippedGuide(list);
      await expect(guide.locator('[data-skill-origin="release"]')).toHaveText("Platform");
      await expect(guide.locator("[data-skill-icon]")).toHaveAttribute("data-skill-icon", "guide");
      await shot(page, `platform-skills-list-${theme}-1440`);

      // Its page reads, and changes nothing: no save, no delete, a way to a copy.
      await guide.getByRole("link").click();
      await expect(page.getByRole("heading", { level: 1, name: GUIDE_TITLE })).toBeVisible();
      await expect(page.locator("[data-build-read-only]")).toContainText(
        "Ships with the platform and is updated with each release."
      );
      // Its menu offers the id to copy and no Delete.
      await page.getByRole("button", { name: "More actions" }).click();
      await expect(page.getByRole("menuitem", { name: "Copy ID" })).toBeVisible();
      await expect(page.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toBeHidden();
      await expect(page.getByRole("textbox", { name: /^Title/u })).toHaveAttribute("readonly", "");
      await shot(page, `platform-skill-page-${theme}-1440`);

      await page.getByRole("button", { name: "Copy to edit" }).click();
      const dialog = page.getByRole("dialog", { name: "Copy to edit" });
      await expect(dialog.getByRole("textbox", { name: /^Title/u })).toHaveValue(
        `${GUIDE_TITLE} (copy)`
      );
      await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
      await dialog.getByRole("textbox", { name: /^Address/u }).fill(copyName);
      await shot(page, `platform-skill-copy-dialog-${theme}-1440`);
      await dialog.getByRole("button", { name: "Continue" }).click();

      // The copy starts from the shipped text and is the instance's own.
      const content = page.getByRole("textbox", { name: /^Content/u });
      await expect(content).toHaveValue(/# Workshape Catalyst documentation/u);
      await page.getByRole("button", { name: "Create skill" }).click();
      await expect(page).toHaveURL(new RegExp(`/build/skills/${copyName}$`, "u"));
      await expect(page.locator("[data-build-read-only]")).toHaveCount(0);
      await expect(page.locator('[data-skill-origin="release"]')).toHaveCount(0);
      await content.fill("# Our guide");
      await page.getByRole("button", { name: "Save changes" }).click();
      await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
      await shot(page, `platform-skill-copy-${theme}-1440`);
    } finally {
      await deleteSkill(page, copyName);
    }
  });
}

test("the label and the copy speak German", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("vivd-catalyst:locale", "de"));
  await signInViaApi(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/build/skills");
  const guide = shippedGuide(page.getByRole("list", { name: "Skills" }));
  await expect(guide.locator('[data-skill-origin="release"]')).toHaveText("Plattform");
  await guide.getByRole("link").click();
  await expect(page.locator("[data-build-read-only]")).toContainText(
    "Kommt mit der Plattform und wird mit jedem Release aktualisiert."
  );
  await expect(page.locator("[data-build-read-only]")).toContainText(
    "kopiere es und bearbeite die Kopie"
  );
  // The step the notice names stands in the head at 390, where History folds into "…".
  await expect(
    page.locator("header[data-page-head]").getByRole("button", { name: "Zum Bearbeiten kopieren" })
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    )
  ).toBe(true);
  await shot(page, "platform-skill-page-de-390");
});
