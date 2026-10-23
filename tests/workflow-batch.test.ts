import { describe, expect, it } from "vitest";
import { z } from "zod";
import { operationBatchResultSchema } from "@work-shape/catalyst-core";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/access-instance";
import { start, stepRunsOf } from "./support/workflow-runs";
import { manifest, prepared, expectBatchViews } from "./support/workflow-batch";

describe("Workflow batch operations (WF 114)", () => {
  it.each([false, true])(
    "keeps 17 successful items and three failures without failing the step (inline=%s)",
    async (inline) => {
      const { t, datasets, seen } = await prepared(20, undefined, inline);
      const run = await t.finish((await start(t)).id);
      expect(run, JSON.stringify(run.error)).toMatchObject({ status: "done" });
      const record = await t.stores.workflowRuns.readRun({ clientInstanceId, id: run.id });
      if (!record) throw new Error("Missing run");
      const stored = await t.stores.workflowRuns.readRunOutput({ clientInstanceId, id: record.id });
      const output = z.object({ counts: operationBatchResultSchema }).parse(stored?.value);
      expect(output.counts).toMatchObject({ done: 17, failed: 3, failures: { rowCount: 3 } });
      const rows = [];
      for await (const row of (
        await datasets.reader({ id: output.counts.failures.$dataset, runId: run.id })
      ).rows)
        rows.push(row);
      expect(rows.map((row) => row.item)).toEqual(
        [1, 11, 19].map((index) => ({ index, valid: false }))
      );
      expect(rows.map((row) => row.message)).toEqual(Array(3).fill("valid: invalid_field"));
      expect(seen).toHaveLength(20);
      expect((await stepRunsOf(t, run.id)).find((step) => step.stepId === "process")?.status).toBe(
        "done"
      );
    }
  );

  it("rejects a batch result whose failure count disagrees with its dataset", async () => {
    const { t, definition } = await prepared(3);
    definition.execute = async () => ({
      done: 0,
      failed: 3,
      failures: { $dataset: "missing", rowCount: 2, bytes: 0 }
    });
    expect(await t.finish((await start(t)).id)).toMatchObject({
      status: "failed",
      error: { code: "batch_result_invalid" }
    });
  });

  it.each([
    [12, 5],
    [5, 1]
  ])("runs %i rows in views of %i without copying them", expectBatchViews, 300_000);

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
