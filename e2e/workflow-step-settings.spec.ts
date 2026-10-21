import { randomUUID } from "node:crypto";
import { type Locator, type Page } from "@playwright/test";
import { z } from "zod";
import { requestAnswered } from "./allowed-page-errors";
import { assetRevision, requestWithOrigin } from "./request-with-origin";
import { expect, test } from "./test";

// A step's Settings tab (workflow-canvas 9.4 and 9.5, Events checks 122 to 124): a holder of
// workflow.write changes a step by hand, and each Save is one revision of the draft while the
// published revision stays. A save after the agent saved meanwhile carries the change over,
// keeps the person's value beside the agent's, or says it was dropped. What the instance
// refuses stands under the field it names. A member who only reads gets no Settings tab and
// cannot save. Fails without WF-EDIT-1: no step had a Settings tab.

const TITLE =
  "a step's Settings save one revision of the draft and carry a change over the agent's";
const ASSET_PATH = /^\/api\/v1\/assets\/workflow\/[^/]+$/u;

// The messages this spec causes on purpose (see allowed-page-errors.ts).
test.use({
  allowedPageErrors: {
    errors: [
      {
        name: "workflow-settings-saved-over-the-agent",
        reason:
          "Chromium's own log line: the test saves the draft with the API while the page has a " +
          "step changed, the page's save is answered with 412, and the test asserts how the page " +
          "carries the change over the agent's draft.",
        matches: requestAnswered(412),
        path: ASSET_PATH,
        tests: [TITLE]
      },
      {
        name: "workflow-settings-refused",
        reason:
          "Chromium's own log line: the test saves a notify step without recipients, the " +
          "instance answers 422, and the test asserts the sentence under the field.",
        matches: requestAnswered(422),
        path: ASSET_PATH,
        tests: [TITLE]
      }
    ]
  }
});

const apiBaseUrl = process.env.E2E_API_URL ?? "http://127.0.0.1:4210";
const superadmin = { email: "e2e-superadmin@example.test", password: "e2e-superadmin-password" };
/** From `tests/fixtures/e2e-users/workflow-rights.yaml`; held by `accessState`. */
const member = {
  email: "e2e-workflow-rights@example.test",
  password: "e2e-workflow-rights-password"
};
const WIDE = { width: 1440, height: 900 };
const NAME = "Settings walk";

const idSchema = z.object({ id: z.string() });
const assetSchema = z.object({
  revision: z.number(),
  publishedRevision: z.number().nullable().optional(),
  config: z.object({ manifest: z.object({ steps: z.array(z.record(z.string(), z.unknown())) }) })
});

type Step = Record<string, unknown>;

