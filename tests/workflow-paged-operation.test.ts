import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { connectionCallError, type OperationPaging } from "@work-shape/catalyst-core";
import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import { workflowLimitCeilingsOf } from "@work-shape/catalyst-client-assembly";
import {
  parseWorkflowManifest,
  createWorkflowDatasets,
  workflowLimitIssues,
  workflowLimitRaises
} from "@work-shape/catalyst-workflows";
import { createChatServerJobs } from "@work-shape/catalyst-server";
import { required, waitUntil } from "./support/assertions";
import { testServerOptions } from "./support/test-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import {
  workflowFixture,
  publishedDefinitions,
  hangingAt,
  runSchema,
  type WorkflowFixture
} from "./support/workflow-instance";
import { fetchTestOperation, listenTestInstance } from "./support/test-instance";
import { clientInstanceId } from "./support/access-instance";
import { operationOf, write } from "./support/connection-operations";
import { stepRunsOf } from "./support/workflow-runs";

let t: WorkflowFixture | undefined;
afterEach(async () => {
  await t?.instance.close();
  t = undefined;
});
const row = { type: "object", properties: { id: { type: "integer" } }, required: ["id"] };
function manifest() {
  return {
    id: "paged",
    name: "Paged",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object", properties: { rows: { type: "dataset", row } } },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "rows",
        name: "Rows",
        type: "operation",
        operation: "connection.crm.echo",
        input: {},
        paginate: true,
        dataset: { at: "rows" }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { rows: { ref: { step: "rows", path: "rows" } } }
      }
    ]
  };
}
async function setup(
  paging: OperationPaging,
  options: {
    objects?: MemoryObjectStorage;
    now?: () => Date;
    pages?: number;
    pageBytes?: number;
    rows?: number;
    bytes?: number;
    pagedStepMinutes?: number;
    workflowMinutes?: number;
  } = {}
) {
  const definitions = publishedDefinitions();
  const {
    pagedStepMinutes,
    workflowMinutes,
    now,
    objects = new MemoryObjectStorage(),
    ...datasetLimits
  } = options;
  definitions.publish({
    ...manifest(),
    ...(workflowMinutes ? { limits: { pagedStepMinutes: workflowMinutes } } : {})
  });
  t = await workflowFixture({
    definitions: definitions.source,
    ...(now ? { now } : {}),
    datasetObjects: objects,
    datasetLimits: { ...workflowsConfigSchema.parse({}).datasets, ...datasetLimits },
    ceilings: {
      pagedStepMinutes: pagedStepMinutes ?? workflowsConfigSchema.parse({}).limits.pagedStepMinutes
    },
    connectorCatalog: [
      {
        name: "echo",
        description: "Reads a page",
        proposedEffect: "reading",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { rows: { type: "array", items: row } } }
      },
      write
    ]
  });
  await t.seed("crm", {
    operations: [operationOf("echo", { exposure: ["workflow"], paging: { ...paging } })]
  });
  t.state.limits = { ...t.state.limits, resultMaxBytes: 2 * 1024 ** 2 };
  await t.allow({ kind: "service_principal", id: t.principal.id }, "connection.use");
  const base = await listenTestInstance(t.instance);
  const headers = { "x-test-user": t.root.id, "content-type": "application/json" };
  const response = await fetchTestOperation(base, "workflows.start", {
    params: { workflow: "paged" },
    headers,
    body: JSON.stringify({ input: {} })
  });
  expect(response.status).toBe(200);
  return { fixture: t, id: runSchema.parse(await response.json()).id, objects };
}

