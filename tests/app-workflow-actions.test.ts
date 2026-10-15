import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createInstanceWorkflows,
  createJobWorker,
  resolveInstanceModules,
  type InstanceWorkflows
} from "@work-shape/catalyst-client-assembly";
import type { JobWorker, Logger, ModuleSnapshot } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import {
  action,
  setupAppActions,
  type AppActionsInstance,
  type Frame
} from "./support/app-actions";
import { expectStatus } from "./support/app-instance";
import { WORKFLOW_RUNNER, publishedDefinitions, runSchema } from "./support/workflow-instance";

// APP-6a: an App starts a published Workflow through a named action of kind `workflow`. The
// frame's call starts the run as the viewer, by the rule of `workflows.start`, and the frame
// follows the run it started through `apps.sessions.get_workflow_run`. A draft starts nothing
// and answers what it would have started. Real build, real call path, real engine on a real
// database; the Workflow echoes the page it is given.
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

/** A Workflow that starts by hand and answers the page it was given. */
const visitWorkflow = (id: string) => ({
  id,
  name: "Visit log",
  runAs: WORKFLOW_RUNNER,
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

/** The App `visits`: one button that starts the Workflow with the page it names. */
const visitsApp = (marker: string) => [
  {
    path: "app.yaml",
    text: JSON.stringify({ id: "visits", name: "Visits", kit: "1.3.0", entry: "index.html" })
  },
  { path: "index.html", text: `<!doctype html><title>Visits</title><p>${marker}</p>` },
  {
    path: "actions/log-visit.action.yaml",
    text: action([
      `workflow: ${WORKFLOW}`,
      "input:",
      "  schema: { type: object, properties: { page: { type: string } }, required: [page] }",
      '  mapping: { page: "{{page}}", source: app }'
    ])
  }
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
  outputTruncated: z.boolean().optional()
});

describe("an App that starts a Workflow", () => {
  let t: AppActionsInstance;
  let worker: JobWorker;
  let grantId: string | undefined;

  beforeAll(async () => {
    const definitions = publishedDefinitions();
    definitions.publish(visitWorkflow(WORKFLOW));
    definitions.publish(visitWorkflow(OTHER_WORKFLOW));
    let workflows: InstanceWorkflows | undefined;
    let modules: ModuleSnapshot | undefined;
    t = await setupAppActions({
      modules: { workflows: { enabled: true } },
      server(stores, config, built) {
        if (!built.operationCalls) throw new Error("The instance built no call path");
        modules = resolveInstanceModules(config, []).snapshot;
        workflows = createInstanceWorkflows({
          modules,
          clientInstanceId,
          stores,
          operationCalls: built.operationCalls,
          definitions: definitions.source
        });
        return {};
      },
      register(route) {
        for (const register of workflows?.routes ?? []) register(route);
      }
    });
    if (!workflows || !modules) throw new Error("The instance did not build its server");
    await t.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: WORKFLOW_RUNNER
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

  it("answers in a draft what it would have started, and starts nothing", async () => {
    const before = await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: WORKFLOW });
    const actionRuns = (await t.runs()).length;
    const frame = await t.openApp(t.admin.id, "draft", "visits");
    expect(await t.can(t.admin.id, frame)).toEqual({
      "log-visit": expect.not.stringMatching(/deny/u)
    });

    const response = await t.callAction(
      t.admin.id,
      frame,
      "log-visit",
      { page: "/draft" },
      { "idempotency-key": "draft-visit" }
    );

    expectStatus(response, 200);
    expect(response.json()).toEqual({
      status: "dry_run",
      message:
        'Would have started the Workflow \'visit-log\' with {"page":"/draft","source":"app"}. The draft of an App runs in safe mode and carries out nothing that changes something. Publish the App, or switch on "Run live once" for this action, to carry it out.',
      result: { workflow: WORKFLOW, input: { page: "/draft", source: "app" } }
    });
    // The simulated call leaves its run, with the target that says so (ADR-0031).
    expect(await t.runOf(response.headers["operation-run-id"])).toMatchObject({
      target: "dry_run",
      effect: "changing"
    });
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
    expect(await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: WORKFLOW })).toEqual(
      before
    );
    expect(await t.runs()).toHaveLength(actionRuns + 1);
  });

  afterAll(async () => {
    if (grantId) await t.stores.access.deleteGrant({ clientInstanceId, grantId });
  });
});
