import postgres from "postgres";
import { fileTestDatabaseUrl } from "./support/test-database";
import { deferred, waitUntil } from "./support/assertions";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  type JsonValue,
  type OperationDefinition,
  type OperationRunId,
  type OperationSource,
  type RegisteredJobHandler,
  type WorkflowManifest,
  type WorkflowRunId
} from "@work-shape/catalyst-core";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { ref } from "./support/workflow-children";
import {
  publishedDefinitions,
  runSchema,
  type workflowFixture,
  type WorkflowFixture
} from "./support/workflow-instance";
import { makeJobsDue, readyWorkflows, stepRunsOf } from "./support/workflow-runs";

// Limits as settings (EW-LIM): `limits` in `workflow.yaml` under the operator's ceilings of
// release config, the raise named in the publish question, `limits.concurrency` per Workflow
// across its runs and children, held at the claim of the shared executor, and time a run
// spends waiting outside every limit. Acceptance check 113 of the Events, Workflows And
// Guardrails spec, on Postgres and the engine's jobs.

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

const ready = (options: Parameters<typeof workflowFixture>[0] = {}) =>
  readyWorkflows((fixture) => {
    open = fixture;
  }, options);

/**
 * Resolves once every run has ended, on `workers` started workers. A started worker claims
 * what is due while the calls it started still wait at a test's gate; a pass driven by hand
 * waits for them first, so on a busy machine it may hold one call and claim nothing else.
 */
async function untilEnded(t: WorkflowFixture, ids: string[], workers: number) {
  for (let count = 0; count < workers; count++) t.worker().start();
  await waitUntil(
    async () => {
      for (const id of ids) {
        const run = await t.stores.workflowRuns.readRun({ clientInstanceId, id });
        if (!["done", "failed", "cancelled", "limit_reached"].includes(run?.status ?? ""))
          return false;
      }
      return true;
    },
    "the runs end",
    60_000
  );
}

/** A Workflow started by hand that reads one value from the Connection `crm`. */
function reading(id: string, limits?: Record<string, unknown>): WorkflowManifest {
  return parseOk({
    id,
    name: id,
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    ...(limits ? { limits } : {}),
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "read",
        name: "Read",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: { value: id } }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  });
}

function parseOk(value: unknown): WorkflowManifest {
  const parsed = parseWorkflowManifest(value);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.manifest;
}

describe("limits in workflow.yaml", () => {
  const issues = (limits: unknown) => {
    const parsed = parseWorkflowManifest({ ...reading("bounded"), limits });
    return parsed.ok ? [] : parsed.issues.map(({ path, code }) => [path, code ?? "invalid"]);
  };

  it("reads duration, step runs, loop items and concurrency", () => {
    expect(
      issues({ duration: "30h", stepRuns: 50_000, loopItems: 20_000, concurrency: 2 })
    ).toEqual([]);
    expect(issues({ duration: "45m" })).toEqual([]);
    expect(issues({ duration: "3d" })).toEqual([]);
    expect(issues({ duration: "30 hours" })).toEqual([["limits.duration", "invalid"]]);
    expect(issues({ duration: "0h" })).toEqual([["limits.duration", "invalid"]]);
    expect(issues({ concurrency: 0 })).toEqual([["limits.concurrency", "invalid"]]);
    expect(issues({ stepRuns: 1.5 })).toEqual([["limits.stepRuns", "invalid"]]);
    expect(issues({ timeLimit: "1h" })).toEqual([["limits", "invalid"]]);
  });

  it("accepts raised paging minutes while dataset-byte raises remain reserved", () => {
    expect(issues({ datasetBytes: 1024 * 1024, pagedStepMinutes: 30 })).toEqual([]);
    expect(issues({ datasetBytes: 3 * 1024 * 1024 * 1024 })).toEqual([
      ["limits.datasetBytes", "not_supported_yet"]
    ]);
    expect(issues({ pagedStepMinutes: 61 })).toEqual([]);
  });
});

