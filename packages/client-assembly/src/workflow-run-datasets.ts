import { createWorkflowDatasets, WorkflowStepFailure } from "@work-shape/catalyst-workflows";
import { AppError, type ClientInstanceId, type PlatformStores } from "@work-shape/catalyst-core";
import type { WorkflowRunDatasetPort } from "@work-shape/catalyst-data-stores";

/**
 * The datasets of a Workflow run, as a Knowledge Base's `ingest` reads its items and writes its
 * failures (KBW-1): always as that run, so it reads only what the run may read. Dataset storage
 * starts with the process's files, so it is asked for on each call.
 */
export function workflowRunDatasetPort(
  parts: { clientInstanceId: ClientInstanceId; stores: PlatformStores },
  storage: () => ReturnType<typeof createWorkflowDatasets> | undefined
): WorkflowRunDatasetPort {
  const datasets = () => {
    const found = storage();
    if (!found) throw new AppError("CONFLICT", "Dataset storage is not available");
    return found;
  };
  const failure = (error: unknown): never => {
    if (error instanceof WorkflowStepFailure)
      throw new AppError(
        error.code === "FORBIDDEN"
          ? "FORBIDDEN"
          : error.code === "dataset_limit"
            ? "VALIDATION_FAILED"
            : "NOT_FOUND",
        error.message,
        { reason: error.code }
      );
    throw error;
  };
  return {
    async check({ workflowRunId, reference }) {
      await datasets()
        .reader({ id: reference.$dataset, reference, runId: workflowRunId, limit: 0 })
        .catch(failure);
    },
    async read({ workflowRunId, reference, offset, limit, signal }) {
      try {
        const reader = await datasets().reader({
          id: reference.$dataset,
          reference,
          runId: workflowRunId,
          offset,
          limit,
          ...(signal ? { signal } : {})
        });
        const rows = [];
        for await (const row of reader.rows) rows.push(row);
        return rows;
      } catch (error) {
        return failure(error);
      }
    },
    async write({ workflowRunId, stepRunId, field, rowSchema, rows, signal }) {
      const run = await parts.stores.workflowRuns.readRun({
        clientInstanceId: parts.clientInstanceId,
        id: workflowRunId
      });
      const stepRun = await parts.stores.workflowRuns.getStepRun({
        clientInstanceId: parts.clientInstanceId,
        id: stepRunId
      });
      if (!run || !stepRun || stepRun.runId !== run.id)
        throw new AppError("NOT_FOUND", "The Workflow step is not available");
      try {
        return await datasets().write({
          run,
          stepRun,
          field,
          rowSchema,
          rows,
          ...(signal ? { signal } : {})
        });
      } catch (error) {
        return failure(error);
      }
    }
  };
}
