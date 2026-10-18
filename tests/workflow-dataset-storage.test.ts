import { afterEach, describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  createActorAccess,
  type WorkflowStepRun
} from "@work-shape/catalyst-core";
import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import { createWorkflowDatasets, enqueueDatasetCleanup } from "@work-shape/catalyst-workflows";
import { withTestSql } from "./support/test-sql";
import { deferred } from "./support/assertions";
import { clientInstanceId } from "./support/access-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { readyWorkflows, start } from "./support/workflow-runs";
import type { WorkflowFixture } from "./support/workflow-instance";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const rowSchema = {
  type: "object",
  properties: { index: { type: "integer" }, text: { type: "string" } },
  required: ["index", "text"]
};
const limits = workflowsConfigSchema.parse({}).datasets;
async function prepared() {
  const objects = new MemoryObjectStorage();
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { datasetObjects: objects }
  );
  const started = await start(t);
  const run = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
  if (!run) throw new Error("Missing persisted run");
  const [step] = await t.stores.workflowRuns.listStepRuns({ clientInstanceId, runId: run.id });
  if (!step) throw new Error("Missing persisted run");
  await t.stores.workflowRuns.markStepRunRunning({
    clientInstanceId,
    id: step.id,
    attempt: 1,
    startedAt: new Date().toISOString()
  });
  return {
    t,
    objects,
    run,
    step,
    datasets: createWorkflowDatasets({ clientInstanceId, stores: t.stores, objects, limits })
  };
}
async function* rows(count = 3, length = 10) {
  for (let index = 0; index < count; index++) yield { index, text: "x".repeat(length) };
}
async function complete(t: WorkflowFixture, step: WorkflowStepRun) {
  await t.stores.transaction(async (tx) => {
    await tx.workflowRuns.endStepRun({
      clientInstanceId,
      id: step.id,
      status: "done",
      finishedAt: new Date().toISOString()
    });
    await tx.workflowRunDatasets.completeStep({ clientInstanceId, stepRunId: step.id });
  });
}
async function readAll(reader: { rows: AsyncIterable<unknown> }) {
  const result: unknown[] = [];
  for await (const row of reader.rows) result.push(row);
  return result;
}

