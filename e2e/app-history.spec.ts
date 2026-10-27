import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openAppHistory } from "./app-history-fixtures";
import { expect, test } from "./test";
import { apiOrigin, uiOrigin } from "./view-fixtures";

for (const locale of ["en", "de"] as const) {
  test(`App history keeps agent names and unknown publication dates honest (${locale})`, async ({
    page
  }) => {
    test.setTimeout(120_000);
    await page.addInitScript((language) => {
      try {
        localStorage.setItem("vivd-catalyst:locale", language);
      } catch {
        /* Sandboxed Apps have no storage. */
      }
    }, locale);
    const signedIn = await page.request.post(`${apiOrigin}/api/auth/sign-in/email`, {
      headers: { Origin: uiOrigin },
      data: {
        email: "e2e-superadmin@example.test",
        password: "e2e-superadmin-password",
        rememberMe: true
      }
    });
    expect(signedIn.ok()).toBe(true);
    const { drawer, show } = await openAppHistory({
      page,
      apiURL: apiOrigin,
      baseURL: uiOrigin,
      locale
    });
    for (const width of [1440, 1280, 390]) {
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: 600 });
        await page.evaluate((value) => localStorage.setItem("vivd-catalyst:theme", value), theme);
        await page.reload();
        await show();
        await expect(drawer).toContainText(locale === "en" ? "Published" : "Veröffentlicht");
        await drawer
          .getByRole("button", {
            name: locale === "en" ? "64 draft saves" : "64 Entwurfsstände",
            exact: true
          })
          .click();
        await expect(drawer).toContainText(
          locale === "en"
            ? "Report assistant for Jana Petersen"
            : "Report assistant für Jana Petersen"
        );
        await expect(drawer).toContainText(
          locale === "en" ? "Page helper for Jana Petersen" : "Page helper für Jana Petersen"
        );
        await expect(drawer).toContainText(
          locale === "en" ? "Agent for Jana Petersen" : "Agent für Jana Petersen"
        );
        await expect(drawer).not.toContainText("Workshaper");
        await expect(drawer).not.toContainText(/before version 1|vor Version 1|Invalid Date/u);
        const last = drawer.locator('[data-revision="2"]');
        await last.scrollIntoViewIfNeeded();
        await expect(last).toBeVisible();
        const shots = process.env.E2E_SHOTS_DIR;
        if (shots) {
          await mkdir(shots, { recursive: true });
          await page.screenshot({
            path: join(shots, `history-end-${width}-${locale}-${theme}.png`),
            animations: "disabled"
          });
        }
        await page.keyboard.press("Escape");
        await expect(drawer).toBeHidden();
        // Opening, leaving and returning twice rereads the same history without a stale author.
        await show();
        await expect(drawer).toContainText("Version 1");
        await page.keyboard.press("Escape");
        await show();
        await expect(drawer).toContainText("Version 1");
        await page.keyboard.press("Escape");
      }
    }
  });
}