describe("a raise of a limit at publish", () => {
  const WORKFLOW = "nightly-import";
  const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };

  async function draft(t: WorkflowFixture, limits: Record<string, unknown>) {
    const response = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: {
        config: { name: WORKFLOW, manifest: reading(WORKFLOW, limits) },
        expectedRevision: null
      }
    });
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  }
  const publish = (t: WorkflowFixture, revision: number) =>
    t.call(t.root.id, "assets.publish", { params: address, payload: { revision } });
  const question = async (t: WorkflowFixture) =>
    z
      .object({ publishQuestion: z.array(z.string()).optional() })
      .parse((await t.expectOk(t.root.id, "assets.get", { params: address })).json())
      .publishQuestion ?? [];

  it("publishes `duration: 30h` under a ceiling of 48 hours and names the raise", async () => {
    const t = await ready({ definitions: "assets", ceilings: { durationMs: 48 * HOUR } });
    const revision = await draft(t, { duration: "30h" });
    const lines = await question(t);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("12h");
    expect(lines[0]).toContain("30h");
    const published = await publish(t, revision);
    expect(published.statusCode, published.body).toBe(200);
  });

  it("refuses `duration: 30h` under a ceiling of 12 hours and names the ceiling", async () => {
    const t = await ready({ definitions: "assets", ceilings: { durationMs: 12 * HOUR } });
    const refused = await publish(t, await draft(t, { duration: "30h" }));
    expect(refused.statusCode, refused.body).toBe(422);
    const error = errorSchema.parse(refused.json()).error;
    expect(error.details).toMatchObject({ reason: "limit_above_ceiling" });
    expect(error.message).toContain("12h");
    expect(
      (await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address }))
        ?.publishedRevisionId
    ).toBeUndefined();
  });

  it("asks nothing of a definition that keeps the defaults or lowers them", async () => {
    const t = await ready({ definitions: "assets" });
    await draft(t, { duration: "2h", stepRuns: 100 });
    expect(await question(t)).toEqual([]);
  });

  it("refuses a concurrency above the instance's step slots, naming them", async () => {
    const t = await ready({ definitions: "assets", stepSlots: 4 });
    const refused = await publish(t, await draft(t, { concurrency: 6 }));
    expect(refused.statusCode, refused.body).toBe(422);
    const error = errorSchema.parse(refused.json()).error;
    expect(error.details).toMatchObject({ reason: "limit_above_ceiling" });
    expect(error.message).toContain("4");
  });
});

