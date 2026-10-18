import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";
import { apiOrigin } from "./view-fixtures";

// EW-CAN in the browser (Events, Workflows And Guardrails check 112): the runs list shows the
// parts of a run that continued as new as one Lauf, `<key>/1`, `/2`, `/3`, which unfolds to each
// part, keeps its place while older pages load, and opens a part's own run.
//
// The engine's half of check 112 (a loop over 50,000 rows that continues at its limit) is
// covered by the engine's tests. Here one real run of a published Workflow stands as the newest
// part, so a part opens a real run page; the list's answer around it is laid out by the spec.

const idSchema = z.object({ id: z.string() });
const runSchema = z.object({ id: z.string(), status: z.string() }).passthrough();
type WireRun = z.infer<typeof runSchema>;

async function setUp(page: Page) {
  const signedIn = await requestWithOrigin(page, "post", `${apiOrigin}/api/auth/sign-in/email`, {
    data: {
      email: "e2e-superadmin@example.test",
      password: "e2e-superadmin-password",
      rememberMe: true
    }
  });
  expect(signedIn.ok()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiOrigin}/api/v1/workspaces`, {
    data: { name: "Continued runs" }
  });
  expect(created.ok()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const workflowId = `ledger-import-${randomUUID().slice(0, 8)}`;
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/instance/service-principals`,
    {
      data: {
        name: workflowId,
        displayLabel: "Ledger import",
        description: "Imports the ledger in parts."
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
            name: "Ledger import",
            description: "Imports every booking of the ledger.",
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
              { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
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
  const started = await requestWithOrigin(
    page,
    "post",
    `${apiOrigin}/api/v1/workflows/${workflowId}/runs`,
    { data: { key: "2026-10-17" } }
  );
  expect(started.ok(), await started.text()).toBe(true);
  const runId = runSchema.parse(await started.json()).id;
  let real: WireRun | undefined;
  await expect
    .poll(
      async () => {
        const read = await page.request.get(`${apiOrigin}/api/v1/workflow-runs/${runId}`);
        real = runSchema.parse(await read.json());
        return real.status;
      },
      { timeout: 30_000 }
    )
    .toBe("done");
  if (real === undefined) throw new Error("The run was not read.");
  return { workspaceId, workflowId, real };
}

/**
 * The list's answer: the real run as part 3 on the newest version, a run started by hand
 * between the parts, then parts 2 and 1 on the version before, part 1 on the next page.
 */
function laufPages(real: WireRun) {
  const root = `${real.id}-part-1`;
  const at = (hour: number) => `2026-10-17T0${hour}:00:00.000Z`;
  const part = (number: number, extra: Record<string, unknown>) => ({
    ...real,
    labels: { source: "ledger", year: "2026" },
    continuation: {
      rootRunId: root,
      ...(number === 1 ? {} : { previousRunId: `${real.id}-part-${number - 1}` }),
      number
    },
    ...extra
  });
  const part3 = part(3, {
    status: "running",
    stepRunCount: 10_004,
    createdAt: at(3),
    startedAt: at(3)
  });
  const part2 = part(2, {
    id: `${real.id}-part-2`,
    status: "continued",
    stepRunCount: 20_000,
    definitionRevisionId: "earlier-revision",
    createdAt: at(2),
    startedAt: at(2),
    finishedAt: `2026-10-17T02:59:00.000Z`
  });
  const part1 = part(1, {
    id: root,
    status: "continued",
    stepRunCount: 20_000,
    definitionRevisionId: "earlier-revision",
    createdAt: at(1),
    startedAt: at(1),
    finishedAt: `2026-10-17T01:59:00.000Z`
  });
  // A run started by hand between the parts, with no key and in no Lauf.
  const other = {
    ...real,
    id: `${real.id}-other`,
    runKey: undefined,
    createdAt: "2026-10-17T02:30:00.000Z",
    startedAt: "2026-10-17T02:30:00.000Z",
    finishedAt: "2026-10-17T02:31:00.000Z"
  };
  return {
    first: { items: [part3, other, part2], nextCursor: "older" },
    second: { items: [part1] }
  };
}

async function answerRuns(page: Page, workflowId: string, real: WireRun) {
  const pages = laufPages(real);
  await page.route(`**/api/v1/workflows/${workflowId}/runs?*`, (route: Route) => {
    if (route.request().method() !== "GET") return route.continue();
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ json: cursor === null ? pages.first : pages.second });
  });
}

test("a run that continued as new is one Lauf that unfolds to its parts (check 112)", async ({
  page
}, testInfo) => {
  test.setTimeout(240_000);
  const { workspaceId, workflowId, real } = await setUp(page);
  await answerRuns(page, workflowId, real);
  const runsPage = `/w/${workspaceId}/workflows/${workflowId}/runs`;
  await page.goto(runsPage);

  const list = page.getByTestId("workflow-runs-page");
  const lauf = list.locator(`[data-run-group="${real.id}-part-1"]`);
  const toggle = lauf.locator("button[aria-expanded]").first();
  const parts = lauf.locator("[data-run-part]");
  await expect(lauf).toContainText("key 2026-10-17 · parts 2 to 3, earlier ones under Show more");
  await expect(lauf).toContainText("30,004 steps in these parts");
  await expect(lauf).toContainText("source: ledger · year: 2026");
  await expect(lauf).toContainText("Continued on a newly published version");
  await expect(parts).toHaveCount(0);

  // Unfolded, the Lauf names each part by its key and number; only part 3 moved version.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0)).toContainText("2026-10-17/3");
  await expect(parts.nth(0)).toContainText("New version");
  await expect(parts.nth(1)).toContainText("2026-10-17/2");
  await expect(parts.nth(1)).toContainText("Continued");
  await expect(parts.nth(1)).not.toContainText("New version");

  // The older page brings part 1 into the same row, which stays open.
  await list.getByRole("button", { name: "Show more", exact: true }).click();
  await expect(lauf).toContainText("3 parts · 50,004 steps");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(parts).toHaveCount(3);
  await expect(parts.nth(2)).toContainText("2026-10-17/1");
  // Each part is one row with one link, to its own run.
  for (const [index, id] of [real.id, `${real.id}-part-2`, `${real.id}-part-1`].entries()) {
    const links = parts.nth(index).getByRole("link");
    await expect(links).toHaveCount(1);
    await expect(links).toHaveAttribute("href", new RegExp(`/runs/${id}$`, "u"));
  }
  await expect(list.locator("[data-run-group]")).toHaveCount(1);

  // Folded, the parts are behind the row again; unfolded, a part opens its own run.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(parts).toHaveCount(0);
  await toggle.click();
  await parts.nth(0).getByRole("link").click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${workflowId}/runs/${real.id}$`, "u"));
  await expect(page.getByTestId("workflow-run-page")).toBeVisible();
  await page.goBack();
  await expect(lauf).toBeVisible();

  // Pictures of the unfolded Lauf, as the design review reads them: always in the test's
  // output folder, which CI uploads as `test-results/**/ew-can-runs-*.png`, and also in
  // `E2E_SHOTS_DIR` where it is set.
  const shotsDir = process.env.E2E_SHOTS_DIR;
  if (shotsDir) await mkdir(shotsDir, { recursive: true });
  for (const width of [390, 1280]) {
    for (const locale of ["en", "de"]) {
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
        await page.evaluate(
          ({ locale, theme }) => {
            localStorage.setItem("vivd-catalyst:locale", locale);
            localStorage.setItem("vivd-catalyst:theme", theme);
          },
          { locale, theme }
        );
        await page.goto(runsPage);
        await list
          .getByRole("button", {
            name: locale === "de" ? "Mehr anzeigen" : "Show more",
            exact: true
          })
          .click();
        await expect(lauf).toHaveAttribute("data-run-parts", "3");
        await toggle.click();
        await expect(parts).toHaveCount(3);
        // Nothing at phone width runs past the window.
        const size = await page.evaluate(() => ({
          content: document.documentElement.scrollWidth,
          visible: document.documentElement.clientWidth
        }));
        expect(size.content).toBeLessThanOrEqual(size.visible);
        const name = `ew-can-runs-${theme}-${locale}-${width}.png`;
        const shot = await page.screenshot({
          path: testInfo.outputPath(name),
          animations: "disabled"
        });
        if (shotsDir) await writeFile(join(shotsDir, name), shot);
      }
    }
  }
});
