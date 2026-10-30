import { randomUUID } from "node:crypto";
import { type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Re-running an ended run from a chosen step (EW-11): the step's panel on the run page offers
// "Run again from here", the confirmed re-run opens the new run's page, which names the run it
// re-runs, marks the reused step with the way back, and a step that changed since is refused.
// The steps are `code` steps, which the suite's local sandbox runs. Fails without the screens
// and the engine half of EW-11.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };
const NAME = "Re-run walk";

const ADD = `
import json, sys
data = json.load(sys.stdin)
with open("output.json", "w") as out:
    json.dump({"sum": sum(data["numbers"])}, out)
`;
const DOUBLE = `
import json, sys
data = json.load(sys.stdin)
with open("output.json", "w") as out:
    json.dump({"double": data["sum"] * 2}, out)
`;

const runSchema = z.object({
  id: z.string(),
  status: z.string(),
  mode: z.string().optional(),
  rerunOf: z
    .object({ runId: z.string(), fromStep: z.string(), reusedSteps: z.array(z.string()) })
    .optional()
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

/** Waits for a run to end `done`, and answers it. */
async function ended(page: Page, runId: string): Promise<z.infer<typeof runSchema>> {
  let run: z.infer<typeof runSchema> | undefined;
  await expect
    .poll(
      async () => {
        const read = await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`);
        run = runSchema.parse(await read.json());
        return run.status;
      },
      { timeout: 90_000 }
    )
    .toBe("done");
  if (run === undefined) throw new Error("The run was not read");
  return run;
}

function manifest(id: string, runAs: string, doubleInput: Record<string, unknown>) {
  return {
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
        id: "double",
        name: "Double the sum",
        type: "code",
        file: "double.py",
        input: doubleInput,
        inputSchema: { type: "object" },
        outputSchema: { type: "object" }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { double: { ref: { step: "double", path: "" } } }
      }
    ]
  };
}

const files = [
  { path: "steps/add.py", content: ADD },
  { path: "steps/double.py", content: DOUBLE }
];

test("a test run is run again from a chosen step on its page", async ({ page }) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  const id = `rerun-walk-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  const sumOf = { sum: { ref: { step: "add", path: "sum" } } };

  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Bounds the test runs of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const save = (expectedRevision: number | null, doubleInput: Record<string, unknown>) =>
    requestWithOrigin(page, "put", `${apiBaseUrl}/api/v1/assets/workflow/${id}`, {
      data: {
        expectedRevision,
        config: { name: id, manifest: manifest(id, runAs, doubleInput), files }
      }
    });
  const saved = await save(null, sumOf);
  expect(saved.ok(), await saved.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Re-run walk ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = z.object({ id: z.string() }).parse(await created.json()).id;

  const started = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/workflows/${id}/test-runs`,
    { data: { input: { numbers: [1, 2, 3] } } }
  );
  expect(started.ok(), await started.text()).toBe(true);
  const first = await ended(page, runSchema.parse(await started.json()).id);

  // The panel of a step after the first one offers to run the run again from there.
  await page.goto(`/w/${workspaceId}/workflows/${id}/runs/${first.id}`);
  const runPage = page.getByTestId("workflow-run-page");
  await runPage.locator('[data-flow-id="double"]').click();
  const panel = page.locator('[data-step-panel="double"]');
  await panel.getByRole("tab", { name: "This run", exact: true }).click();
  const rerun = panel.locator("[data-step-rerun]");
  await expect(rerun).toHaveAttribute("data-step-rerun", "offered");
  await page.screenshot({
    path: test.info().outputPath("evidence-step-rerun-offered.png"),
    animations: "disabled"
  });
  await rerun.getByRole("button", { name: "Run again from here", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Run again from “Double the sum”?");
  await dialog.getByRole("button", { name: "Run again", exact: true }).click();

  // The new run's page names the run it re-runs, and the reused step points back to it.
  await expect(page).not.toHaveURL(new RegExp(`/runs/${first.id}$`, "u"));
  const againId = /\/runs\/([^/]+)$/u.exec(page.url())?.[1];
  if (againId === undefined) throw new Error("The re-run's page did not open");
  const again = await ended(page, againId);
  expect(again.mode).toBe("test");
  expect(again.rerunOf).toEqual({ runId: first.id, fromStep: "double", reusedSteps: ["add"] });
  await expect(page.locator("[data-run-rerun-of]")).toContainText(
    "This run runs an earlier run again from “Double the sum”."
  );
  await runPage.locator('[data-flow-id="add"]').click();
  const addPanel = page.locator('[data-step-panel="add"]');
  await addPanel.getByRole("tab", { name: "This run", exact: true }).click();
  const reused = addPanel.locator(`[data-reused-from="${first.id}"]`);
  await expect(reused).toContainText("This step was not run again");
  await page.screenshot({
    path: test.info().outputPath("evidence-step-rerun-reused.png"),
    animations: "disabled"
  });
  await reused.getByRole("button", { name: "Open the earlier run", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/runs/${first.id}$`, "u"));

  // Once a step before it changed in the draft, the run is not re-run from `result`.
  const changed = await save(1, {
    sum: { ref: { step: "add", path: "sum" } },
    note: { value: "changed" }
  });
  expect(changed.ok(), await changed.text()).toBe(true);
  await page.reload();
  await runPage.locator('[data-flow-id="result"]').click();
  const resultPanel = page.locator('[data-step-panel="result"]');
  await resultPanel.getByRole("tab", { name: "This run", exact: true }).click();
  const refused = resultPanel.locator("[data-step-rerun]");
  await expect(refused).toHaveAttribute("data-step-rerun", "refused");
  await expect(refused).toContainText("Double the sum");
  await page.screenshot({
    path: test.info().outputPath("evidence-step-rerun-changed.png"),
    animations: "disabled"
  });
});