describe("dataset persistence on real Postgres", () => {
  it("exposes no incomplete data; requires row rights or a run's explicit handoff; tombstones revoke readers", async () => {
    const { t, objects, run, step, datasets } = await prepared();
    const ref = await datasets.write({
      run,
      stepRun: step,
      field: "rows",
      rowSchema,
      rows: rows()
    });
    await expect(datasets.reader({ id: ref.$dataset, runId: run.id })).rejects.toMatchObject({
      code: "dataset_expired"
    });
    await complete(t, step);
    const reader = await datasets.reader({ id: ref.$dataset, runId: run.id });
    expect(await readAll(reader)).toHaveLength(3);
    const foreign = await start(t);
    const foreignRun = await t.stores.workflowRuns.readRun({ clientInstanceId, id: foreign.id });
    if (!foreignRun) throw new Error("Missing foreign run");
    await expect(datasets.reader({ id: ref.$dataset, runId: foreignRun.id })).rejects.toMatchObject(
      { code: "FORBIDDEN" }
    );
    const access = createActorAccess(
      { kind: "user", id: t.kai.id, clientInstanceId, roles: ["user"], permissionRefs: [] },
      { holderActive: true, grants: [] }
    );
    await expect(datasets.reader({ id: ref.$dataset, access })).rejects.toMatchObject({
      code: "FORBIDDEN"
    });
    expect(
      await t.stores.workflowRunDatasets.get({
        clientInstanceId: asClientInstanceId("another-instance"),
        id: ref.$dataset
      })
    ).toBeUndefined();
    await t.stores.workflowRunDatasets.allowRun({
      clientInstanceId,
      id: ref.$dataset,
      runId: foreignRun.id
    });
    expect(
      await readAll(await datasets.reader({ id: ref.$dataset, runId: foreignRun.id }))
    ).toHaveLength(3);
    const held = await datasets.reader({ id: ref.$dataset, runId: run.id });
    await t.stores.workflowRunDatasets.claimRun({ clientInstanceId, runId: run.id });
    await expect(readAll(held)).rejects.toMatchObject({ code: "dataset_expired" });
    const record = await t.stores.workflowRunDatasets.get({ clientInstanceId, id: ref.$dataset });
    if (!record) throw new Error("Missing tombstone");
    await objects.deletePrefix(`workflow-runs/${run.id}/${record.id}/`);
    expect(objects.size).toBe(0);
  });

  it("resumes after a worker dies between parts with every row exactly once", async () => {
    const { t, objects, run, step, datasets } = await prepared();
    const put = objects.put.bind(objects);
    let calls = 0;
    objects.put = async (...args) => {
      calls++;
      if (calls === 2) throw new Error("worker stopped");
      await put(...args);
    };
    await expect(
      datasets.write({ run, stepRun: step, field: "rows", rowSchema, rows: rows(9000, 1024) })
    ).rejects.toThrow("worker stopped");
    const [checkpoint] = await t.stores.workflowRunDatasets.listForRun({
      clientInstanceId,
      runId: run.id,
      limit: 10
    });
    expect(checkpoint?.parts).toHaveLength(1);
    objects.put = put;
    const ref = await datasets.write({
      run,
      stepRun: step,
      field: "rows",
      rowSchema,
      rows: rows(9000, 1024)
    });
    await complete(t, step);
    let count = 0;
    for await (const row of (await datasets.reader({ id: ref.$dataset, runId: run.id })).rows) {
      expect(row.index).toBe(count);
      count++;
    }
    expect(count).toBe(9000);
    expect(ref.rowCount).toBe(9000);
  });

  it("reserves the instance's last bytes once under concurrent writers", async () => {
    const { t, objects, run, step } = await prepared();
    const restricted = createWorkflowDatasets({
      clientInstanceId,
      stores: t.stores,
      objects,
      limits: { ...limits, instanceBytes: 100 }
    });
    const other = await start(t);
    const otherRun = await t.stores.workflowRuns.readRun({ clientInstanceId, id: other.id });
    if (!otherRun) throw new Error("Missing second run");
    const [otherStep] = await t.stores.workflowRuns.listStepRuns({
      clientInstanceId,
      runId: otherRun.id
    });
    if (!otherStep) throw new Error("Missing second step");
    await t.stores.workflowRuns.markStepRunRunning({
      clientInstanceId,
      id: otherStep.id,
      attempt: 1,
      startedAt: new Date().toISOString()
    });
    const results = await Promise.allSettled([
      restricted.write({ run, stepRun: step, field: "a", rowSchema, rows: rows(1, 40) }),
      restricted.write({
        run: otherRun,
        stepRun: otherStep,
        field: "b",
        rowSchema,
        rows: rows(1, 40)
      })
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const failure = results.find((result) => result.status === "rejected");
    expect(failure?.status === "rejected" ? failure.reason : null).toMatchObject({
      code: "dataset_limit",
      message: expect.stringContaining("instanceBytes")
    });
  });

  it("bounds rows and bytes without exposing content; a missing backup part is expired", async () => {
    const { t, objects, run, step } = await prepared();
    const restricted = createWorkflowDatasets({
      clientInstanceId,
      stores: t.stores,
      objects,
      limits: { ...limits, rows: 2, rowBytes: 100, bytes: 1000 }
    });
    await expect(
      restricted.write({ run, stepRun: step, field: "too-many", rowSchema, rows: rows(3) })
    ).rejects.toMatchObject({ code: "dataset_limit", message: expect.stringContaining("rows") });
    await expect(
      restricted.write({ run, stepRun: step, field: "too-wide", rowSchema, rows: rows(1, 101) })
    ).rejects.toMatchObject({
      code: "dataset_limit",
      message: expect.stringContaining("rowBytes")
    });
    async function* invalid() {
      yield { index: "PRIVATE_VALUE", text: "private" };
    }
    await expect(
      restricted.write({ run, stepRun: step, field: "invalid", rowSchema, rows: invalid() })
    ).rejects.toMatchObject({
      code: "dataset_row_invalid",
      message: "Dataset line 1 does not fit its row schema at field 1"
    });
    // A row's keys may be data too: the error names the place of a field, never its key.
    const open = {
      type: "object",
      additionalProperties: { type: "array", items: { type: "integer" } }
    };
    async function* dynamic() {
      yield { counts: [1, 2], EW14A_PRIVATE_KEY_47f9c: [3, "PRIVATE_VALUE"] };
    }
    const dynamicError = await restricted
      .write({ run, stepRun: step, field: "dynamic", rowSchema: open, rows: dynamic() })
      .then(
        () => undefined,
        (error: unknown) => error
      );
    expect(dynamicError).toMatchObject({
      code: "dataset_row_invalid",
      message: "Dataset line 1 does not fit its row schema at field 2, item 2"
    });
    expect(JSON.stringify(dynamicError)).not.toMatch(/EW14A_PRIVATE_KEY|PRIVATE_VALUE/u);
    expect(String(dynamicError)).not.toMatch(/EW14A_PRIVATE_KEY|PRIVATE_VALUE/u);
    const ref = await restricted.write({
      run,
      stepRun: step,
      field: "valid",
      rowSchema,
      rows: rows(1)
    });
    await complete(t, step);
    const [key] = objects.keys();
    if (!key) throw new Error("No dataset part");
    await objects.delete(key);
    await expect(
      readAll(await restricted.reader({ id: ref.$dataset, runId: run.id }))
    ).rejects.toMatchObject({ code: "dataset_expired" });
  });
  it("keeps a parent's handoff while its reader is open, then expires it with that reader", async () => {
    const { t, run, step, datasets } = await prepared();
    const ref = await datasets.write({
      run,
      stepRun: step,
      field: "handoff",
      rowSchema,
      rows: rows()
    });
    await complete(t, step);
    const other = await start(t);
    const child = await t.stores.workflowRuns.readRun({ clientInstanceId, id: other.id });
    if (!child) throw new Error("Missing reader run");
    await t.stores.workflowRunDatasets.allowRun({
      clientInstanceId,
      id: ref.$dataset,
      runId: child.id
    });
    const past = new Date(Date.now() - 1000).toISOString();
    await t.stores.workflowRunDatasets.finishRun({
      clientInstanceId,
      runId: run.id,
      keep: [],
      expiresAt: past,
      resume: false,
      test: false
    });
    expect(
      await t.stores.workflowRunDatasets.claimExpired({
        clientInstanceId,
        now: new Date().toISOString(),
        limit: 10
      })
    ).toEqual([]);
    expect(
      await readAll(await datasets.reader({ id: ref.$dataset, runId: child.id }))
    ).toHaveLength(3);
    await t.stores.workflowRunDatasets.finishRun({
      clientInstanceId,
      runId: child.id,
      keep: [],
      expiresAt: past,
      resume: false,
      test: false
    });
    expect(
      await t.stores.workflowRunDatasets.claimExpired({
        clientInstanceId,
        now: new Date().toISOString(),
        limit: 10
      })
    ).toHaveLength(1);
    await expect(datasets.reader({ id: ref.$dataset, runId: run.id })).rejects.toMatchObject({
      code: "dataset_expired"
    });
  });

  it("serializes a step's upload with cancellation and leaves no late object after cleanup", async () => {
    const { t, objects, run, step, datasets } = await prepared();
    const entered = deferred<void>(),
      release = deferred<void>();
    const put = objects.put.bind(objects);
    objects.put = async (...args) => {
      entered.resolve();
      await release.promise;
      await put(...args);
    };
    const writing = datasets.write({ run, stepRun: step, field: "race", rowSchema, rows: rows() });
    try {
      await entered.promise;
      const cancelling = t.expectOk(t.root.id, "workflows.cancel_run", {
        params: { runId: run.id }
      });
      release.resolve();
      await Promise.all([writing, cancelling]);
      const [record] = await t.stores.workflowRunDatasets.listForRun({
        clientInstanceId,
        runId: run.id,
        limit: 10
      });
      if (!record) throw new Error("Missing dataset");
      await expect(datasets.reader({ id: record.id, runId: run.id })).rejects.toMatchObject({
        code: "dataset_expired"
      });
      await t.worker().runDue();
      expect(objects.size).toBe(0);
    } finally {
      release.resolve();
      await writing.catch(() => undefined);
    }
  });
});

it("maps a changed pending part after an interrupted upload to dataset_retry_changed", async () => {
  const { objects, run, step, datasets } = await prepared();
  const put = objects.put.bind(objects);
  objects.put = async () => {
    throw new Error("worker stopped before upload");
  };
  await expect(
    datasets.write({ run, stepRun: step, field: "retry", rowSchema, rows: rows(1, 10) })
  ).rejects.toThrow("worker stopped before upload");
  objects.put = put;
  await expect(
    datasets.write({ run, stepRun: step, field: "retry", rowSchema, rows: rows(1, 11) })
  ).rejects.toMatchObject({ code: "dataset_retry_changed" });
});

it("stores row counts beyond int32 without imposing a customer row ceiling", async () => {
  const { t, run, step } = await prepared();
  const record = await t.stores.workflowRunDatasets.create({
    clientInstanceId,
    id: "large-count",
    runId: run.id,
    stepRunId: step.id,
    field: "rows",
    rowSchema
  });
  await t.stores.workflowRunDatasets.reservePart({
    clientInstanceId,
    id: record.id,
    index: 0,
    part: { key: "synthetic", hash: "synthetic", rows: 3_000_000_000, bytes: 1 },
    limits: { ...limits, rows: 4_000_000_000 }
  });
  await t.stores.workflowRunDatasets.commitPart({ clientInstanceId, id: record.id, index: 0 });
  expect(await t.stores.workflowRunDatasets.get({ clientInstanceId, id: record.id })).toMatchObject(
    { rowCount: 3_000_000_000 }
  );
});

it.each(["dataset", "run", "workflow"])(
  "removes counters and reader holds on %s cleanup",
  async (cleanup) => {
    const { t, objects, run, step, datasets } = await prepared();
    const ref = await datasets.write({
      run,
      stepRun: step,
      field: "cleanup",
      rowSchema,
      rows: rows()
    });
    await complete(t, step);
    const reader = await start(t);
    const readerRun = await t.stores.workflowRuns.readRun({ clientInstanceId, id: reader.id });
    if (!readerRun) throw new Error("Missing reader run");
    await t.stores.workflowRunDatasets.allowRun({
      clientInstanceId,
      id: ref.$dataset,
      runId: readerRun.id
    });
    if (cleanup === "dataset") {
      for (const runId of [run.id, readerRun.id])
        await t.stores.workflowRunDatasets.finishRun({
          clientInstanceId,
          runId,
          keep: [],
          expiresAt: new Date(0).toISOString(),
          resume: false,
          test: false
        });
      await t.stores.workflowRunDatasets.claimExpired({
        clientInstanceId,
        now: new Date().toISOString(),
        limit: 10
      });
    } else if (cleanup === "run") {
      // A cleaned reader run must release datasets it does not own as well.
      await t.stores.workflowRunDatasets.claimRun({ clientInstanceId, runId: readerRun.id });
      await withTestSql(async (sql) => {
        expect(
          await sql`select * from workflow_dataset_readers where run_id = ${readerRun.id}`
        ).toHaveLength(0);
      });
      await t.stores.workflowRunDatasets.claimRun({ clientInstanceId, runId: run.id });
    } else {
      await t.stores.workflowRunDatasets.claimWorkflow({
        clientInstanceId,
        workflow: run.workflow
      });
      await withTestSql(async (sql) => {
        expect(
          await sql`select * from workflow_dataset_readers where run_id = ${readerRun.id}`
        ).toHaveLength(0);
      });
    }
    await enqueueDatasetCleanup(t.stores, clientInstanceId, new Date().toISOString());
    await t.worker().runDue();
    expect(objects.size).toBe(0);
    expect(
      await t.stores.workflowRunDatasets.get({ clientInstanceId, id: ref.$dataset })
    ).toMatchObject({ state: "deleted", cleanedAt: expect.any(String) });
    await withTestSql(async (sql) => {
      expect(
        await sql`select * from workflow_dataset_usage where scope = ${`run:${run.id}`}`
      ).toHaveLength(0);
      expect(
        await sql`select * from workflow_dataset_readers where dataset_id = ${ref.$dataset}`
      ).toHaveLength(0);
    });
  }
);

it.each([1, 50])(
  "replacing an uncommitted page charges only its new bytes (row length %s)",
  async (length) => {
    const { objects, run, step, datasets } = await prepared();
    const put = objects.put.bind(objects);
    objects.put = async () => {
      throw new Error("worker stopped before upload");
    };
    const page = { pages: 1, next: { page: 2 }, done: false };
    await expect(
      datasets.write({ run, stepRun: step, field: "page", rowSchema, rows: rows(1, 10), page })
    ).rejects.toThrow("worker stopped before upload");
    objects.put = put;
    const ref = await datasets.write({
      run,
      stepRun: step,
      field: "page",
      rowSchema,
      rows: rows(1, length),
      page
    });
    const record = await datasets.writing(step, "page");
    expect(record?.pendingPart).toBeUndefined();
    expect(record?.parts).toHaveLength(1);
    const expectedBytes = Buffer.byteLength(
      JSON.stringify({ index: 0, text: "x".repeat(length) }) + "\n"
    );
    expect(ref.bytes).toBe(expectedBytes);
    expect(record?.bytes).toBe(expectedBytes);
    await withTestSql(async (sql) => {
      const counters =
        await sql`select bytes from workflow_dataset_usage where client_instance_id = ${clientInstanceId} and scope in ('instance', ${`run:${run.id}`})`;
      expect(counters).toHaveLength(2);
      expect(counters.map((row) => Number(row.bytes))).toEqual([expectedBytes, expectedBytes]);
    });
  }
);