describe("limits.concurrency of a Workflow", () => {
  const BULK_ITEMS = Array.from({ length: 8 }, (_, index) => `bulk-${String(index)}`);
  const OTHER_ITEMS = Array.from({ length: 4 }, (_, index) => `other-${String(index)}`);

  /** A root Workflow that fans out over a list, each item a child run or one call. */
  function fanOut(id: string, items: string, body: unknown, limits?: Record<string, unknown>) {
    return {
      id,
      name: id,
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      ...(limits ? { limits } : {}),
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "list",
          name: "List",
          type: "operation",
          operation: "connection.crm.echo",
          input: { text: { value: items } }
        },
        {
          id: "each",
          name: "Each",
          type: "loop",
          items: { step: "list", path: "items" },
          concurrency: 8,
          steps: [body]
        },
        { id: "result", name: "Result", type: "output", input: { done: ref("each", "done") } }
      ]
    };
  }

  const bulkItem = {
    id: "bulk-item",
    name: "Bulk item",
    runAs: "workflow-runner",
    inputs: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"]
    },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Parent", type: "trigger", triggers: [{ kind: "parent" }] },
      {
        id: "read",
        name: "Read",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: ref("start", "input.value") }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };

  it("holds a Workflow to its 2 slots across its runs and children while another keeps its own, on two workers", async () => {
    const definitions = publishedDefinitions();
    definitions.publish(bulkItem);
    definitions.publish(
      fanOut(
        "bulk",
        "bulk-items",
        {
          id: "item",
          name: "Item",
          type: "workflow",
          workflow: "bulk-item",
          input: { value: ref("each", "") }
        },
        { concurrency: 2 }
      )
    );
    // No limit set: every slot, of which its four items take four.
    definitions.publish(
      fanOut("other", "other-items", {
        id: "call",
        name: "Call",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: ref("each", "") }
      })
    );
    const t = await ready({ definitions: definitions.source, stepSlots: 8 });
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    // A held call keeps its slot as long as the gate holds it: workers start late on a busy
    // machine.
    t.state.limits = { ...t.state.limits, callTimeoutMs: 30_000 };
    t.state.centralSettings = [
      ...t.state.centralSettings,
      { operation: "workflow.bulk-item.start", value: "allow" }
    ];
    const going = { bulk: 0, other: 0 };
    const most = { bulk: 0, other: 0, otherWhileBulkFull: 0 };
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timer = setTimeout(release, 15_000);
    t.setBehaviour(async (_operation, input): Promise<JsonValue> => {
      const text = z.object({ text: z.string() }).parse(input).text;
      if (text === "bulk-items") return { items: BULK_ITEMS };
      if (text === "other-items") return { items: OTHER_ITEMS };
      const which = text.startsWith("bulk-") ? "bulk" : "other";
      going[which] += 1;
      most[which] = Math.max(most[which], going[which]);
      if (going.bulk >= 2) most.otherWhileBulkFull = Math.max(most.otherWhileBulkFull, going.other);
      // Every call stays until the bulk Workflow holds its two slots and the other one its
      // four at the same moment, or the timer gives up.
      if (going.bulk >= 2 && going.other >= 4) release();
      await gate;
      await new Promise((resolve) => setTimeout(resolve, 30));
      going[which] -= 1;
      return { value: text };
    });
    const started = async (workflow: string) =>
      runSchema.parse(
        (
          await t.expectOk(t.root.id, "workflows.start", {
            params: { workflow },
            payload: { input: {} }
          })
        ).json()
      );
    const bulk = await started("bulk");
    const other = await started("other");
    await untilEnded(t, [bulk.id, other.id], 2);
    clearTimeout(timer);

    const read = async (id: string) =>
      runSchema.parse(
        (await t.expectOk(t.root.id, "workflows.get_run", { params: { runId: id } })).json()
      );
    const bulkRun = await read(bulk.id);
    expect(bulkRun, JSON.stringify(bulkRun.error)).toMatchObject({ status: "done" });
    const otherRun = await read(other.id);
    expect(otherRun, JSON.stringify(otherRun.error)).toMatchObject({ status: "done" });
    expect(most.bulk).toBe(2);
    expect(most.other).toBe(4);
    expect(most.otherWhileBulkFull).toBe(4);
    const loop = (await stepRunsOf(t, bulk.id)).find((step) => step.key === "each");
    expect(loop?.concurrency).toEqual({ asked: 8, ranWith: 2 });
  }, 120_000);
});

