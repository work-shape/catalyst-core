import { afterEach, describe, expect, it } from "vitest";
import { WORKFLOW_ASSET_KIND, type WorkflowManifest } from "@vivd-catalyst/core";
import { parseWorkflowManifest } from "@vivd-catalyst/workflows";
import { clientInstanceId } from "./support/access-instance";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows, start, stepRunsOf } from "./support/workflow-runs";

// A step of a Workflow never calls an operation of the platform's own assets (`assets.list`,
// `assets.get`, `assets.put`, `assets.publish`, `assets.sync` and their kin). A run acts as
// a service principal, and the principal of a release holds `config_assets.read` and
// `config_assets.release`: through a step it read every agent's instructions and reached
// `assets.sync`, with none of the drafts and confirmations of the agent's path. A save
// refuses such a step by name, and a run of a definition stored before fails at it without
// a call.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const ready = (options: Parameters<typeof readyWorkflows>[1] = {}) =>
  readyWorkflows((fixture) => {
    open = fixture;
  }, options);

const ASSET_STEP = {
  id: "agents",
  name: "Read the agents",
  type: "operation",
  operation: "assets.list",
  input: { kind: { value: "agent" } }
};

/** `notify-clients` with one step in place of its read, its loop and its result's input. */
function withStep(step: Record<string, unknown>) {
  const definition = notifyClients();
  const [trigger, , , result] = definition.steps;
  return { ...definition, steps: [trigger, step, { ...result, input: {} }] };
}

describe("a step that names an operation of the platform's own assets", () => {
  it.each(["assets.list", "assets.get", "assets.put", "assets.publish", "assets.sync"])(
    "is refused by the parser: %s",
    (operation) => {
      const result = parseWorkflowManifest(withStep({ ...ASSET_STEP, operation }));
      expect(result.ok).toBe(false);
      expect(result.ok ? [] : result.issues).toEqual([
        expect.objectContaining({ code: "operation_not_callable", path: "steps.agents.operation" })
      ]);
    }
  );

  it("is refused inside a loop too, and the operations of data are not", () => {
    const result = parseWorkflowManifest(
      notifyClients({}, [{ ...ASSET_STEP, input: { kind: { value: "skill" } } }])
    );
    expect(result.ok ? [] : result.issues).toEqual([
      expect.objectContaining({ code: "operation_not_callable", path: "steps.agents.operation" })
    ]);
    expect(parseWorkflowManifest(notifyClients()).ok).toBe(true);
  });

  it("is refused when the Workflow is saved, with the reason and the step", async () => {
    const t = await ready({ definitions: "assets" });
    const refused = await t.expectRefused(
      t.admin.id,
      "assets.put",
      {
        params: { kind: WORKFLOW_ASSET_KIND, name: "notify-clients" },
        payload: {
          config: { name: "notify-clients", manifest: withStep(ASSET_STEP) },
          expectedRevision: null
        }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({
      reason: "operation_not_callable",
      issues: [{ code: "operation_not_callable", path: "steps.agents.operation" }]
    });
    expect(
      await t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: "notify-clients"
      })
    ).toBeUndefined();
  });

  it("fails the step of a definition stored before, without a call, whatever the principal holds", async () => {
    // What an earlier release stored: the parser of this one refuses it.
    const parsed = parseWorkflowManifest(notifyClients());
    if (!parsed.ok) throw new Error("notify-clients is a definition");
    const [trigger, read, , result] = parsed.manifest.steps;
    if (!trigger || read?.type !== "operation" || result?.type !== "output") {
      throw new Error("notify-clients starts with a read and ends with its result");
    }
    const stored: WorkflowManifest = {
      ...parsed.manifest,
      steps: [
        trigger,
        { ...read, id: "agents", operation: "assets.list", input: ASSET_STEP.input },
        { ...result, input: {} }
      ]
    };
    const definitions = publishedDefinitions();
    definitions.hold(stored, "stored-before");
    const t = await ready({ definitions: definitions.source });
    // The rights of the principal of a release, which read every agent and skill.
    await t.stores.apiAccess.updateServicePrincipal({
      clientInstanceId,
      servicePrincipalId: t.principal.id,
      permissions: ["config_assets.read", "config_assets.release"]
    });

    const run = await t.finish((await start(t)).id);
    expect(run.status).toBe("failed");
    expect(run.error?.code).toBe("operation_not_callable");
    const steps = await stepRunsOf(t, run.id);
    expect(steps.map((stepRun) => [stepRun.key, stepRun.status])).toEqual([
      ["start", "done"],
      ["agents", "failed"]
    ]);
    expect(steps[1]?.outputPreview).toBeUndefined();
    expect(steps[1]?.operationRunId).toBeUndefined();
    const calls = await t.runs();
    expect(calls.filter((call) => call.operation.startsWith("assets."))).toEqual([]);
  });
});