it.each(["page", "offset", "cursor", "next_link"] as const)(
  "reads %s pages under one Operation Run with no rows in its record",
  async (by) => {
    const paging: OperationPaging =
      by === "page" || by === "offset"
        ? { by, param: "position", sizeParam: "size", size: 2 }
        : { by, param: "position", cursor: "next" };
    const { fixture: f, id } = await setup(paging);
    const positions: unknown[] = [];
    f.setBehaviour(async (_op, input) => {
      const args = z
        .object({ position: z.union([z.string(), z.number()]).optional() })
        .parse(input);
      positions.push(args.position);
      const i = positions.length - 1;
      return {
        rows: i < 2 ? [{ id: i * 2 }, { id: i * 2 + 1 }] : [{ id: 4 }],
        next: i < 2 ? `next-${i + 1}` : null,
        first: i
      };
    });
    expect((await f.finish(id)).status).toBe("done");
    const runs = (await f.runs()).filter((run) => run.operation === "connection.crm.echo");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.output?.value).toMatchObject({ pages: 3, rows: 5 });
    expect(JSON.stringify(runs[0])).not.toContain('"id":4');
    expect(positions).toEqual(
      by === "page" ? [1, 2, 3] : by === "offset" ? [0, 2, 4] : [undefined, "next-1", "next-2"]
    );
    const [dataset] = await f.stores.workflowRunDatasets.listForRun({
      clientInstanceId,
      runId: z
        .custom<Parameters<typeof f.stores.workflowRunDatasets.listForRun>[0]["runId"]>()
        .parse(id),
      limit: 10
    });
    expect(dataset).toMatchObject({ state: "complete", rowCount: 5 });
    expect(dataset?.parts).toHaveLength(3);
  }
);

it("defers a 429 after a complete page and resumes its one run without replaying that page", async () => {
  const { fixture: f, id } = await setup({ by: "page", param: "page", sizeParam: "size", size: 2 });
  const positions: number[] = [];
  let refused = false;
  f.setBehaviour(async (_op, input) => {
    const { page } = z.object({ page: z.number() }).parse(input);
    positions.push(page);
    if (page === 2 && !refused) {
      refused = true;
      throw connectionCallError("upstream_rate_limited", undefined, 0);
    }
    return { rows: page === 1 ? [{ id: 0 }, { id: 1 }] : [{ id: 2 }] };
  });
  expect((await f.finish(id)).status).toBe("done");
  expect(positions).toEqual([1, 2, 2]);
  expect((await f.runs()).filter((run) => run.operation === "connection.crm.echo")).toHaveLength(1);
  expect((await stepRunsOf(f, id)).find((step) => step.stepId === "rows")?.attempt).toBe(1);
});

it.each(["pages", "pageBytes", "rows", "bytes", "pagedStepMinutes"] as const)(
  "fails at the operator %s ceiling before any consumer runs",
  async (name) => {
    const { fixture: f, id } = await setup(
      { by: "page", param: "page", sizeParam: "size", size: 2 },
      { [name]: name === "pagedStepMinutes" ? 0.000001 : 1 }
    );
    f.setBehaviour(async () => ({ rows: [{ id: 0 }, { id: 1 }] }));
    const result = await f.finish(id);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "dataset_limit", message: expect.stringContaining(name) }
    });
    expect((await stepRunsOf(f, id)).some((step) => step.stepId === "result")).toBe(false);
  }
);

it("retries transient failures three times per page, independently of preceding pages", async () => {
  const { fixture: f, id } = await setup({ by: "page", param: "page", sizeParam: "size", size: 2 });
  const calls = new Map<number, number>();
  f.setBehaviour(async (_op, input) => {
    const { page } = z.object({ page: z.number() }).parse(input);
    const count = (calls.get(page) ?? 0) + 1;
    calls.set(page, count);
    if (count < 3) throw connectionCallError("connection_unavailable");
    return { rows: page === 1 ? [{ id: 0 }, { id: 1 }] : [] };
  });
  expect((await finishDeferred(f, id)).status).toBe("done");
  expect([...calls.values()]).toEqual([3, 3]);
});

