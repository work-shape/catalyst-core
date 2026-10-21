import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createInstanceWorkflows,
  createJobWorker,
  resolveInstanceModules,
  type InstanceWorkflows
} from "@work-shape/catalyst-client-assembly";
import {
  WORKFLOW_ASSET_KIND,
  type JobWorker,
  type Logger,
  type ModuleSnapshot,
  type OperationRegistry,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import {
  action,
  setupAppActions,
  type AppActionsInstance,
  type Frame
} from "./support/app-actions";
import { expectStatus } from "./support/app-instance";
import { instanceWorkflowAssetKind, runSchema } from "./support/workflow-instance";

// APP-6a: an App starts a published Workflow through a named action of kind `workflow`. The
// frame's call starts the run as the viewer, by the rule of `workflows.start`, and the frame
// follows the run it started through `apps.sessions.get_workflow_run`. A draft starts a test
// run (DP-1): of the Workflow's draft for a tester who may write it, else of its published
// revision, and never a live one. Real build, real call path, real engine on a real
// database, Workflows as published assets; the Workflow echoes the page it is given.
//
// Every test here fails without the change: the build refused an action file that names a
// Workflow, and a frame had no way to read a run.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

const WORKFLOW = "visit-log";
const OTHER_WORKFLOW = "visit-other";
/** A Workflow with a draft and no published revision. */
const UNPUBLISHED_WORKFLOW = "visit-unpublished";

/** A Workflow that starts by hand and answers the page it was given. */
const visitWorkflow = (id: string) => ({
  id,
  name: "Visit log",
  inputs: {
    type: "object",
    properties: { page: { type: "string" }, source: { type: "string" } },
    additionalProperties: false
  },
  outputs: {
    type: "object",
    properties: { page: { type: "string" } },
    required: ["page"]
  },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { page: { ref: { step: "start", path: "input.page" } } }
    }
  ]
});

const visitAction = (workflow: string) =>
  action([
    `workflow: ${workflow}`,
    "input:",
    "  schema: { type: object, properties: { page: { type: string } }, required: [page] }",
    '  mapping: { page: "{{page}}", source: app }'
  ]);

/**
 * The App `visits`: one button that starts the Workflow with the page it names. Its draft
 * adds one that starts a Workflow nobody has published.
 */
const visitsApp = (marker: string) => [
  {
    path: "app.yaml",
    text: JSON.stringify({ id: "visits", name: "Visits", kit: "1.3.0", entry: "index.html" })
  },
  { path: "index.html", text: `<!doctype html><title>Visits</title><p>${marker}</p>` },
  { path: "actions/log-visit.action.yaml", text: visitAction(WORKFLOW) },
  ...(marker === "draft"
    ? [{ path: "actions/log-unpublished.action.yaml", text: visitAction(UNPUBLISHED_WORKFLOW) }]
    : [])
];

const startedSchema = z.object({
  runId: z.string(),
  status: z.literal("done"),
  result: z.looseObject({ id: z.string(), workflow: z.string(), status: z.string() })
});
const followedSchema = z.object({
  id: z.string(),
  workflow: z.string(),
  status: z.string(),
  output: z.unknown().optional(),
  outputTruncated: z.boolean().optional(),
  mode: z.literal("test").optional(),
  workflowRevision: z
    .object({ kind: z.enum(["draft", "published"]), number: z.number().optional() })
    .optional(),
  simulatedSteps: z.array(z.string()).optional()
});

