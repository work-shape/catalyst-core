import { randomUUID } from "node:crypto";
import { signIn } from "./inbox-fixtures";
import { builtPage, pageSurface, sendToolCall } from "./page-surface-fixtures";
import { expect, test } from "./test";

const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };

test("a new chat edits an App and the old chat reloads after a stale save", async ({ page }) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 8);
  const name = `checkout-${tag}`;
  const title = `Checkout ${tag}`;
  const html = (text: string) =>
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${text}</h1></body></html>`;
  await page.setViewportSize({ width: 1280, height: 760 });
  await signIn(page, superadmin);
  await page.goto("/");
  await expect(page).toHaveURL(/\/w\/[^/]+$/u);
  const workspace = page.url();
  await sendToolCall(page, "workspace.write_file", {
    path: `${name}/index.html`,
    content: html("Built in chat one")
  });
  await sendToolCall(page, "workspace.open", { path: name });
  await sendToolCall(page, "app.save", { path: name, name: title });
  const firstChat = page.url();
  await page.goto(workspace);
  await sendToolCall(page, "app.edit", { name });
  await expect(builtPage(page).getByRole("heading", { name: "Built in chat one" })).toBeVisible();
  const secondChat = page.url();
  const path = `apps/${name}`;
  await sendToolCall(page, "workspace.write_file", {
    path: `${path}/index.html`,
    content: html("Changed in chat two")
  });
  await sendToolCall(page, "workspace.open", { path });
  await sendToolCall(page, "app.save", { path, name: title });
  await expect(page.getByTestId("app-card")).toContainText(title);
  await expect(page.getByTestId("page-card")).toHaveCount(0);
  const savedApp = () =>
    page
      .getByTestId("app-edit")
      .getByTestId("page-preview-frame")
      .contentFrame()
      .frameLocator("iframe");
  // A reloaded conversation restores the App card; its Open link shows the saved draft.
  // Switch away and back twice, then open the current App each time.
  for (let visit = 0; visit < 2; visit += 1) {
    await page.goto(firstChat);
    await page.goto(secondChat);
    await page.getByTestId("app-card-open").click();
    await expect(savedApp().getByRole("heading", { name: "Changed in chat two" })).toBeVisible();
  }
  for (const locale of ["en", "de"] as const) {
    await page.evaluate((chosen) => localStorage.setItem("vivd-catalyst:locale", chosen), locale);
    await page.reload();
    for (const width of [1280, 390]) {
      for (const scheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height: 760 });
        await page.emulateMedia({ colorScheme: scheme });
        await expect(
          savedApp().getByRole("heading", { name: "Changed in chat two" })
        ).toBeVisible();
        const screenshot = test.info().outputPath(`checkout-${locale}-${width}-${scheme}.png`);
        await page.screenshot({ path: screenshot });
        await test.info().attach(`checkout-${locale}-${width}-${scheme}`, {
          path: screenshot,
          contentType: "image/png"
        });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 760 });
  await page.evaluate(() => localStorage.setItem("vivd-catalyst:locale", "en"));
  await page.goto(firstChat);
  // Wait for the three restored answers before the helper counts the next tool answer.
  await expect(page.getByText(/^Tool work completed:/u)).toHaveCount(3);
  await sendToolCall(page, "app.save", { path: name, name: title });
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("saved by");
  await expect(page.locator('[data-role="assistant"]').last()).toContainText("app.edit");
  await sendToolCall(page, "app.edit", { name });
  await expect(builtPage(page).getByRole("heading", { name: "Changed in chat two" })).toBeVisible();
  await expect(pageSurface(page)).toBeVisible();
});
