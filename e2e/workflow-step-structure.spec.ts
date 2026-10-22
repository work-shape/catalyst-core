import { randomUUID } from "node:crypto";
import { type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// Adding, deleting and moving steps by hand (workflow-canvas 9.6, Events check 127): the "+"
// between two steps adds a step there and the "+" at the end of a loop's body adds it inside
// the loop; a new step's id comes from its name and stays when the step is renamed; deleting a
// step whose result another step reads is refused in the dialog with that step's name; a move
// that puts a step after the step that reads it is refused by the server and saves nothing; a
// loop moves with its steps. Fails without WF-EDIT-4: a step could only be changed by hand.

const TITLE =
  "steps are added at their place, deleted only when unread, and moved with what they hold";
const ASSET_PATH = /^\/api\/v1\/assets\/workflow\/[^/]+$/u;

// The message this spec causes on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "workflow-move-refused",
        reason:
          "Chromium's own log line: the test moves a step after the loop that reads it, the " +
          "instance answers 422, and the test asserts the sentence and that nothing was saved.",
        matches: requestAnswered(422),
        path: ASSET_PATH,
        tests: [TITLE]
      }
    ]
  }
});

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
const WIDE = { width: 1440, height: 900 };

const idSchema = z.object({ id: z.string() });
type Step = Record<string, unknown>;
const stepSchema: z.ZodType<Step> = z.record(z.string(), z.unknown());
const assetSchema = z.object({
  revision: z.number(),
  config: z.object({ manifest: z.object({ steps: z.array(stepSchema) }) })
});

