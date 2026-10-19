import { expect, test } from "./test";
import { requestWithOrigin } from "./request-with-origin";

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const assignmentPath = `${apiBaseUrl}/api/v1/instance/access/scope-assignments`;

test("an administrator edits data scope assignments in both languages, at short and phone sizes", async ({
  page,
  accessState: _accessState
}) => {
  const signedIn = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: "e2e-admin@example.test", password: "e2e-admin-password", rememberMe: true }
  });
  expect(signedIn.ok()).toBe(true);
  const me: { id: string } = await (await page.request.get(`${apiBaseUrl}/api/v1/me`)).json();
  const clear = () =>
    requestWithOrigin(page, "put", assignmentPath, {
      data: {
        dimension: "mandant",
        holderKind: "user",
        holderId: me.id,
        effect: "allow",
        values: []
      }
    });
  expect((await clear()).ok()).toBe(true);
  try {
    for (const locale of ["en", "de"] as const) {
      for (const theme of ["light", "dark"] as const) {
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
          await expect(values).toHaveValue("101, 102");
        }
        await values.scrollIntoViewIfNeeded();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
          )
        ).toBe(true);
        await test.info().attach(`scope-${locale}-${theme}`, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png"
        });
      }
    }
  } finally {
    expect((await clear()).ok()).toBe(true);
  }
});
