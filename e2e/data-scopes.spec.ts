import type { Page } from "@playwright/test";
import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const assignmentPath = `${apiBaseUrl}/api/v1/instance/access/scope-assignments`;

/** E2E User's assignment, which the administrator edits; nobody writes their own. */
let member: { id: string } | undefined;

/** Clears the member's assignment as the administrator signed in on `page`. */
async function clear(page: Page): Promise<void> {
  if (!member) return;
  const cleared = await requestWithOrigin(page, "put", assignmentPath, {
    data: {
      dimension: "mandant",
      holderKind: "user",
      holderId: member.id,
      effect: "allow",
      values: []
    }
  });
  expect(cleared.ok()).toBe(true);
}

// After the test, in a time of its own: a slow look is reported where it stood, and the
// member's assignment is cleared all the same.
test.afterEach(async ({ page }) => {
  await clear(page);
});

// Each language and theme is a test of its own, with its own time: dark at a phone's width,
// light in a short window.
for (const locale of ["en", "de"] as const) {
  for (const theme of ["light", "dark"] as const) {
    const size = theme === "dark" ? "phone" : "short";
    test(`an administrator edits data scope assignments in ${locale}, ${theme}, at ${size} size`, async ({
      page,
      accessState: _accessState
    }) => {
      const signIn = async (email: string, password: string) => {
        const response = await requestWithOrigin(
          page,
          "post",
          `${apiBaseUrl}/api/auth/sign-in/email`,
          { data: { email, password, rememberMe: true } }
        );
        expect(response.ok()).toBe(true);
        const me: { id: string } = await (await page.request.get(`${apiBaseUrl}/api/v1/me`)).json();
        return me;
      };
      member = await signIn("e2e-user@example.test", "e2e-user-password");
      await signIn("e2e-admin@example.test", "e2e-admin-password");
      // The tab opens on the administrator's own assignment, which they cannot save.
      const chooseMember = async () => {
        await page.getByRole("button", { name: "E2E Admin", exact: true }).click();
        await page.getByRole("option", { name: /E2E User/u }).click();
        await expect(page.getByRole("listbox")).toHaveCount(0);
      };
      await clear(page);
      await page.addInitScript(
        ({ locale, theme }) => {
          localStorage.setItem("vivd-catalyst:locale", locale);
          localStorage.setItem("vivd-catalyst:theme", theme);
        },
        { locale, theme }
      );
      await page.setViewportSize({ width: theme === "dark" ? 390 : 1280, height: 640 });
      await page.goto("/settings/instance/access");
      const scopeTab = page.getByRole("tab", {
        name: locale === "de" ? "Datenzugriff" : "Data access",
        exact: true
      });
      await scopeTab.click();
      await chooseMember();
      const values = page.getByLabel(
        locale === "de" ? "Werte, durch Komma getrennt" : "Values, separated by commas"
      );
      await expect(values).toBeVisible();
      await values.fill("101, 102");
      const saved = page.waitForResponse(
        (response) => response.url() === assignmentPath && response.request().method() === "PUT"
      );
      await page
        .getByRole("button", {
          name: locale === "de" ? "Zuordnung speichern" : "Save assignment",
          exact: true
        })
        .click();
      expect((await saved).ok()).toBe(true);
      await expect(
        page.getByText(locale === "de" ? "Zuordnung gespeichert." : "Assignment saved.", {
          exact: true
        })
      ).toBeVisible();
      for (let step = 0; step < 2; step++) {
        await page
          .getByRole("tab", { name: locale === "de" ? "Prüfen" : "Check", exact: true })
          .click();
        await scopeTab.click();
        await chooseMember();
        await expect(values).toHaveValue("101, 102");
      }
      await values.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
        )
      ).toBe(true);
      await test.info().attach(`scope-${locale}-${theme}`, {
        body: await page.screenshot({
          path: test.info().outputPath(`evidence-data-scope-${locale}-${theme}.png`),
          fullPage: true
        }),
        contentType: "image/png"
      });
    });
  }
}