async function signIn(page: Page): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { ...superadmin, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

const assetUrlOf = (id: string) => `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

const code = (id: string, name: string, output: Step) => ({
  id,
  name,
  type: "code",
  file: `${id}.py`,
  input: {},
  inputSchema: { type: "object", properties: {} },
  outputSchema: { type: "object", properties: output, required: Object.keys(output) }
});

async function readAsset(page: Page, id: string) {
  const response = await page.request.get(assetUrlOf(id));
  expect(response.ok()).toBe(true);
  return assetSchema.parse(await response.json());
}

const idsOf = (steps: unknown): string[] =>
  Array.isArray(steps) ? steps.map((step) => String(stepSchema.parse(step).id)) : [];
const stepOf = (steps: readonly Step[], id: string): Step | undefined =>
  steps.find((step) => step.id === id);

/** Adds an AI step at the place a "+" names, gives it instructions and a name, and saves. */
async function addAiStep(page: Page, place: string, name: string, id: string): Promise<void> {
  const canvas = page.getByTestId("workflow-page").getByTestId("workflow-canvas");
  await canvas.getByRole("button", { name: place, exact: true }).click();
  await page.getByRole("option", { name: /^AI step/u }).click();
  const panel = page.locator(`[data-step-panel="${id}"]`);
  await expect(panel.locator(`[data-step-settings="${id}"]`)).toBeVisible();
  await expect(canvas.locator(`[data-flow-id="${id}"]`)).toBeVisible();
  await panel.getByRole("textbox", { name: "Instructions" }).fill("Check one address.");
  await panel.getByRole("textbox", { name: "Name" }).fill(name);
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
}

/** Opens a step's "…" menu and picks an entry. */
async function fromMenu(page: Page, step: string, entry: string): Promise<Locator> {
  const canvas = page.getByTestId("workflow-page").getByTestId("workflow-canvas");
  // By the keyboard: the middle of a loop's frame is where its body's "+" stands.
  await canvas.locator(`[data-flow-id="${step}"]`).focus();
  await page.keyboard.press("Enter");
  const panel = page.locator(`[data-step-panel="${step}"]`);
  await panel.getByRole("button", { name: "More actions", exact: true }).click();
  await page.getByRole("menuitem", { name: entry, exact: true }).click();
  return panel;
}

test(TITLE, async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize(WIDE);
  await signIn(page);
  page.setDefaultTimeout(30_000);
  const me = idSchema.parse(await (await page.request.get(`${apiBaseUrl}/api/v1/me`)).json());
  const id = `structure-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  const principal = await requestWithOrigin(
    page,
    "post",
    `${apiBaseUrl}/api/v1/instance/service-principals`,
    { data: { name: runAs, displayLabel: runAs, description: "Runs the Workflow of a spec." } }
  );
  expect(principal.ok(), await principal.text()).toBe(true);
  const stored = await requestWithOrigin(page, "put", assetUrlOf(id), {
    data: {
      expectedRevision: null,
      config: {
        name: id,
        manifest: {
          id,
          name: `Structure ${id.slice(-8)}`,
          runAs,
          inputs: { type: "object", additionalProperties: false },
          outputs: {
            type: "object",
            properties: { done: { type: "integer" } },
            required: ["done"]
          },
          steps: [
            { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
            code("count", "Count the notes", { n: { type: "integer" } }),
            code("names", "List the names", {
              names: { type: "array", items: { type: "string" } }
            }),
            {
              id: "each",
              name: "For each name",
              type: "loop",
              items: { step: "names", path: "names" },
              steps: [
                {
                  id: "greet",
                  name: "Greet the name",
                  type: "agent",
                  instructions: "Greet one name.",
                  input: {},
                  inputSchema: { type: "object", properties: {} },
                  outputSchema: { type: "object", properties: { line: { type: "string" } } }
                }
              ]
            },
            {
              id: "notice",
              name: "Tell the office",
              type: "notify",
              to: { users: [me.id] },
              channels: ["inbox"],
              title: { value: "Names are greeted" },
              text: { value: "Every name has its line." }
            },
            {
              id: "result",
              name: "Result",
              type: "output",
              input: { done: { ref: { step: "count", path: "n" } } }
            }
          ]
        },
        files: [
          { path: "steps/count.py", content: 'import json\nprint(json.dumps({"n": 1}))\n' },
          { path: "steps/names.py", content: 'import json\nprint(json.dumps({"names": []}))\n' }
        ]
      }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Structure ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  await page.goto(`/w/${workspaceId}/workflows/${id}`);
  const canvas = page.getByTestId("workflow-page").getByTestId("workflow-canvas");
  await expect(canvas.locator('[data-flow-id="notice"]')).toBeVisible();
  const first = await assetRevision(page, assetUrlOf(id));

  // Check 127: the "+" between two steps adds a step there. Its id comes from the palette's
  // name and stays when the step is renamed.
  await addAiStep(page, "Add a step after “Count the notes”", "Check the address", "ai_step");
  await expect.poll(async () => (await readAsset(page, id)).revision).toBe(first + 1);
  let steps = (await readAsset(page, id)).config.manifest.steps;
  expect(idsOf(steps)).toEqual(["start", "count", "ai_step", "names", "each", "notice", "result"]);
  expect(stepOf(steps, "ai_step")?.name).toBe("Check the address");

  // The "+" at the end of the loop's body adds the step inside the loop.
  await addAiStep(page, "Add a step at the end of “For each name”", "Write a line", "ai_step_2");
  await expect.poll(async () => (await readAsset(page, id)).revision).toBe(first + 2);
  steps = (await readAsset(page, id)).config.manifest.steps;
  expect(idsOf(stepOf(steps, "each")?.steps)).toEqual(["greet", "ai_step_2"]);

  // A step whose result the result reads is not deleted: the dialog names the reader.
  await fromMenu(page, "count", "Delete step");
  const blocked = page.getByRole("dialog", { name: "“Count the notes” cannot be deleted" });
  await expect(blocked).toContainText("“Result” reads its result. Change that step first.");
  await expect(blocked.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await blocked.getByRole("button", { name: "OK", exact: true }).click();

  // A move after the loop that reads the step is refused by the server, and nothing is saved.
  await fromMenu(page, "names", "Move");
  await expect(page.locator("[data-move-hint]")).toContainText(
    "Choose where “List the names” goes"
  );
  await canvas
    .getByRole("button", { name: "Move here, after “For each name”", exact: true })
    .click();
  await expect(page.getByText("“List the names” was not moved.")).toBeVisible();
  await expect(
    page.getByText(
      "“For each name” reads the result of “List the names” and would not see it there."
    )
  ).toBeVisible();
  expect((await readAsset(page, id)).revision).toBe(first + 2);

  // The loop moves with its steps: after the notice, both steps of its body inside it.
  await fromMenu(page, "each", "Move");
  await canvas
    .getByRole("button", { name: "Move here, after “Tell the office”", exact: true })
    .click();
  await expect.poll(async () => (await readAsset(page, id)).revision).toBe(first + 3);
  steps = (await readAsset(page, id)).config.manifest.steps;
  expect(idsOf(steps)).toEqual(["start", "count", "ai_step", "names", "notice", "each", "result"]);
  expect(idsOf(stepOf(steps, "each")?.steps)).toEqual(["greet", "ai_step_2"]);
});
