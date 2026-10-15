import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";

const idSchema = z.object({ id: z.string() });

test("workflow actions and Copy ID stay usable at narrow widths in both languages", async ({
  page,
  context
}) => {
  test.setTimeout(180_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const signedIn = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: {
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "Workflow actions layout" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const workflowId = `workflow-layout-${randomUUID().slice(0, 8)}`;
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/instance/service-principals`,
    {
      data: {
        name: workflowId,
        displayLabel: "Workflow layout",
        description: "Runs the layout check workflow."
      }
    }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const saved = await requestWithOrigin(
    page,
    "put",
    `${apiOrigin}/api/v1/assets/workflow/${workflowId}`,
    {
      data: {
        expectedRevision: null,
        config: {
          name: workflowId,
          manifest: {
            id: workflowId,
            name: "Quarterly reconciliation of every open booking in the ledger",
            description: "Checks every booking against the ledger before the quarter closes.",
            runAs: workflowId,
            inputs: { type: "object", additionalProperties: false },
            outputs: {
              type: "object",
              properties: { done: { type: "integer" } },
              required: ["done"]
            },
            steps: [
              {
                id: "start",
                name: "Start by hand",
                type: "trigger",
                triggers: [{ kind: "manual" }]
              },
              {
                id: "result",
                name: "Result",
                type: "output",
                input: { done: { value: 1 } }
              }
            ]
          }
        }
      }
    }
  );
  expect(saved.ok(), await saved.text()).toBe(true);
  const published = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/assets/workflow/${workflowId}/publish`,
    { data: { revision: 1 } }
  );
  expect(published.ok(), await published.text()).toBe(true);
  await page.goto("/");
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (shotsDir) await mkdir(shotsDir, { recursive: true });

  for (const width of [390, 1280]) {
    for (const locale of ["de", "en"]) {
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900
        });
        await page.evaluate(
          ({ locale, theme }) => {
            localStorage.setItem("vivd-catalyst:locale", locale);
            localStorage.setItem("vivd-catalyst:theme", theme);
          },
          { locale, theme }
        );
        await page.goto(`/w/${workspaceId}/workflows/${workflowId}`);
        const header = page.locator('header[data-variant="detail"]');
        await expect(header.getByRole("heading", { level: 1 })).toBeVisible();
        const more = header.getByRole("button", {
          name: locale === "de" ? "Weitere Aktionen" : "More actions",
          exact: true
        });
        await expect(more).toBeVisible();
        if (shotsDir) {
          await page.screenshot({
            path: join(shotsDir, `workflow-actions-${theme}-${locale}-${width}.png`),
            animations: "disabled"
          });
        }
        // Partly visible buttons can still be clicked by Playwright after auto-scrolling.
        // Require every header action to fit before interacting with it.
        await expect(more).toBeInViewport({ ratio: 1 });
        for (const button of await header.getByRole("button").all()) {
          await expect(button).toBeInViewport({ ratio: 1 });
        }
        const size = await header.evaluate((element) => ({
          content: element.scrollWidth,
          visible: element.clientWidth
        }));
        expect(size.content).toBeLessThanOrEqual(size.visible);
        await more.click();
        const menu = page.getByRole("menu");
        const copy = menu.getByRole("menuitem", {
          name: locale === "de" ? "ID kopieren" : "Copy ID",
          exact: true
        });
        await expect(copy).toBeInViewport({ ratio: 1 });
        await copy.click();
        await expect(
          menu.getByRole("menuitem", {
            name: locale === "de" ? "ID kopiert" : "ID copied"
          })
        ).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(workflowId);
        if (shotsDir) {
          await page.screenshot({
            path: join(shotsDir, `workflow-copy-id-${theme}-${locale}-${width}.png`),
            animations: "disabled"
          });
        }
        await page.keyboard.press("Escape");
      }
    }
  }
});
