import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The builder's core flow on a Workflow's page: a draft that was never published is tested
// from its draft bar, the test run ends on its own page, and the draft is then published from
// the page, after which the Workflow can be started. The Workflow is one of this spec's own.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const NAME = "Test walk";

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

test("the builder test-runs a Workflow's draft from its draft bar and publishes it", async ({
  page
}) => {
  test.setTimeout(120_000);
  const id = `test-walk-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  page.setDefaultTimeout(30_000);

  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
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
  const workflowPath = `/w/${workspaceId}/workflows/${id}`;

  // The draft bar of a Workflow never published offers a test run of the draft.
  await page.goto(workflowPath);
  const workflowPage = page.getByTestId("workflow-page");
  await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
  const bar = workflowPage.locator("[data-workflow-draft]");
  await expect(bar).toHaveAttribute("data-workflow-draft", "unpublished");
  await bar.getByRole("button", { name: "Test run", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: `Test “${NAME}”?` });
  await dialog.getByLabel("Note").fill("Hello from the test run");
  await dialog.getByRole("button", { name: "Start test run", exact: true }).click();
  await expect(dialog).toBeHidden();

  // The run of the draft opens and ends.
  await expect(page).toHaveURL(new RegExp(`${workflowPath}/runs/[^/]+$`, "u"));
  const runPage = page.getByTestId("workflow-run-page");
  await expect(runPage.locator("[data-test-run]")).toBeVisible();
  await expect(runPage.getByRole("button", { name: "Test again", exact: true })).toBeVisible({
    timeout: 60_000
  });
  const runId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const run = await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`);
  expect(run.ok()).toBe(true);
  expect(await run.json()).toMatchObject({
    workflow: id,
    mode: "test",
    status: "done",
    startedBy: { kind: "user" }
  });

  // Testing published nothing; the publish, after one question, makes the draft live and the
  // Workflow can be started.
  await page.goto(workflowPath);
  await expect(bar).toHaveAttribute("data-workflow-draft", "unpublished");
  await workflowPage.locator("[data-workflow-publish]").click();
  const publish = page.getByRole("dialog", { name: `Publish “${NAME}”?` });
  await publish.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(publish).toBeHidden();
  await expect(bar).toHaveCount(0);
  await expect(workflowPage.getByRole("button", { name: "Start now", exact: true })).toBeVisible();
});