describe("an App that starts a Workflow", () => {
  let t: AppActionsInstance;
  let worker: JobWorker;
  let grantId: string | undefined;

  beforeAll(async () => {
    let workflows: InstanceWorkflows | undefined;
    let modules: ModuleSnapshot | undefined;
    let stores: PlatformStores | undefined;
    let registry: OperationRegistry | undefined;
    const kind = instanceWorkflowAssetKind(
      () => {
        if (!stores) throw new Error("The instance is not set up");
        return stores;
      },
      () => registry
    );
    t = await setupAppActions({
      modules: { workflows: { enabled: true } },
      furtherKinds: [kind],
      server(instanceStores, config, built) {
        if (!built.operationCalls) throw new Error("The instance built no call path");
        stores = instanceStores;
        registry = built.operationCalls.registry;
        modules = resolveInstanceModules(config, []).snapshot;
        workflows = createInstanceWorkflows({
          modules,
          clientInstanceId,
          stores: instanceStores,
          operationCalls: built.operationCalls
        });
        return {};
      },
      register(route) {
        for (const register of workflows?.routes ?? []) register(route);
      }
    });
    if (!workflows || !modules) throw new Error("The instance did not build its server");
    // The App is published only with its Workflow live (DP-0).
    for (const id of [WORKFLOW, OTHER_WORKFLOW]) {
      const address = { kind: WORKFLOW_ASSET_KIND, name: id };
      const put = await t.expectOk(t.root.id, "assets.put", {
        params: address,
        payload: { config: { name: id, manifest: visitWorkflow(id) }, expectedRevision: null }
      });
      const { revision } = z.object({ revision: z.number() }).parse(put.json());
      await t.expectOk(t.root.id, "assets.publish", { params: address, payload: { revision } });
    }
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: UNPUBLISHED_WORKFLOW },
      payload: {
        config: { name: UNPUBLISHED_WORKFLOW, manifest: visitWorkflow(UNPUBLISHED_WORKFLOW) },
        expectedRevision: null
      }
    });
    worker = createJobWorker({
      stores: t.stores,
      clientInstanceId,
      handlers: workflows.jobHandlers,
      modules,
      logger: silent
    });
    expectStatus(await t.putApp(t.admin.id, "visits", visitsApp("published")), 200);
    expectStatus(await t.publish(t.admin.id, "visits", 1), 200);
    expectStatus(await t.putApp(t.admin.id, "visits", visitsApp("draft")), 200);
  });
  afterAll(async () => {
    await worker.stop();
    await t.closeAll();
  });

  /** Lets `kai` start every Workflow of the instance, as a grant on the instance does. */
  async function letKaiStart(): Promise<void> {
    const grant = await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "workflow.use",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: t.admin.id
    });
    grantId = grant.id;
  }
  /** Takes back what `letKaiStart` gave. */
  async function stopKai(): Promise<void> {
    if (grantId) await t.stores.access.deleteGrant({ clientInstanceId, grantId });
    grantId = undefined;
  }

  async function readRun(userId: string, frame: Frame, runId: string) {
    return t.call(userId, "apps.sessions.get_workflow_run", {
      params: { pageSessionId: frame.pageSessionId, runId },
      payload: frame.proof
    });
  }

  /** Runs what is due until the run has ended, and reads it as the frame follows it. */
  async function followToEnd(userId: string, frame: Frame, runId: string) {
    for (let pass = 0; pass < 50; pass++) {
      await worker.runDue();
      const response = await readRun(userId, frame, runId);
      expectStatus(response, 200);
      const run = followedSchema.parse(response.json());
      if (!["queued", "running", "waiting"].includes(run.status)) return run;
    }
    throw new Error(`Workflow Run ${runId} did not end`);
  }

  it("refuses a viewer without the right to use the Workflow, with the right named, and starts nothing", async () => {
    const frame = await t.openApp(t.kai.id, "published", "visits");
    expect(await t.can(t.kai.id, frame)).toEqual({ "log-visit": "deny" });

    const response = await t.callAction(
      t.kai.id,
      frame,
      "log-visit",
      { page: "/refused" },
      { "idempotency-key": "refused-1" }
    );

    expectStatus(response, 403);
    expect(t.refusal(response)).toMatchObject({
      code: "FORBIDDEN",
      details: expect.objectContaining({ action: "workflow.use" })
    });
    const runs = await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: WORKFLOW });
    expect(runs).toEqual([]);
  });

  it("starts the published Workflow as the viewer, who follows the run to its result", async () => {
    await letKaiStart();
    const frame = await t.openApp(t.kai.id, "published", "visits");
    expect(await t.can(t.kai.id, frame)).toEqual({
      "log-visit": expect.not.stringMatching(/deny/u)
    });

    const response = await t.callAction(
      t.kai.id,
      frame,
      "log-visit",
      { page: "/pricing" },
      { "idempotency-key": "start-1" }
    );

    expectStatus(response, 200);
    const started = startedSchema.parse(response.json());
    expect(started.result.workflow).toBe(WORKFLOW);
    const run = await followToEnd(t.kai.id, frame, started.result.id);
    expect(run).toMatchObject({
      id: started.result.id,
      workflow: WORKFLOW,
      status: "done",
      output: { page: "/pricing" }
    });
    // The run names its starter and the call that started it, and the call what it started.
    const read = await t.call(t.root.id, "workflows.get_run", {
      params: { runId: started.result.id }
    });
    expect(runSchema.parse(read.json()).startedBy).toMatchObject({ kind: "user", id: t.kai.id });
    // The right to start is not the right to read: outside the frame, kai reads no run.
    const outside = await t.call(t.kai.id, "workflows.get_run", {
      params: { runId: started.result.id }
    });
    expectStatus(outside, 403);
    expect(t.refusal(outside)).toMatchObject({
      details: expect.objectContaining({ action: "workflow.read" })
    });
    expect(await t.runOf(started.runId)).toMatchObject({
      operation: "app.visits.log-visit",
      status: "done",
      origin: expect.objectContaining({ kind: "app", target: { workflow: WORKFLOW } })
    });
  });

  it("hands the frame a run's whole output of 5,000 characters, not the interface's preview of it (DP-0b)", async () => {
    const page = `/${"long-page/".repeat(500)}`;
    const frame = await t.openApp(t.root.id, "published", "visits");
    const response = await t.callAction(
      t.root.id,
      frame,
      "log-visit",
      { page },
      { "idempotency-key": "long-output-1" }
    );
    expectStatus(response, 200);
    const started = startedSchema.parse(response.json());

    const run = await followToEnd(t.root.id, frame, started.result.id);

    expect(page.length).toBeGreaterThan(5_000);
    expect(run.status).toBe("done");
    expect(run.output).toEqual({ page });
    expect(run.outputTruncated).toBeUndefined();
  });

  it("follows no run of a Workflow the App does not start, none of another viewer's frame, and none another viewer started", async () => {
    const other = await t.call(t.root.id, "workflows.start", {
      params: { workflow: OTHER_WORKFLOW },
      payload: {},
      headers: { "idempotency-key": "other-1" }
    });
    expectStatus(other, 200);
    const otherRun = runSchema.parse(other.json());
    const rootFrame = await t.openApp(t.root.id, "published", "visits");
    // The root may read every run, and still the frame reads only what its actions start.
    expectStatus(await readRun(t.root.id, rootFrame, otherRun.id), 404);

    const kaiFrame = await t.openApp(t.kai.id, "published", "visits");
    const started = startedSchema.parse(
      (
        await t.callAction(
          t.kai.id,
          kaiFrame,
          "log-visit",
          { page: "/mine" },
          { "idempotency-key": "start-2" }
        )
      ).json()
    );
    // Another person's frame is no proof for kai.
    expectStatus(await readRun(t.kai.id, rootFrame, started.result.id), 404);
    // The root may read kai's run outside, and still its frame follows only the root's own.
    expectStatus(await readRun(t.root.id, rootFrame, started.result.id), 404);
    expectStatus(await readRun(t.kai.id, kaiFrame, "wfr_none"), 404);
  });

  /** A click in the draft of `visits`, followed to its end as the frame follows it. */
  async function clickInDraft(userId: string, frame: Frame, page: string, key: string) {
    const response = await t.callAction(userId, frame, "log-visit", { page }, { "idempotency-key": key });
    expectStatus(response, 200);
    const started = startedSchema.parse(response.json());
    return { started, run: await followToEnd(userId, frame, started.result.id) };
  }

  it("starts a test run of the Workflow's draft for a tester who may write it, and nothing live (DP-1)", async () => {
    const live = await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: WORKFLOW });
    const frame = await t.openApp(t.admin.id, "draft", "visits");
    expect(await t.can(t.admin.id, frame)).toEqual({
      "log-visit": expect.not.stringMatching(/deny/u),
      "log-unpublished": expect.not.stringMatching(/deny/u)
    });

    const { started, run } = await clickInDraft(t.admin.id, frame, "/draft", "draft-visit");

    expect(run).toMatchObject({
      status: "done",
      output: { page: "/draft" },
      mode: "test",
      workflowRevision: { kind: "draft", number: 1 },
      simulatedSteps: []
    });
    // The click leaves its Operation Run with the target that says it was a test (ADR-0031).
    expect(await t.runOf(started.runId)).toMatchObject({ target: "test", effect: "changing" });
    // The run is a test run that names the App's draft and the action that started it.
    const stored = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.result.id });
    expect(stored).toMatchObject({
      mode: "test",
      startedBy: { kind: "user", id: t.admin.id },
      startedFrom: {
        kind: "app",
        app: "visits",
        action: "log-visit",
        workflowRevision: "draft"
      }
    });
    // A draft's Workflow with no published revision is tested too, by its writer.
    const unpublished = await t.callAction(
      t.admin.id,
      frame,
      "log-unpublished",
      { page: "/unpublished" },
      { "idempotency-key": "draft-unpublished" }
    );
    expectStatus(unpublished, 200);
    // Its parameters are checked as a call checks them.
    const invalid = await t.callAction(
      t.admin.id,
      frame,
      "log-visit",
      { path: "/draft" },
      { "idempotency-key": "draft-visit-invalid" }
    );
    expectStatus(invalid, 422);
    expect(t.refusal(invalid).details).toMatchObject({ reason: "input_invalid" });
    // Nothing live: every run the draft started is a test run.
    const after = await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: WORKFLOW });
    const liveIds = (runs: typeof live) =>
      runs.filter((one) => one.mode !== "test").map((one) => one.id);
    expect(liveIds(after)).toEqual(liveIds(live));
  });

  it("starts the published revision in mode test for a tester who may only use the Workflow, and refuses one who may not (DP-1)", async () => {
    // kai holds no right to use a Workflow from the tests before.
    await stopKai();
    const appId = await t.assetId("app", "visits");
    await t.withRight(t.kai.id, "app.write", { assetId: appId }, async () => {
      const frame = await t.openApp(t.kai.id, "draft", "visits");
      // In a draft App the tester's own rights apply: kai may not use the Workflow.
      const refused = await t.callAction(
        t.kai.id,
        frame,
        "log-visit",
        { page: "/refused" },
        { "idempotency-key": "draft-kai-refused" }
      );
      expectStatus(refused, 403);
      expect(t.refusal(refused)).toMatchObject({
        details: expect.objectContaining({ action: "workflow.use" })
      });

      const workflowId = await t.assetId(WORKFLOW_ASSET_KIND, WORKFLOW);
      await t.withRight(t.kai.id, "workflow.use", { assetId: workflowId }, async () => {
        const { started, run } = await clickInDraft(t.kai.id, frame, "/kai", "draft-kai");
        expect(run).toMatchObject({
          status: "done",
          output: { page: "/kai" },
          mode: "test",
          workflowRevision: { kind: "published", number: 1 }
        });
        expect(
          await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.result.id })
        ).toMatchObject({ mode: "test", startedFrom: { workflowRevision: "published" } });
      });

      // A Workflow nobody published has no revision a tester who may not write it runs.
      const unpublishedId = await t.assetId(WORKFLOW_ASSET_KIND, UNPUBLISHED_WORKFLOW);
      await t.withRight(t.kai.id, "workflow.use", { assetId: unpublishedId }, async () => {
        const unavailable = await t.callAction(
          t.kai.id,
          frame,
          "log-unpublished",
          { page: "/none" },
          { "idempotency-key": "draft-kai-unpublished" }
        );
        expect(t.refusal(unavailable).details).toMatchObject({ reason: "workflow_unavailable" });
      });
    });
  });

  afterAll(stopKai);
});
