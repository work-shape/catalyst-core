import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  operationBatchResultSchema,
  workflowDatasetReferenceSchema,
  type JsonObject,
  type OperationDefinition,
  type WorkflowDatasetReference
} from "@work-shape/catalyst-core";
import { workflowsConfigSchema } from "@work-shape/catalyst-config-schema";
import { createWorkflowDatasets, parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { publishedDefinitions, type WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows, start, stepRunsOf } from "./support/workflow-runs";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const BATCH = "fixture_batch.process";
const ROWS = "fixture_batch.rows";
const rowSchema: JsonObject = {
  type: "object",
  properties: { index: { type: "integer" }, valid: { type: "boolean" } },
  required: ["index", "valid"]
};
const failureSchema: JsonObject = {
  type: "object",
  properties: { item: rowSchema, code: { type: "string" }, message: { type: "string" } },
  required: ["item", "code", "message"]
};
const itemsSchema = z.union([z.array(z.json()), workflowDatasetReferenceSchema]);
function manifest(batch?: number, inline = false) {
  const base = notifyClients();
  const operation = (id: string, step: string, path = "") => ({
    id,
    name: id,
    type: "operation",
    operation: BATCH,
    input: { items: { ref: { step, path } } }
  });
  return {
    ...base,
    limits: { loopItems: batch === 1 ? 600 : 200 },
    steps: [
      base.steps[0],
      {
        ...base.steps[1],
        ...(inline ? {} : { operation: ROWS, input: {}, dataset: { at: "clients" } })
      },
      ...(batch === undefined
        ? [operation("process", "clients", "clients")]
        : [
            {
              id: "each",
              name: "Each batch",
              type: "loop",
              batch,
              concurrency: 8,
              items: { step: "clients", path: "clients" },
              steps: [operation("process", "each")]
            }
          ]),
      {
        id: "result",
        name: "Result",
        type: "output",
        input:
          batch === undefined
            ? {
                counts: { ref: { step: "process", path: "" } },
                source: { ref: { step: "clients", path: "clients" } }
              }
            : {
                counts: { ref: { step: "each", path: "" } },
                source: { ref: { step: "clients", path: "clients" } }
              }
      }
    ]
  };
}
async function prepared(count: number, batch?: number, inline = false) {
  const definitions = publishedDefinitions();
  definitions.publish(manifest(batch, inline));
  const objects = new MemoryObjectStorage();
  const t = await readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    {
      definitions: definitions.source,
      datasetObjects: objects
    }
  );
  const datasets = createWorkflowDatasets({
    clientInstanceId,
    stores: t.stores,
    objects,
    limits: workflowsConfigSchema.parse({}).datasets
  });
  const seen: number[] = [];
  const views: WorkflowDatasetReference[] = [];
  t.state.limits = { ...t.state.limits, resultMaxBytes: 2 * 1024 * 1024 };
  t.setBehaviour(() =>
    Promise.resolve({
      clients: Array.from({ length: count }, (_, index) => ({
        index,
        valid: ![1, 501, 999].includes(index)
      }))
    })
  );
  const definition: OperationDefinition = {
    name: BATCH,
    effect: "changing",
    changeClass: "reversible",
    auth: "principal",
    action: "connection.use",
    scope: null,
    timeoutMs: 120_000,
    batch: true,
    inputSchema: z.object({ items: itemsSchema }),
    outputSchema: operationBatchResultSchema,
    resource: () => undefined,
    async execute(input, context) {
      const parsed = z.object({ items: itemsSchema }).parse(input);
      if (context.origin.kind !== "workflow" || !context.origin.stepRunId)
        throw new Error("Workflow only");
      const run = await t.stores.workflowRuns.readRun({
        clientInstanceId,
        id: context.origin.workflowRunId
      });
      const stepRun = await t.stores.workflowRuns.getStepRun({
        clientInstanceId,
        id: context.origin.stepRunId
      });
      if (!run || !stepRun) throw new Error("Missing run");
      const source = parsed.items;
      if (!Array.isArray(source)) views.push(source);
      const rows = Array.isArray(source)
        ? (async function* () {
            yield* source;
          })()
        : (await datasets.reader({ id: source.$dataset, reference: source, runId: run.id })).rows;
      let done = 0,
        failed = 0;
      async function* failures() {
        for await (const value of rows) {
          const row = z.object({ index: z.number(), valid: z.boolean() }).parse(value);
          seen.push(row.index);
          if (row.valid) done++;
          else {
            failed++;
            yield { item: row, code: "invalid_field", message: "valid: invalid_field" };
          }
        }
      }
      const failuresRef = await datasets.write({
        run,
        stepRun,
        field: "failures",
        rowSchema: failureSchema,
        rows: failures()
      });
      return { done, failed, failures: { ...failuresRef } };
    }
  };
  const source: OperationDefinition = {
    name: ROWS,
    effect: "reading",
    auth: "principal",
    action: "connection.use",
    scope: null,
    timeoutMs: 120_000,
    streams: true,
    inputSchema: z.object({}),
    outputSchema: z.unknown(),
    outputJsonSchema: {
      type: "object",
      properties: { clients: { type: "array", items: rowSchema } }
    },
    resource: () => undefined,
    execute: async () => ({
      clients: (async function* () {
        for (let index = 0; index < count; index++)
          yield { index, valid: ![1, 501, 999].includes(index) };
      })()
    })
  };
  t.operationCalls.registry.addSource({
    resolve: async (name) => (name === BATCH ? definition : name === ROWS ? source : undefined),
    list: async () => ({ operations: [definition, source], truncated: [] })
  });
  t.state.centralSettings.push({ operation: BATCH, value: "allow" });
  return { t, datasets, objects, seen, views, definition };
}

