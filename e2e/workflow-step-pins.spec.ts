import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Pinned step outputs for test runs (EW-10): the builder pins the output a step had in a test
// run from that step's panel, the next test run of the draft ends the step with it and marks it
// with the way to the run it came from, and the Workflow's page shows the pin with Unpin. The
// step is a `code` step, which the suite's local sandbox runs. Fails without the screens and
// the engine half of EW-10.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };
const NAME = "Pin walk";

const SCRIPT = `
import json, sys
data = json.load(sys.stdin)
with open("output.json", "w") as out:
    json.dump({"sum": sum(data["numbers"])}, out)
`;

const runSchema = z.object({
  id: z.string(),
  status: z.string(),
  mode: z.string().optional(),
  pinnedSteps: z.array(z.object({ step: z.string(), sourceRunId: z.string() })).optional()
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** Starts a test run of the draft and waits for it to end. */
async function testRun(page: Page, id: string): Promise<z.infer<typeof runSchema>> {
  const started = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/workflows/${id}/test-runs`,
    { data: { input: { numbers: [1, 2, 3] } } }
  );
  expect(started.ok(), await started.text()).toBe(true);
  const runId = runSchema.parse(await started.json()).id;
  let ended: z.infer<typeof runSchema> | undefined;
  await expect
    .poll(
      async () => {
        const read = await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`);
        ended = runSchema.parse(await read.json());
        return ended.status;
      },
      { timeout: 90_000 }
    )
    .toBe("done");
  if (ended === undefined) throw new Error("The test run was not read");
  return ended;
}

test("the builder pins a step's output for the next test runs of the draft", async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  const id = `pin-walk-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;

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
          inputs: { type: "object", properties: { numbers: { type: "array" } } },
          outputs: { type: "object" },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            {
              id: "add",
              name: "Add the numbers",
              type: "code",
              file: "add.py",
              input: { numbers: { ref: { step: "start", path: "input.numbers" } } },
              inputSchema: { type: "object" },
              outputSchema: { type: "object" }
            },
            {
              id: "result",
              name: "Result",
              type: "output",
              input: { add: { ref: { step: "add", path: "" } } }
            }
          ]
        },
        files: [{ path: "steps/add.py", content: SCRIPT }]
      }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Pin walk ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;

  // A first test run computes the step; its panel offers to use the output in test runs.
  const first = await testRun(page, id);
  expect(first.pinnedSteps).toBeUndefined();
  await page.goto(`/w/${workspaceId}/workflows/${id}/runs/${first.id}`);
  const runPage = page.getByTestId("workflow-run-page");
  await runPage.locator('[data-flow-id="add"]').click();
  const panel = page.locator('[data-step-panel="add"]');
  await panel.getByRole("tab", { name: "This run", exact: true }).click();
  const pin = panel.locator("[data-step-pin]");
  await expect(pin).toHaveAttribute("data-step-pin", "off");
  await pin.getByRole("button", { name: "Use this output in test runs", exact: true }).click();
  await expect(pin).toHaveAttribute("data-step-pin", "this-run");
  await expect(pin).toContainText("Your test runs use this step's output from this run.");
  await expect(pin.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath("evidence-step-pin-run.png"),
    animations: "disabled"
  });

  // The next test run takes the step's output from the pin and records it.
  const second = await testRun(page, id);
  expect(second.pinnedSteps).toEqual([{ step: "add", sourceRunId: first.id }]);
  await page.goto(`/w/${workspaceId}/workflows/${id}/runs/${second.id}`);
  await runPage.locator('[data-flow-id="add"]').click();
  await panel.getByRole("tab", { name: "This run", exact: true }).click();
  const mark = panel.locator(`[data-pinned-from="${first.id}"]`);
  await expect(mark).toContainText("This test run took the step's output from an earlier run");
  await expect(panel.locator("[data-step-pin]")).toHaveAttribute("data-step-pin", "other-run");
  await page.screenshot({
    path: test.info().outputPath("evidence-step-pin-used.png"),
    animations: "disabled"
  });
  await mark.getByRole("button", { name: "Open that run", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${first.id}$`, "u"));

  // The Workflow's page marks the pinned step in its panel, and Unpin drops the pin.
  await page.goto(`/w/${workspaceId}/workflows/${id}`);
  const workflowPage = page.getByTestId("workflow-page");
  await expect(workflowPage.getByRole("heading", { level: 1 })).toHaveText(NAME);
  await workflowPage.locator('[data-flow-id="add"]').click();
  const draftPin = page.locator('[data-step-panel="add"] [data-step-pin]');
  await expect(draftPin).toContainText("Your test runs use this step's output from a run of");
  await page.screenshot({
    path: test.info().outputPath("evidence-step-pin-workflow.png"),
    animations: "disabled"
  });
  await draftPin.getByRole("button", { name: "Unpin", exact: true }).click();
  await expect(draftPin).toBeHidden();

  // Without the pin, the next test run runs the step again.
  const third = await testRun(page, id);
  expect(third.pinnedSteps).toBeUndefined();
});