it("stops before the next page when the principal's grant is removed", async () => {
  const { fixture: f, id } = await setup({ by: "page", param: "page", sizeParam: "size", size: 2 });
  let calls = 0;
  f.setBehaviour(async () => {
    calls += 1;
    const grants = await f.stores.access.listGrants({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: f.principal.id,
      action: "connection.use",
      page: { limit: 10 }
    });
    for (const grant of grants)
      await f.stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
    return { rows: calls === 1 ? [{ id: 0 }, { id: 1 }] : [{ id: 2 }] };
  });
  expect((await f.finish(id)).status).toBe("failed");
  expect(calls).toBe(1);
});

it("requires a dataset at parse and a reading paging descriptor at start over HTTP", async () => {
  const value = manifest();
  const withoutDataset = {
    ...value,
    steps: value.steps.map((step) => (step.id === "rows" ? { ...step, dataset: undefined } : step))
  };
  expect(parseWorkflowManifest(withoutDataset)).toMatchObject({ ok: false });
});

it("stores 100,000 rows and a 1.3 MiB page without retaining rows on the step", async () => {
  const { fixture: f, id } = await setup({
    by: "page",
    param: "page",
    sizeParam: "size",
    size: 1000
  });
  f.setBehaviour(async (_op, input) => {
    const { page } = z.object({ page: z.number() }).parse(input);
    return {
      rows:
        page > 100
          ? []
          : Array.from({ length: 1000 }, (_, offset) => ({
              id: (page - 1) * 1000 + offset,
              ...(page === 1 ? { text: "x".repeat(1400) } : {})
            }))
    };
  });
  expect((await f.finish(id)).status).toBe("done");
  const [call] = (await f.runs()).filter((run) => run.operation === "connection.crm.echo");
  expect(call?.output?.value).toMatchObject({ pages: 101, rows: 100_000 });
  const preview = (await stepRunsOf(f, id)).find((step) => step.stepId === "rows")?.outputPreview
    ?.text;
  expect(JSON.parse(preview ?? "null")).toMatchObject({ rows: { rowCount: 100_000 } });
}, 60_000);

it("resumes after a lost worker from the next complete page with every row once", async () => {
  const {
    fixture: f,
    id,
    objects
  } = await setup({ by: "page", param: "page", sizeParam: "size", size: 2 });
  let entered: () => void = () => undefined;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const positions: number[] = [];
  let held = false;
  f.setBehaviour(async (_op, input, context) => {
    const { page } = z.object({ page: z.number() }).parse(input);
    positions.push(page);
    if (page === 80 && !held) {
      held = true;
      entered();
      await new Promise<void>((_resolve, reject) =>
        context.signal.addEventListener("abort", () => reject(new Error("Worker stopped")), {
          once: true
        })
      );
    }
    return { rows: page < 80 ? [{ id: page * 2 }, { id: page * 2 + 1 }] : [{ id: 160 }] };
  });
  const dead = f.worker();
  let arrived = false;
  const waiting = reached.then(() => {
    arrived = true;
  });
  for (let pass = 0; pass < 10 && !arrived; pass++) await Promise.race([dead.runDue(), waiting]);
  expect(arrived).toBe(true);
  await dead.stop();
  expect((await f.finish(id, f.worker())).status).toBe("done");
  expect(positions).toEqual([...Array.from({ length: 80 }, (_, i) => i + 1), 80]);
  const [call] = (await f.runs()).filter((run) => run.operation === "connection.crm.echo");
  expect(call?.output?.value).toMatchObject({ pages: 80, rows: 159 });
  expect((await f.runs()).filter((run) => run.operation === "connection.crm.echo")).toHaveLength(1);
  const run = await f.stores.workflowRuns.readRun({ clientInstanceId, id });
  if (!run) throw new Error("Missing run");
  const [record] = await f.stores.workflowRunDatasets.listForRun({
    clientInstanceId,
    runId: run.id,
    limit: 10
  });
  if (!record) throw new Error("Missing dataset");
  const datasets = createWorkflowDatasets({
    clientInstanceId,
    stores: f.stores,
    objects,
    limits: workflowsConfigSchema.parse({}).datasets
  });
  const reader = await datasets.reader({ id: record.id, runId: run.id });
  const ids: unknown[] = [];
  for await (const row of reader.rows) ids.push(row.id);
  expect(ids).toEqual(Array.from({ length: 159 }, (_, i) => i + 2));
});

