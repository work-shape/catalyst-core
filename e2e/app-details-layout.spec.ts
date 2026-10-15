import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";

const idSchema = z.object({ id: z.string() });

test("expanded app details fit the tab row in both languages at phone and desktop widths", async ({
  page
}) => {
  test.setTimeout(180_000);
  const signedIn = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: {
      email: "e2e-admin@example.test",
      password: "e2e-admin-password",
      rememberMe: true
    }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "App details layout" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const appId = `app-details-${randomUUID().slice(0, 8)}`;
  const saved = await requestWithOrigin(page, "put", `${apiOrigin}/api/v1/assets/app/${appId}`, {
    data: {
      workspaceId,
      expectedRevision: null,
      files: [
        {
          path: "app.yaml",
          text: `id: ${appId}\nname: Quarterly review\nkit: 1.2.0\nentry: index.html\n`
        },
        {
          path: "index.html",
          text: "<!doctype html><html><body><h1>Quarterly review</h1></body></html>"
        }
      ]
    },
    timeout: 90_000
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  await page.goto("/");
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (shotsDir) await mkdir(shotsDir, { recursive: true });

  for (const width of [390, 1280]) {
    for (const locale of ["de", "en"]) {
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.evaluate(
          ({ locale, theme }) => {
            localStorage.setItem("vivd-catalyst:locale", locale);
            localStorage.setItem("vivd-catalyst:theme", theme);
            localStorage.removeItem("vivd-catalyst:app-technical-details");
          },
          { locale, theme }
        );
        await page.goto(`/w/${workspaceId}/app-drafts/${appId}`);
        const edit = page.getByTestId("app-edit");
        const disclosure = edit.getByRole("button", {
          name: locale === "de" ? "Technische Details" : "Technical details",
          exact: true
        });
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
        await expect(edit.getByRole("tab")).toHaveCount(1);
        await disclosure.click();
        await expect(disclosure).toHaveAttribute("aria-expanded", "true");
        await expect(edit.getByRole("tab")).toHaveCount(3);
        if (shotsDir) {
          await page.screenshot({
            path: join(shotsDir, `app-details-${theme}-${locale}-${width}.png`),
            animations: "disabled"
          });
        }
        // Visibility alone passes for a disclosure clipped by the scrolling tab row.
        await expect(disclosure).toBeInViewport({ ratio: 1 });
        const row = disclosure.locator("..");
        const size = await row.evaluate((element) => ({
          content: element.scrollWidth,
          visible: element.clientWidth
        }));
        expect(size.content).toBeLessThanOrEqual(size.visible);
        await edit.getByRole("tab", { name: locale === "de" ? "Dateien" : "Files" }).click();
        await disclosure.click();
        await expect(edit.getByRole("tab")).toHaveText([locale === "de" ? "Vorschau" : "Preview"]);
        await page.reload();
        await expect(disclosure).toHaveAttribute("aria-expanded", "false");
      }
    }
  }
});
