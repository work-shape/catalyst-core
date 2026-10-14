import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The test run of a Workflow's draft from the canvas's draft bar (EW-5t, ADR-0031): Test run
// asks for the draft's inputs, starts a run of the draft in mode `test` as the builder, and
// opens it; the run page says it is a test run and whose rights it read with. The Workflow is
// never published, so nothing of it could have run otherwise. Fails without EW-5t: the bar
// offered Publish and Discard only.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };
const NAME = "Test walk";

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: superadmin.email, password: superadmin.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("the builder starts a test run of a Workflow's draft from its draft bar", async ({ page }) => {
  test.setTimeout(120_000);
  const id = `test-walk-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);

  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Bounds the test runs of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const saved = await requestWithOrigin(page, "put", `${apiBaseUrl}/api/v1/assets/workflow/${id}`, {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        manifest: {
          id,
          name: NAME,
          runAs,
          inputs: {
            type: "object",
            properties: { note: { type: "string", title: "Note" } },
            required: ["note"]
          },
          outputs: { type: "object", properties: { note: { type: "string" } } },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "result",
              name: "Result",
              type: "output",
              input: { note: { ref: { step: "start", path: "input.note" } } }
            }
          ]
        }
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Test walk ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;

  // The draft bar of a Workflow never published offers Test run beside Publish.
  await page.goto(`/w/${workspaceId}/workflows/${id}`);
  const workflowPage = page.getByTestId("workflow-page");
  await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
  const bar = workflowPage.locator("[data-workflow-draft]");
  await expect(bar).toHaveAttribute("data-workflow-draft", "unpublished");
  await bar.getByRole("button", { name: "Test run", exact: true }).click();

  // The question asks for the draft's inputs and says what a test run does.
  const dialog = page.getByRole("dialog", { name: `Test “${NAME}”?` });
  await expect(dialog).toContainText("reads live data as you");
  await dialog.getByLabel("Note").fill("Hello from the test run");
  await dialog.getByRole("button", { name: "Start test run", exact: true }).click();
  await expect(dialog).toBeHidden();

  // The run of the draft opens and ends; its page says it is a test run.
  await expect(page).toHaveURL(new RegExp(`/w/${workspaceId}/workflows/${id}/runs/[^/]+$`, "u"));
  const runPage = page.getByTestId("workflow-run-page");
  await expect(runPage.locator("[data-test-run]")).toHaveText("Test run");
  await expect(runPage.locator("[data-run-test]")).toContainText("Test run of the draft");
  await expect(runPage.getByRole("heading", { level: 1 })).toContainText("Test run of");
  await expect(runPage.getByRole("button", { name: "Test again", exact: true })).toBeVisible({
    timeout: 60_000
  });

  // The instance kept it as a test run of the draft, started by the builder.
  const runId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const run = await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`);
  expect(run.ok()).toBe(true);
  expect(await run.json()).toMatchObject({
    workflow: id,
    mode: "test",
    status: "done",
    startedBy: { kind: "user" }
  });
  // Nothing was published by testing.
  await page.goto(`/w/${workspaceId}/workflows/${id}`);
  await expect(bar).toHaveAttribute("data-workflow-draft", "unpublished");
});