it("refuses missing paging and changing operations at save over HTTP, and accepts an override", async () => {
  t = await workflowFixture({
    definitions: "assets",
    connectorCatalog: [
      {
        name: "echo",
        description: "Reads rows",
        proposedEffect: "reading",
        inputSchema: { type: "object" },
        outputSchema: { type: "object", properties: { rows: { type: "array", items: row } } }
      },
      write
    ]
  });
  const f = t;
  await f.seedCrm();
  const base = await listenTestInstance(f.instance);
  const save = (value: unknown) =>
    fetchTestOperation(base, "assets.put", {
      params: { kind: "workflow", name: "paged" },
      headers: { "x-test-user": f.root.id, "content-type": "application/json" },
      body: JSON.stringify({ config: { name: "paged", manifest: value }, expectedRevision: null })
    });
  expect((await save(manifest())).status).toBe(422);
  const changing = {
    ...manifest(),
    steps: manifest().steps.map((step) =>
      step.id === "rows" ? { ...step, operation: "connection.crm.write" } : step
    )
  };
  expect((await save(changing)).status).toBe(422);
  await f.seed("crm", {
    operations: [
      operationOf("echo", {
        exposure: ["workflow"],
        paging: { by: "page", param: "page", sizeParam: "size", size: 2 }
      })
    ]
  });
  const override = {
    ...manifest(),
    steps: manifest().steps.map((step) =>
      step.id === "rows" ? { ...step, paginate: { size: 10 } } : step
    )
  };
  const accepted = await save(override);
  expect(accepted.status, await accepted.text()).toBe(200);
});

it("replays completed paging if the worker dies before committing the step", async () => {
  const { fixture: f, id } = await setup({ by: "page", param: "page", sizeParam: "size", size: 2 });
  let calls = 0;
  f.setBehaviour(async () => {
    calls++;
    return { rows: [{ id: 1 }] };
  });
  const dying = hangingAt(f.workflows.jobHandlers, 4);
  const worker = f.worker(dying.handlers);
  let reached = false;
  const arrived = dying.reached.then(() => {
    reached = true;
  });
  for (let pass = 0; pass < 10 && !reached; pass++) await Promise.race([worker.runDue(), arrived]);
  expect(reached).toBe(true);
  await worker.stop();
  expect((await f.finish(id, f.worker())).status).toBe("done");
  expect(calls).toBe(1);
  expect((await f.runs()).filter((run) => run.operation === "connection.crm.echo")).toHaveLength(1);
});

it("keeps spent page attempts through a 429 deferral", async () => {
  const { fixture: f, id } = await setup({ by: "page", param: "page", sizeParam: "size", size: 2 });
  let secondPage = 0;
  f.setBehaviour(async (_operation, input) => {
    const { page } = z.object({ page: z.number() }).parse(input);
    if (page === 1) return { rows: [{ id: 0 }, { id: 1 }] };
    secondPage++;
    if (secondPage === 2) throw connectionCallError("upstream_rate_limited", undefined, 0);
    if (secondPage <= 4) throw connectionCallError("connection_unavailable");
    return { rows: [] };
  });
  expect(await finishDeferred(f, id)).toMatchObject({
    status: "failed",
    error: { code: "operation_page_failed" }
  });
  expect(secondPage).toBe(4); // Three transient failures and one source deferral.
  const calls = (await f.runs()).filter((run) => run.operation === "connection.crm.echo");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.output?.value).toMatchObject({ pages: 1, rows: 2, pageAttempts: 3 });
});