describe("Workflow batch operations (WF 114)", () => {
  it.each([false, true])(
    "keeps 997 successful items and three failures without failing the step (inline=%s)",
    async (inline) => {
      const { t, datasets, seen } = await prepared(1000, undefined, inline);
      const run = await t.finish((await start(t)).id);
      expect(run, JSON.stringify(run.error)).toMatchObject({ status: "done" });
      const record = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
      if (!record) throw new Error("Missing run");
      const stored = await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: record.id });
      const output = z.object({ counts: operationBatchResultSchema }).parse(stored?.value);
      expect(output.counts).toMatchObject({ done: 997, failed: 3, failures: { rowCount: 3 } });
      const rows = [];
      for await (const row of (
        await datasets.reader({ id: output.counts.failures.$dataset, runId: run.id })
      ).rows)
        rows.push(row);
      expect(rows.map((row) => row.item)).toEqual(
        [1, 501, 999].map((index) => ({ index, valid: false }))
      );
      expect(rows.map((row) => row.message)).toEqual(Array(3).fill("valid: invalid_field"));
      expect(seen).toHaveLength(1000);
      expect((await stepRunsOf(t, run.id)).find((step) => step.stepId === "process")?.status).toBe(
        "done"
      );
    }
  );

  it("rejects a batch result whose failure count disagrees with its dataset", async () => {
    const { t, definition } = await prepared(1000);
    definition.execute = async () => ({
      done: 997,
      failed: 3,
      failures: { $dataset: "missing", rowCount: 2, bytes: 0 }
    });
    expect(await t.finish((await start(t)).id)).toMatchObject({
      status: "failed",
      error: { code: "batch_result_invalid" }
    });
  });

  it.each([
    [1200, 500],
    [600, 1],
    [100000, 500]
  ])(
    "runs %i rows in views of %i without copying them",
    async (count, batch) => {
      const { t, views, seen, datasets } = await prepared(count, batch);
      const started = performance.now();
      const run = await t.finish((await start(t)).id, undefined, count / batch + 50);
      const elapsedMs = performance.now() - started;
      expect(run, JSON.stringify(run.error)).toMatchObject({ status: "done" });
      expect(JSON.parse(run.outputPreview?.text ?? "null").counts).toEqual({
        total: Math.ceil(count / batch),
        done: Math.ceil(count / batch),
        failed: 0
      });
      const sorted = [...views].sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
      expect(sorted.map((ref) => ref.rowCount)).toEqual(
        Array.from({ length: Math.ceil(count / batch) }, (_, index) =>
          Math.min(batch, count - index * batch)
        )
      );
      expect(new Set(views.map((ref) => ref.$dataset)).size).toBe(1);
      expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: count }, (_, i) => i));
      const storedRun = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
      if (!storedRun) throw new Error("Missing run");
      const records = await t.stores.workflowRunDatasets.listForRun({
        clientInstanceId,
        runId: storedRun.id,
        limit: 1000
      });
      expect(records.filter((row) => row.field === "clients")).toHaveLength(1);
      expect(records.filter((row) => row.field !== "failures")).toHaveLength(1);
      // Range checks apply before iteration, including to empty or hostile ranges.
      const parent = views[0];
      if (!parent) throw new Error("Missing parent view");
      await expect(
        datasets.reader({
          id: parent.$dataset,
          runId: run.id,
          reference: { ...parent, offset: count, rowCount: 1 }
        })
      ).rejects.toMatchObject({ code: "dataset_reference_invalid" });
      console.info(
        JSON.stringify({
          measurement: "EW-BATCH",
          rows: count,
          batch,
          iterations: views.length,
          stepRuns: run.stepRunCount,
          elapsedMs: Math.round(elapsedMs),
          datasets: records.length
        })
      );
    },
    120_000
  );

  it.each([0, -1, 1.5, "500"])("refuses malformed batch size %s", (batch) => {
    const value = manifest(500);
    expect(
      parseWorkflowManifest({
        ...value,
        steps: value.steps.map((step) => (step && "batch" in step ? { ...step, batch } : step))
      }).ok
    ).toBe(false);
  });
  it("refuses a batched inline loop instead of silently treating rows as batches", async () => {
    const { t } = await prepared(3, 2, true);
    expect(await t.finish((await start(t)).id)).toMatchObject({
      status: "failed",
      error: { code: "batch_requires_dataset" }
    });
  });
});