describe("time a run spends waiting", () => {
  const SYNC = "fixture_sync.start";
  const counts = z.strictObject({ added: z.number() });

  /** An operation whose work ends after the call: the test ends its Operation Run. */
  function syncSource(started: OperationRunId[]): OperationSource {
    const definition: OperationDefinition = {
      name: SYNC,
      effect: "changing",
      changeClass: "reversible",
      scope: null,
      auth: "principal",
      action: "connection.use",
      timeoutMs: 10 * DAY,
      completion: { mode: "async", stillRunning: "Abgleich läuft weiter", example: { added: 0 } },
      inputSchema: z.object({ source: z.string() }),
      outputSchema: counts,
      resource: () => undefined,
      execute(_input, context) {
        started.push(context.runId);
        return Promise.resolve({ started: true });
      }
    };
    return {
      resolve: (name) => Promise.resolve(name === SYNC ? definition : undefined),
      list: () => Promise.resolve({ operations: [definition], truncated: [] })
    };
  }

  function waiting(id: string, trigger: "manual" | "parent", limits?: Record<string, unknown>) {
    return {
      id,
      name: id,
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      ...(limits ? { limits } : {}),
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: trigger }] },
        {
          id: "sync",
          name: "Abgleich",
          type: "operation",
          operation: SYNC,
          input: { source: { value: "objekte" } },
          timeout: "96h"
        },
        { id: "result", name: "Result", type: "output", input: { added: ref("sync", "added") } }
      ]
    };
  }

  async function readyWaiting(
    workflows: unknown[],
    options: Parameters<typeof workflowFixture>[0] = {}
  ) {
    const clock = { offsetMs: 0 };
    const definitions = publishedDefinitions();
    for (const workflow of workflows) definitions.publish(workflow);
    const t = await ready({
      definitions: definitions.source,
      now: () => new Date(Date.now() + clock.offsetMs),
      ...options
    });
    const started: OperationRunId[] = [];
    t.operationCalls.registry.addSource(syncSource(started));
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    t.state.centralSettings = [
      ...t.state.centralSettings,
      { operation: SYNC, value: "allow" },
      { operation: "workflow.synced.start", value: "allow" }
    ];
    return { t, clock, started };
  }

  const endSync = (t: WorkflowFixture, id: OperationRunId | undefined) => {
    if (id === undefined) throw new Error("The sync was not called");
    return t.stores.operationRuns.finish({
      clientInstanceId,
      id,
      end: { status: "done", finishedAt: new Date().toISOString(), output: { value: { added: 3 } } }
    });
  };

  const startRun = async (t: WorkflowFixture, workflow: string, key?: string) =>
    runSchema.parse(
      (
        await t.expectOk(t.root.id, "workflows.start", {
          params: { workflow },
          payload: { input: {}, ...(key === undefined ? {} : { key }) }
        })
      ).json()
    );

  async function untilSyncWaits(t: WorkflowFixture, runId: () => Promise<string | undefined>) {
    const worker = t.worker();
    for (let pass = 0; pass < 40; pass++) {
      await worker.runDue();
      const id = await runId();
      const step = id ? (await stepRunsOf(t, id)).find((s) => s.stepId === "sync") : undefined;
      if (step?.status === "waiting") return worker;
    }
    throw new Error("The sync step did not wait");
  }

  it("counts no minute of a wait of 3 days against a duration of 1 hour", async () => {
    const { t, clock, started } = await readyWaiting([
      waiting("import", "manual", { duration: "1h" })
    ]);
    const run = await startRun(t, "import");
    const worker = await untilSyncWaits(t, () => Promise.resolve(run.id));
    const before = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
    clock.offsetMs = 3 * DAY;
    await endSync(t, started[0]);
    const done = await t.finish(run.id, worker);
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: "done" });
    expect(JSON.parse(done.outputPreview?.text ?? "null")).toEqual({ added: 3 });
    const after = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
    expect(after?.waitedMs).toBeGreaterThanOrEqual(3 * DAY);
    expect(Date.parse(after?.deadlineAt ?? "")).toBeGreaterThanOrEqual(
      Date.parse(before?.deadlineAt ?? "") + 3 * DAY
    );
  });

  it("leaves a waiting run alone when its deadline job comes due, and ends it after the wait", async () => {
    // Advance the process clock and make its deadline job due on the database clock.
    const {
      t: short,
      clock,
      started
    } = await readyWaiting([waiting("import", "manual")], {
      limits: { maxDurationMs: 5_000 }
    });
    const run = await startRun(short, "import");
    const worker = await untilSyncWaits(short, () => Promise.resolve(run.id));
    clock.offsetMs = 6_000;
    await makeJobsDue("workflow_run.deadline");
    // The deadline job runs here and finds the run waiting.
    await worker.runDue();
    expect(await short.stores.workflowRuns.readRun({ clientInstanceId, id: run.id })).toMatchObject(
      { status: "running" }
    );
    await endSync(short, started.at(-1));
    const done = await short.finish(run.id, worker);
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: "done" });
    expect(
      (await short.stores.workflowRuns.readRun({ clientInstanceId, id: run.id }))?.waitedMs
    ).toBeGreaterThanOrEqual(6_000);
  }, 60_000);

  it("retains the moved deadline while the old deadline job is still running", async () => {
    const source = waiting("import", "manual");
    const definition = parseOk({
      ...source,
      steps: [
        ...source.steps.slice(0, 2),
        {
          id: "busy",
          name: "Busy",
          type: "operation",
          operation: "connection.crm.echo",
          input: { text: { value: "busy" } }
        },
        ...source.steps.slice(2)
      ]
    });
    const { t, started } = await readyWaiting([definition]);
    const busy = deferred<void>();
    const busyEntered = deferred<void>();
    t.state.limits = { ...t.state.limits, callTimeoutMs: 30_000 };
    t.setBehaviour(async () => {
      busyEntered.resolve();
      await busy.promise;
      return {};
    });
    const run = await startRun(t, "import");
    await untilSyncWaits(t, () => Promise.resolve(run.id));
    const returned = deferred<void>();
    const settle = deferred<void>();
    let first = true;
    const deadline = t.worker(
      t.workflows.jobHandlers
        .filter((handler) => handler.kind.kind === "workflow_run.deadline")
        .map((handler): RegisteredJobHandler => ({
          ...handler,
          bind(job) {
            const bound = handler.bind(job);
            return {
              ...bound,
              async run(control) {
                await bound.run(control);
                if (first) {
                  first = false;
                  returned.resolve();
                  await settle.promise;
                }
              }
            };
          }
        }))
    );
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1, onnotice() {} });
    let attempt: Promise<void> | undefined;
    try {
      await sql`update platform_jobs set run_after = now() where kind = 'workflow_run.deadline' and subject = ${run.id}`;
      attempt = deadline.runDue();
      await returned.promise; // The waiting-run check committed; the job row still runs.
      await endSync(t, started[0]);
      const working = t.worker(
        t.workflows.jobHandlers.filter((handler) => handler.kind.kind !== "workflow_run.deadline")
      );
      await waitUntil(async () => {
        if ((await stepRunsOf(t, run.id)).some((step) => step.stepId === "busy")) return true;
        await working.runDue();
        return false;
      }, "the resumed run queues its busy step");
      const pass = working.runDue();
      await busyEntered.promise;
      // Put the resumed deadline in the past without a real-time sleep. The wake must
      // survive the old job's successful settlement and drive the new deadline check.
      await sql`update workflow_runs set deadline_at = now() - interval '1 second' where id = ${run.id}`;
      await sql`update platform_job_wakes set run_after = now() where subject = ${run.id}`;
      settle.resolve();
      await attempt;
      await deadline.runDue();
      expect(await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id })).toMatchObject({
        status: "limit_reached",
        error: { code: "duration_limit" }
      });
      busy.resolve();
      await pass;
    } finally {
      settle.resolve();
      busy.resolve();
      await attempt;
      await sql.end();
    }
  });

  it("moves a parent's deadline with the wait of its child", async () => {
    const { t, clock, started } = await readyWaiting([
      waiting("synced", "parent", { duration: "1h" }),
      {
        id: "outer",
        name: "Outer",
        runAs: "workflow-runner",
        inputs: { type: "object" },
        outputs: { type: "object" },
        limits: { duration: "1h" },
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          { id: "child", name: "Child", type: "workflow", workflow: "synced", input: {} },
          { id: "result", name: "Result", type: "output", input: { child: ref("child", "") } }
        ]
      }
    ]);
    const run = await startRun(t, "outer");
    const stored = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
    if (stored === undefined) throw new Error("The run was not stored");
    const childId = async () =>
      (await t.stores.workflowRuns.listChildRuns({ clientInstanceId, id: stored.id }))[0]?.id;
    const worker = await untilSyncWaits(t, childId);
    clock.offsetMs = 3 * DAY;
    await endSync(t, started[0]);
    const done = await t.finish(run.id, worker);
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: "done" });
    const id = await childId();
    if (id === undefined) throw new Error("The child run was not started");
    const child = await t.stores.workflowRuns.readRun({ clientInstanceId, id });
    expect(child).toMatchObject({ status: "done" });
    expect(child?.waitedMs).toBeGreaterThanOrEqual(3 * DAY);
    expect(
      (await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id }))?.waitedMs
    ).toBeGreaterThanOrEqual(3 * DAY);
  });

  it("excludes a 3-day wait on a run linked by key from duration, including its parent's duration", async () => {
    const keyed = waiting("synced", "parent", { duration: "1h" });
    keyed.steps[0] = {
      id: "start",
      name: "Start",
      type: "trigger",
      triggers: [{ kind: "manual" }, { kind: "parent" }]
    };
    const caller = (id: string, workflow: string, key?: string) => ({
      id,
      name: id,
      runAs: "workflow-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      limits: { duration: "1h" },
      steps: [
        {
          id: "start",
          name: "Start",
          type: "trigger",
          triggers: [{ kind: "manual" }, { kind: "parent" }]
        },
        {
          id: "child",
          name: "Child",
          type: "workflow",
          workflow,
          input: {},
          ...(key === undefined ? {} : { key: [{ value: key }] })
        },
        { id: "result", name: "Result", type: "output", input: { child: ref("child", "") } }
      ]
    });
    const { t, clock, started } = await readyWaiting([
      keyed,
      caller("linked", "synced", "shared"),
      caller("outer", "linked")
    ]);
    t.state.centralSettings = [
      ...t.state.centralSettings,
      { operation: "workflow.linked.start", value: "allow" }
    ];
    const holder = await startRun(t, "synced", "shared");
    const worker = await untilSyncWaits(t, () => Promise.resolve(holder.id));
    const outer = await startRun(t, "outer");
    const storedOuter = await t.stores.workflowRuns.readRun({ clientInstanceId, id: outer.id });
    if (storedOuter === undefined) throw new Error("The outer run was not stored");
    let linkedId: WorkflowRunId | undefined;
    for (let pass = 0; pass < 40; pass++) {
      await worker.runDue();
      linkedId = (
        await t.stores.workflowRuns.listChildRuns({ clientInstanceId, id: storedOuter.id })
      )[0]?.id;
      if (
        linkedId &&
        (await t.stores.workflowRuns.listOpenStepRuns({ clientInstanceId, id: linkedId })).some(
          (step) => step.linkedRunId === holder.id && step.status === "waiting"
        )
      )
        break;
    }
    if (linkedId === undefined) throw new Error("The caller did not start");
    expect(await t.stores.workflowRuns.listChildRuns({ clientInstanceId, id: linkedId })).toEqual(
      []
    );
    const before = await Promise.all(
      [holder.id, linkedId, outer.id].map((id) =>
        t.stores.workflowRuns.readRun({ clientInstanceId, id })
      )
    );
    expect(before.every((run) => run?.waitingSince !== undefined)).toBe(true);
    clock.offsetMs = 3 * DAY;
    await endSync(t, started[0]);
    expect(await t.finish(outer.id, worker)).toMatchObject({ status: "done" });
    for (const original of before) {
      if (original === undefined) throw new Error("The run was not stored");
      const after = await t.stores.workflowRuns.readRun({ clientInstanceId, id: original.id });
      expect(after).toMatchObject({ status: "done" });
      expect(after?.waitingSince).toBeUndefined();
      expect(after?.waitedMs).toBeGreaterThanOrEqual(3 * DAY);
      expect(Date.parse(after?.deadlineAt ?? "")).toBeGreaterThanOrEqual(
        Date.parse(original.deadlineAt) + 3 * DAY
      );
    }
    expect(started).toHaveLength(1);
  });

  it("still ends a run whose steps work past its duration", async () => {
    const { t, clock } = await readyWaiting([reading("busy", { duration: "1h" })]);
    const run = await startRun(t, "busy");
    clock.offsetMs = 2 * HOUR;
    const ended = await t.finish(run.id);
    expect(ended).toMatchObject({ status: "limit_reached", error: { code: "duration_limit" } });
  });
});