it("accepts raised paging operator ceilings and Workflow minutes without a fixed default cap", () => {
  const release = workflowsConfigSchema.parse({
    limits: { pagedStepMinutes: 180 },
    datasets: { pages: 25_000, pageBytes: 16 * 1024 ** 2 }
  });
  expect(release.limits.pagedStepMinutes).toBe(180);
  const context = { ceilings: workflowLimitCeilingsOf(release), stepSlots: release.stepSlots };
  expect(workflowLimitIssues({ limits: { pagedStepMinutes: 120 } }, context)).toEqual([]);
  expect(workflowLimitIssues({ limits: { pagedStepMinutes: 181 } }, context)).toMatchObject([
    { path: "limits.pagedStepMinutes" }
  ]);
  expect(workflowLimitRaises({ limits: { pagedStepMinutes: 120 } }, context)).toEqual([
    { field: "pagedStepMinutes", standard: 60, asked: 120 }
  ]);
  expect(release.datasets.pages).toBe(25_000);
  expect(release.datasets.pageBytes).toBe(16 * 1024 ** 2);
  expect(parseWorkflowManifest({ ...manifest(), limits: { pagedStepMinutes: 120 } })).toMatchObject(
    { ok: true }
  );
});

it("runs a paged step above sixty minutes under the EW-LIM operator ceiling", async () => {
  const { fixture: f, id } = await setup(
    { by: "page", param: "page", sizeParam: "size", size: 2 },
    { pagedStepMinutes: 180, workflowMinutes: 120 }
  );
  f.setBehaviour(async () => ({ rows: [{ id: 1 }] }));
  expect(await f.finish(id)).toMatchObject({ status: "done" });
});

