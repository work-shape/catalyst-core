import { randomUUID } from "node:crypto";
import { type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// The Settings of an AI step and of a script (workflow-canvas 9.4, Events check 125): a person
// changes an AI step's instructions, adds the answer field "summary" of kind text, required,
// and picks the result of an earlier step as an input, and the saved draft holds the
// instructions, an `outputSchema` with `summary` required and an `inputSchema` of the picked
// field's type; an answer field cannot nest a group in a group; a changed script is what the
// next test run runs. Fails without WF-EDIT-2: both kinds were left to the agent.

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };

const idSchema = z.object({ id: z.string() });
const assetSchema = z.object({
  revision: z.number(),
  config: z.object({
    manifest: z.object({ steps: z.array(z.record(z.string(), z.unknown())) }),
    files: z.array(z.object({ path: z.string(), content: z.string() })).optional()
  })
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: superadmin.email, password: superadmin.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

const assetUrlOf = (id: string) => `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

const COUNT_STEP = {
  id: "count",
  name: "Count the notes",
  type: "code",
  file: "count.py",
  input: {},
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object", properties: { n: { type: "integer" } }, required: ["n"] }
};
const SCRIPT = 'import json\nprint(json.dumps({"n": 1}))\n';

/** Stores a draft of a Workflow of these steps, with the script of the count step. */
async function storeDraft(page: Page, id: string, runAs: string, steps: unknown[]) {
  const stored = await requestWithOrigin(page, "put", assetUrlOf(id), {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        manifest: {
          id,
          name: `Notes ${id.slice(-8)}`,
          runAs,
          inputs: { type: "object", additionalProperties: false },
          outputs: {
            type: "object",
            properties: { done: { type: "integer" } },
            required: ["done"]
          },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            COUNT_STEP,
            ...steps,
            {
              id: "result",
              name: "Result",
              type: "output",
              input: { done: { ref: { step: "count", path: "n" } } }
            }
          ]
        },
        files: [{ path: "steps/count.py", content: SCRIPT }]
      }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
}

async function readAsset(page: Page, id: string) {
  const response = await page.request.get(assetUrlOf(id));
  expect(response.ok()).toBe(true);
  return assetSchema.parse(await response.json());
}

async function openSettings(page: Page, step: string): Promise<Locator> {
  const canvas = page.getByTestId("workflow-page").getByTestId("workflow-canvas");
  await canvas.locator(`[data-flow-id="${step}"]`).click();
  const panel = page.locator(`[data-step-panel="${step}"]`);
  await panel.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(panel.locator(`[data-step-settings="${step}"]`)).toBeVisible();
  return panel;
}

test("an AI step's and a script's Settings save what it gets, does and answers with", async ({
  page
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const suffix = randomUUID().slice(0, 8);
  const runAs = `settings-agent-${suffix}-runner`;
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflows of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Settings agent ${suffix}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;

  // The AI step: instructions, an answer field and an input picked from the count.
  const withAgent = `settings-agent-${suffix}`;
  await storeDraft(page, withAgent, runAs, [
    {
      id: "summary",
      name: "Write the summary",
      type: "agent",
      instructions: "Summarise the notes.",
      input: {},
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { note: { type: "string" } } }
    }
  ]);
  await page.goto(`/w/${workspaceId}/workflows/${withAgent}`);
  let panel = await openSettings(page, "summary");
  await panel.getByLabel("Instructions").fill("Write one line about the notes.");

  const answers = panel.locator("[data-step-answers]");
  await answers.getByRole("button", { name: "Add field", exact: true }).click();
  const added = answers.locator("[data-field-id]").last();
  await added.getByLabel("Name", { exact: true }).fill("summary");
  await added.getByRole("switch").click();
  // A group's fields offer no group: no answer field nests itself.
  await answers.getByRole("button", { name: "Add field", exact: true }).click();
  // The fields in their order, a group's own after it: note, summary, client and its field.
  const group = answers.locator("[data-field-id]").nth(2);
  await group.getByLabel("Name", { exact: true }).fill("client");
  await group.getByLabel("Kind", { exact: true }).selectOption({ label: "Group of fields" });
  await group.getByRole("button", { name: "Add field", exact: true }).click();
  const inner = group.locator("[data-field-id]").first();
  await expect(inner.getByLabel("Kind", { exact: true }).locator("option")).not.toContainText([
    "Group of fields",
    "List of groups"
  ]);
  await inner.getByLabel("Name", { exact: true }).fill("name");

  const inputs = panel.locator("[data-step-inputs]");
  await inputs.getByRole("button", { name: "Add a value", exact: true }).click();
  await inputs.getByLabel("Name of the value").fill("count");
  await inputs.getByRole("radio", { name: "From a step" }).click();
  await inputs.getByRole("button", { name: /^Value of count/u }).click();
  await page.getByRole("listbox").getByRole("option", { name: "n", exact: true }).click();

  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect
    .poll(async () => (await readAsset(page, withAgent)).config.manifest.steps[2]?.instructions)
    .toBe("Write one line about the notes.");
  const summary = (await readAsset(page, withAgent)).config.manifest.steps[2];
  expect(summary?.outputSchema).toEqual({
    type: "object",
    properties: {
      note: { type: "string" },
      summary: { type: "string" },
      client: { type: "object", properties: { name: { type: "string" } } }
    },
    required: ["summary"]
  });
  expect(summary?.input).toEqual({ count: { ref: { step: "count", path: "n" } } });
  expect(summary?.inputSchema).toEqual({
    type: "object",
    properties: { count: { type: "integer" } },
    required: ["count"]
  });

  // The script: changed in Settings, it is what the next test run runs.
  const withScript = `settings-script-${suffix}`;
  await storeDraft(page, withScript, runAs, []);
  await page.goto(`/w/${workspaceId}/workflows/${withScript}`);
  panel = await openSettings(page, "count");
  const script = panel.getByRole("textbox", { name: "Script", exact: true });
  await expect(script).toHaveValue(SCRIPT);
  await script.fill('import json\nprint(json.dumps({"n": 2}))\n');
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => (await readAsset(page, withScript)).config.files)
    .toEqual([{ path: "steps/count.py", content: 'import json\nprint(json.dumps({"n": 2}))\n' }]);

  const bar = page.getByTestId("workflow-page").locator("[data-workflow-draft]");
  await bar.getByRole("button", { name: "Test run", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Test “/u });
  await dialog.getByRole("button", { name: "Start test run", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${withScript}/runs/[^/]+$`, "u"));
  const runPage = page.getByTestId("workflow-run-page");
  await expect(runPage.getByRole("button", { name: "Test again", exact: true })).toBeVisible({
    timeout: 90_000
  });
  const runId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
  const run = z
    .object({ status: z.string(), outputPreview: z.object({ text: z.string() }).optional() })
    .parse(await (await page.request.get(`${apiBaseUrl}/api/v1/workflow-runs/${runId}`)).json());
  expect(run.status).toBe("done");
  expect(JSON.parse(run.outputPreview?.text ?? "null")).toEqual({ done: 2 });
});