async function signIn(page: Page, user: { email: string; password: string }): Promise<void> {
  const response = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/auth/sign-in/email`, {
    data: { email: user.email, password: user.password, rememberMe: true }
  });
  expect(response.ok()).toBe(true);
}

const assetUrlOf = (id: string) => `${apiBaseUrl}/api/v1/assets/workflow/${id}`;

function manifestOf(id: string, runAs: string, steps: readonly Step[]) {
  return {
    id,
    name: NAME,
    description: "A Workflow a spec changes by hand.",
    runAs,
    inputs: { type: "object", additionalProperties: false },
    outputs: { type: "object", properties: { done: { type: "integer" } }, required: ["done"] },
    steps
  };
}

function stepsFor(recipient: string): Step[] {
  return [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "notice",
      name: "Tell the office",
      type: "notify",
      to: { users: [recipient] },
      channels: ["inbox"],
      title: { value: "Notes are ready" },
      text: { value: "The client notes are written." }
    },
    { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
  ];
}

async function readAsset(page: Page, id: string) {
  const response = await page.request.get(assetUrlOf(id));
  expect(response.ok()).toBe(true);
  return assetSchema.parse(await response.json());
}

/** The agent saves the draft meanwhile: its steps, as the given change makes them. */
async function agentSaves(
  page: Page,
  id: string,
  runAs: string,
  change: (steps: Step[]) => Step[]
): Promise<void> {
  const asset = await readAsset(page, id);
  const saved = await requestWithOrigin(page, "put", assetUrlOf(id), {
    data: {
      expectedRevision: asset.revision,
      config: { name: id, manifest: manifestOf(id, runAs, change(asset.config.manifest.steps)) }
    }
  });
  expect(saved.ok(), await saved.text()).toBe(true);
}

const withStep = (id: string, fields: Step) => (steps: Step[]) =>
  steps.map((step) => (step.id === id ? { ...step, ...fields } : step));

async function openSettings(canvas: Locator, step: string): Promise<Locator> {
  await canvas.locator(`[data-flow-id="${step}"]`).click();
  const panel = canvas.page().locator(`[data-step-panel="${step}"]`);
  await panel.getByRole("tab", { name: "Settings", exact: true }).click();
  await expect(panel.locator(`[data-step-settings="${step}"]`)).toBeVisible();
  return panel;
}

test(TITLE, async ({ page, browser, pageErrors, accessState: _accessState }) => {
  test.setTimeout(240_000);
  const id = `settings-walk-${randomUUID().slice(0, 8)}`;
  const runAs = `${id}-runner`;
  await page.setViewportSize(WIDE);
  await signIn(page, superadmin);
  page.setDefaultTimeout(30_000);
  const me = idSchema.parse(await (await page.request.get(`${apiBaseUrl}/api/v1/me`)).json());

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
      config: { name: id, manifest: manifestOf(id, runAs, stepsFor(me.id)) }
    }
  });
  expect(stored.ok(), await stored.text()).toBe(true);
  const first = await assetRevision(page, assetUrlOf(id));
  const published = await requestWithOrigin(page, "post", `${assetUrlOf(id)}/publish`, {
    data: { revision: first }
  });
  expect(published.ok(), await published.text()).toBe(true);
  const created = await requestWithOrigin(page, "post", `${apiBaseUrl}/api/v1/workspaces`, {
    data: { name: `Settings walk ${id.slice(-8)}` }
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workspaceId = idSchema.parse(await created.json()).id;
  const workflowPath = `/w/${workspaceId}/workflows/${id}`;

  await page.goto(workflowPath);
  const canvas = page.getByTestId("workflow-page").getByTestId("workflow-canvas");
  const notice = canvas.locator('[data-flow-id="notice"]');
  await expect(notice).toBeVisible();

  // Check 122: the text changed by hand is one revision of the draft, marked on its node with
  // the published text under the field, and the published revision stays where it was.
  let panel = await openSettings(canvas, "notice");
  const before = (await readAsset(page, id)).publishedRevision;
  await panel.getByLabel("Text", { exact: true }).fill("The notes of every client are written.");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.locator('[data-published="text"]')).toContainText(
    "The client notes are written."
  );
  await expect(notice).toHaveAttribute("data-change", "changed");
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  const afterSave = await readAsset(page, id);
  expect(afterSave.revision).toBe(first + 1);
  expect(afterSave.publishedRevision).toBe(before);
  expect(JSON.stringify(afterSave.config.manifest)).toContain("The notes of every client");

  // The agent changed another step meanwhile: the save carries both, without a question.
  await panel.getByLabel("Title", { exact: true }).fill("The notes are ready");
  await agentSaves(page, id, runAs, withStep("result", { name: "The result" }));
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  const manifestText = async () => JSON.stringify((await readAsset(page, id)).config.manifest);
  await expect.poll(manifestText).toContain("The notes are ready");
  expect(await manifestText()).toContain("The result");
  await expect(panel.locator("[data-conflict]")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);

  // The agent changed the same field meanwhile: the person's value stays, the agent's stands
  // under it, and Take it takes the agent's.
  await panel.getByLabel("Title", { exact: true }).fill("Mine");
  await agentSaves(page, id, runAs, withStep("notice", { title: { value: "The agent's" } }));
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  const conflict = panel.locator('[data-conflict="title"]');
  await expect(conflict).toContainText("Changed by the agent meanwhile");
  await expect(conflict).toContainText("The agent's");
  await expect(panel.getByLabel("Title", { exact: true })).toHaveValue("Mine");
  await conflict.getByRole("button", { name: "Take it", exact: true }).click();
  await expect(panel.getByLabel("Title", { exact: true })).toHaveValue("The agent's");
  await expect(panel.locator("[data-conflict]")).toHaveCount(0);

  // Check 124: what the instance refuses stands under the field it names, and nothing is saved.
  const refusedAt = (await readAsset(page, id)).revision;
  const recipients = panel.getByRole("button", { name: /^Recipients/u });
  await recipients.click();
  await page
    .getByRole("listbox", { name: "Recipients" })
    .getByRole("option", { name: "E2E Superadmin", exact: true })
    .click();
  await expect(recipients).toHaveAccessibleName("Recipients: Choose who receives it");
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel).toContainText("A notify step needs recipients");
  expect((await readAsset(page, id)).revision).toBe(refusedAt);
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(panel).not.toContainText("A notify step needs recipients");

  // The agent deleted the step meanwhile: the change to it is dropped, and said so.
  await panel.getByLabel("Text", { exact: true }).fill("Gone with the step");
  await agentSaves(page, id, runAs, (steps) => steps.filter((step) => step.id !== "notice"));
  await panel.getByRole("button", { name: "Save", exact: true }).click();
  await expect(panel.locator("[data-edit-dropped]")).toContainText(
    "The agent deleted a step you changed meanwhile"
  );
  expect(JSON.stringify((await readAsset(page, id)).config.manifest)).not.toContain(
    "Gone with the step"
  );

  // Check 123: a member who only reads the Workflow gets no Settings tab, and the instance
  // refuses a save of theirs.
  const context = await browser.newContext({ viewport: WIDE });
  await pageErrors.watch(context);
  const memberPage = await context.newPage();
  try {
    // A seeded user is known to the instance once the user has signed in.
    await signIn(memberPage, member);
    const memberId = idSchema.parse(
      await (await memberPage.request.get(`${apiBaseUrl}/api/v1/me`)).json()
    ).id;
    const added = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/workspaces/${workspaceId}/members`,
      { data: { email: member.email } }
    );
    expect(added.ok(), await added.text()).toBe(true);
    const asset = idSchema.parse(await (await page.request.get(assetUrlOf(id))).json());
    const granted = await requestWithOrigin(
      page,
      "post",
      `${apiBaseUrl}/api/v1/instance/access/grants`,
      {
        data: {
          holderKind: "user",
          holderId: memberId,
          action: "workflow.read",
          effect: "allow",
          scopeKind: "asset",
          scopeId: asset.id
        }
      }
    );
    expect(granted.ok(), await granted.text()).toBe(true);
    await memberPage.goto(workflowPath);
    const memberCanvas = memberPage.getByTestId("workflow-page").getByTestId("workflow-canvas");
    await memberCanvas.locator('[data-flow-id="result"]').click();
    const memberPanel = memberPage.locator('[data-step-panel="result"]');
    await expect(memberPanel).toBeVisible();
    await expect(memberPanel.getByRole("tab", { name: "Settings", exact: true })).toHaveCount(0);
    const refused = await requestWithOrigin(memberPage, "put", assetUrlOf(id), {
      data: {
        expectedRevision: (await readAsset(page, id)).revision,
        config: { name: id, manifest: manifestOf(id, runAs, stepsFor(me.id)) }
      }
    });
    expect(refused.status()).toBe(403);
  } finally {
    await context.close();
  }
});