// These regressions adapt the independent verifier's crash, sweep and retry probes.
async function finishDeferred(f: WorkflowFixture, id: string) {
  const worker = f.worker();
  let result: Awaited<ReturnType<WorkflowFixture["finish"]>> | undefined;
  await waitUntil(
    async () => {
      result = await f.finish(id, worker, 1).catch(() => undefined);
      return result !== undefined;
    },
    "the deferred paged run ends",
    25_000
  );
  return required(result);
}
function sweepOf(f: WorkflowFixture, now: () => Date) {
  const handler = required(
    createChatServerJobs(required(testServerOptions(f.instance)), { now }).handlers.find(
      (handler) => handler.kind.kind === "operation_runs.recover"
    )
  );
  const worker = f.worker([handler]);
  return async () => {
    await f.stores.jobs.enqueue(
      handler.kind,
      {},
      { clientInstanceId, correlationId: "paged-sweep" }
    );
    await worker.runDue();
  };
}
it("the real minute sweep preserves a multi-minute read with advancing checkpoints", async () => {
  let clock = Date.now();
  const now = () => new Date(clock);
  const { fixture: f, id } = await setup(
    { by: "page", param: "p", sizeParam: "s", size: 2 },
    { now }
  );
  const sweep = sweepOf(f, now);
  f.setBehaviour(async (_op, input) => {
    const { p } = z.object({ p: z.number() }).parse(input);
    clock += 61_000;
    await sweep();
    expect((await f.runs()).find((run) => run.operation === "connection.crm.echo")?.status).toBe(
      "running"
    );
    return { rows: p < 6 ? [{ id: p * 2 }, { id: p * 2 + 1 }] : [] };
  });
  expect(await f.finish(id)).toMatchObject({ status: "done" });
  expect(
    (await f.runs()).find((run) => run.operation === "connection.crm.echo")?.output?.value
  ).toMatchObject({ pages: 6, rows: 10 });
});
it.each(["stalled", "deadline"] as const)(
  "the real sweep ends a paged run at its %s bound",
  async (bound) => {
    let clock = Date.now();
    const now = () => new Date(clock);
    const { fixture: f, id } = await setup(
      { by: "page", param: "p", sizeParam: "s", size: 2 },
      {
        now,
        ...(bound === "deadline" ? { pagedStepMinutes: 1 } : {})
      }
    );
    const sweep = sweepOf(f, now);
    f.setBehaviour(async () => {
      clock += bound === "stalled" ? 5 * 60_000 : 61_000;
      await sweep();
      expect((await f.runs()).find((run) => run.operation === "connection.crm.echo")).toMatchObject(
        { status: "failed", error: { code: "interrupted" } }
      );
      return { rows: [] };
    });
    expect(await f.finish(id)).toMatchObject({ status: "failed" });
  }
);
it("queueing for a slot consumes no paged minutes", async () => {
  let clock = Date.now();
  const { fixture: f, id } = await setup(
    { by: "page", param: "p", sizeParam: "s", size: 2 },
    {
      now: () => new Date(clock),
      pagedStepMinutes: 1
    }
  );
  await f.worker().runDue(); // Create the reading step, then leave it in the slot queue.
  const queued = (await stepRunsOf(f, id)).find((step) => step.stepId === "rows");
  expect(queued?.status).toBe("queued");
  clock += 2 * 60 * 60_000;
  f.setBehaviour(async () => ({ rows: [{ id: 1 }] }));
  expect(await f.finish(id)).toMatchObject({ status: "done" });
});
it("backs off failed pages for two and four seconds, preserving the attempt count", async () => {
  const { fixture: f, id } = await setup({ by: "page", param: "p", sizeParam: "s", size: 2 });
  const stamps: number[] = [];
  f.setBehaviour(async (_op, input) => {
    const { p } = z.object({ p: z.number() }).parse(input);
    if (p === 1) return { rows: [{ id: 0 }, { id: 1 }] };
    stamps.push(Date.now());
    throw connectionCallError("connection_unavailable");
  });
  expect(await finishDeferred(f, id)).toMatchObject({
    status: "failed",
    error: { code: "operation_page_failed" }
  });
  expect(stamps).toHaveLength(3);
  expect(required(stamps[1]) - required(stamps[0])).toBeGreaterThanOrEqual(2_000);
  expect(required(stamps[2]) - required(stamps[1])).toBeGreaterThanOrEqual(4_000);
});
it("fails immediately when a cursor repeats", async () => {
  const { fixture: f, id } = await setup({ by: "cursor", param: "c", cursor: "next" });
  let calls = 0;
  f.setBehaviour(async () => ({ rows: [{ id: ++calls }], next: "same" }));
  expect(await f.finish(id)).toMatchObject({
    status: "failed",
    error: { code: "paging_repeated_cursor" }
  });
  expect(calls).toBe(2);
});
it.each([false, true])(
  "fails fast when a cursor returns to one already read (A, B, A), deferred between pages: %s",
  async (deferred) => {
    // A low page limit lets a missed cycle end in dataset_limit instead of the test timeout.
    const { fixture: f, id } = await setup(
      { by: "cursor", param: "c", cursor: "next" },
      { pages: 10 }
    );
    const sent: unknown[] = [];
    let refused = false;
    f.setBehaviour(async (_op, input) => {
      const { c } = z.object({ c: z.string().optional() }).parse(input);
      sent.push(c);
      // A deferral re-enters the step, which must rebuild what it has seen from its checkpoints.
      if (c === "B" && deferred && !refused) {
        refused = true;
        throw connectionCallError("upstream_rate_limited", undefined, 0);
      }
      return { rows: [{ id: sent.length }], next: c === undefined ? "A" : c === "A" ? "B" : "A" };
    });
    expect(await f.finish(id)).toMatchObject({
      status: "failed",
      error: { code: "paging_repeated_cursor" }
    });
    expect(sent).toEqual(deferred ? [undefined, "A", "B", "B"] : [undefined, "A", "B"]);
  }
);
it.each(["disabled", "exposure"] as const)(
  "stops without retries when the Connection is %s",
  async (change) => {
    const paging = { by: "page", param: "p", sizeParam: "s", size: 2 } as const;
    const { fixture: f, id } = await setup(paging);
    let calls = 0;
    f.setBehaviour(async () => {
      calls++;
      await f.seed("crm", {
        ...(change === "disabled" ? { enabled: false } : {}),
        operations: [
          operationOf("echo", {
            exposure: change === "disabled" ? ["workflow"] : ["agent"],
            paging
          })
        ]
      });
      return { rows: [{ id: 0 }, { id: 1 }] };
    });
    expect(await f.finish(id)).toMatchObject({
      status: "failed",
      error: { code: change === "disabled" ? "CONFLICT" : "FORBIDDEN" }
    });
    expect(calls).toBe(1);
    const [run] = (await f.runs()).filter((run) => run.operation === "connection.crm.echo");
    if (change === "disabled") expect(run?.error?.reason).toBe("connection_disabled");
    else expect(run?.denial).toMatchObject({ action: "connection_exposure:workflow" });
    expect(run?.output?.value).toMatchObject({ pageAttempts: 0 });
  }
);
class InterruptedUpload extends MemoryObjectStorage {
  reached: () => void = () => undefined;
  release: (error: Error) => void = () => undefined;
  held = false;
  override async put(...args: Parameters<MemoryObjectStorage["put"]>) {
    if (!this.held && args[0].endsWith("00000002.jsonl.gz")) {
      this.held = true;
      this.reached();
      await new Promise<void>((_resolve, reject) => {
        this.release = reject;
      });
    }
    return super.put(...args);
  }
}
it.each(["page", "next_link"] as const)(
  "replaces a changed uncommitted %s page after a worker crash",
  async (by) => {
    const objects = new InterruptedUpload();
    const reached = new Promise<void>((resolve) => {
      objects.reached = resolve;
    });
    const { fixture: f, id } = await setup(
      by === "page"
        ? { by, param: "p", sizeParam: "s", size: 2 }
        : { by, param: "p", cursor: "next" },
      { objects }
    );
    let changed = false;
    f.setBehaviour(async (_op, input, context) => {
      const p =
        by === "page"
          ? z.object({ p: z.number() }).parse(input).p
          : context.pageAddress
            ? Number(context.pageAddress.split("=")[1])
            : 1;
      if (by === "next_link") {
        expect(context.previousPageAddress).toBe(
          p === 1 ? undefined : `https://pages.example/rest/nested/items?page=${p - 1}`
        );
        context.notePageAddress?.(`https://pages.example/rest/nested/items?page=${p}`);
      }
      if (p >= 5) return { rows: [], next: null };
      // Replacing this reservation must also release the old bytes from the usage counters.
      return {
        rows: p === 3 && changed ? [{ id: 35 }] : [{ id: p * 10 }, { id: p * 10 + 1 }],
        next: p === 3 && changed ? null : `?page=${p + 1}`
      };
    });
    const dead = f.worker();
    let arrived = false;
    const waiting = reached.then(() => {
      arrived = true;
    });
    for (let pass = 0; pass < 10 && !arrived; pass++) await Promise.race([dead.runDue(), waiting]);
    expect(arrived).toBe(true);
    changed = true;
    const stopping = dead.stop();
    objects.release(new Error("worker died"));
    await stopping;
    expect(await f.finish(id, f.worker())).toMatchObject({ status: "done" });
    const run = required(await f.stores.workflowRuns.readRun({ clientInstanceId, id }));
    const [record] = await f.stores.workflowRunDatasets.listForRun({
      clientInstanceId,
      runId: run.id,
      limit: 10
    });
    const dataset = required(record);
    expect(dataset.bytes).toBe(dataset.parts.reduce((bytes, part) => bytes + part.bytes, 0));
    expect(dataset.pendingPart).toBeUndefined();
    const datasets = createWorkflowDatasets({
      clientInstanceId,
      stores: f.stores,
      objects,
      limits: workflowsConfigSchema.parse({}).datasets
    });
    const reader = await datasets.reader({ id: dataset.id, runId: run.id });
    const ids: unknown[] = [];
    for await (const row of reader.rows) ids.push(row.id);
    expect(ids).toEqual([10, 11, 20, 21, 35]);
  }
);

it("the sweep cannot interrupt a checkpoint advanced while it was reading", async () => {
  let clock = Date.now();
  const now = () => new Date(clock);
  const { fixture: f, id } = await setup(
    { by: "page", param: "p", sizeParam: "s", size: 2 },
    { now }
  );
  const sweep = sweepOf(f, now);
  const runs = f.stores.operationRuns;
  const mark = runs.markInterrupted.bind(runs);
  let raced = false;
  runs.markInterrupted = async (input) => {
    raced = true;
    await runs.checkpointReading({
      ...input,
      pages: 0,
      rows: 0,
      bytes: 0,
      pageAttempts: 0,
      deadlineAt: new Date(clock + 60 * 60_000).toISOString(),
      recoverAfter: new Date(clock + 180_000).toISOString()
    });
    return mark(input);
  };
  f.setBehaviour(async () => {
    clock += 5 * 60_000;
    await sweep();
    expect(raced).toBe(true);
    expect((await f.runs()).find((run) => run.operation === "connection.crm.echo")?.status).toBe(
      "running"
    );
    return { rows: [{ id: 0 }] };
  });
  expect(await f.finish(id)).toMatchObject({ status: "done" });
});

it("the sweep honours a planned source deferral, then ends it if no checkpoint resumes", async () => {
  let clock = Date.now();
  const now = () => new Date(clock);
  const { fixture: f, id } = await setup(
    { by: "page", param: "p", sizeParam: "s", size: 2 },
    { now }
  );
  const sweep = sweepOf(f, now);
  f.setBehaviour(async (_op, input) => {
    const { p } = z.object({ p: z.number() }).parse(input);
    if (p === 1) return { rows: [{ id: 0 }, { id: 1 }] };
    throw connectionCallError("upstream_rate_limited", undefined, 600);
  });
  const worker = f.worker();
  await worker.runDue();
  await worker.runDue();
  expect(
    (await stepRunsOf(f, id)).find((step) => step.stepId === "rows")?.operationRunId
  ).toBeDefined();
  clock += 5 * 60_000;
  await sweep();
  expect((await f.runs()).find((run) => run.operation === "connection.crm.echo")?.status).toBe(
    "running"
  );
  clock += 9 * 60_000;
  await sweep();
  expect((await f.runs()).find((run) => run.operation === "connection.crm.echo")).toMatchObject({
    status: "failed",
    error: { code: "interrupted" }
  });
});

it("resuming a deferred page keeps the minute limit of the step's first execution", async () => {
  let clock = Date.now();
  const { fixture: f, id } = await setup(
    { by: "page", param: "p", sizeParam: "s", size: 2 },
    {
      now: () => new Date(clock),
      pagedStepMinutes: 1
    }
  );
  const calls: number[] = [];
  f.setBehaviour(async (_op, input) => {
    const { p } = z.object({ p: z.number() }).parse(input);
    calls.push(p);
    if (p === 1) return { rows: [{ id: 0 }, { id: 1 }] };
    if (calls.length === 2) throw connectionCallError("upstream_rate_limited", undefined, 0);
    return { rows: [] };
  });
  const worker = f.worker();
  await worker.runDue();
  await worker.runDue();
  expect(calls).toEqual([1, 2]);
  clock += 61_000;
  await sweepOf(f, () => new Date(clock))();
  expect(await f.finish(id, worker)).toMatchObject({
    status: "failed",
    error: { code: "dataset_limit", message: expect.stringContaining("pagedStepMinutes") }
  });
  expect(calls).toEqual([1, 2]);
});
