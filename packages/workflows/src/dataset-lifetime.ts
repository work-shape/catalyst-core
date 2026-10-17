import {
  defineJobKind,
  defineJobHandler,
  WORKFLOW_RUN_JOB_KINDS,
  type ClientInstanceId,
  type ObjectStorage,
  type PlatformStores,
  type WorkflowRun
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { datasetPrefix } from "./datasets";
import { datasetReferences } from "./dataset-schema";
import { principalActor } from "./run-identity";

// Resume and default output retention, bounded by the release's step-data retention.
const DATASET_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
// Each cleanup transaction touches a small page; a daily scan also recovers orphaned jobs.
const DATASET_CLEANUP_BATCH = 100;
const workflowDeleteDatasetsJobKind = defineJobKind({
  kind: WORKFLOW_RUN_JOB_KINDS.deleteDatasets,
  payloadSchema: z.object({}),
  maxAttempts: 3,
  backoff: { baseMs: 1000, maxMs: 60_000 },
  leaseMs: 120_000,
  heartbeatMs: 20_000,
  concurrency: { global: 1 },
  manualRetry: false
});

export async function enqueueDatasetCleanup(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  at: string
) {
  await stores.jobs.enqueue(
    workflowDeleteDatasetsJobKind,
    {},
    { clientInstanceId, dedupeKey: `datasets:${clientInstanceId}:${at}` }
  );
}

export function createDatasetLifetime(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  objects?: ObjectStorage;
  stepDataDays: number;
  now(): Date;
}) {
  const { clientInstanceId, stores, objects, now } = options;
  async function end(
    tx: PlatformStores,
    run: WorkflowRun,
    output: import("@work-shape/catalyst-core").JsonValue | undefined
  ) {
    const definition = await tx.workflowRuns.readRunDefinition({ clientInstanceId, id: run.id });
    const ids = output === undefined ? [] : datasetReferences(output).map((ref) => ref.$dataset);
    const days = Math.min(
      options.stepDataDays,
      run.status === "failed" || run.status === "limit_reached"
        ? DATASET_RETENTION_DAYS
        : (definition?.retention?.datasets ?? DATASET_RETENTION_DAYS)
    );
    if (run.parentRunId && run.status === "done")
      for (const id of ids)
        if (await tx.workflowRunDatasets.canRead({ clientInstanceId, id, runId: run.id }))
          await tx.workflowRunDatasets.allowRun({ clientInstanceId, id, runId: run.parentRunId });
    await tx.workflowRunDatasets.finishRun({
      clientInstanceId,
      runId: run.id,
      keep: run.parentRunId ? [] : ids,
      expiresAt: new Date(now().getTime() + days * DAY_MS).toISOString(),
      resume: run.status === "failed" || run.status === "limit_reached",
      test: run.mode === "test"
    });
    await enqueueDatasetCleanup(tx, clientInstanceId, now().toISOString());
  }
  async function prune(signal?: AbortSignal) {
    if (!objects) return;
    for (;;) {
      signal?.throwIfAborted();
      const rows = await stores.workflowRunDatasets.claimExpired({
        clientInstanceId,
        now: now().toISOString(),
        limit: DATASET_CLEANUP_BATCH
      });
      if (!rows.length) return;
      for (const row of rows) {
        signal?.throwIfAborted();
        await objects.deletePrefix(datasetPrefix(row));
        await stores.transaction(async (tx) => {
          const current = await tx.workflowRunDatasets.get({ clientInstanceId, id: row.id });
          if (current?.cleanedAt) return;
          await tx.workflowRunDatasets.markCleaned({
            clientInstanceId,
            id: row.id,
            at: now().toISOString()
          });
          const run = await tx.workflowRuns.readRun({ clientInstanceId, id: row.runId });
          await tx.audit.appendAuditEvent({
            clientInstanceId,
            type: "workflow_run.dataset_deleted",
            status: "success",
            subject: row.id,
            correlationId: run?.correlationId ?? row.runId,
            ...(run ? { actor: principalActor(run) } : {}),
            metadata: {
              runId: row.runId,
              stepRunId: row.stepRunId,
              datasetId: row.id,
              rowCount: row.rowCount,
              bytes: row.bytes
            }
          });
        });
      }
    }
  }
  const handler = defineJobHandler({
    kind: workflowDeleteDatasetsJobKind,
    slots: 1,
    run: (_job, control) => prune(control.signal)
  });
  return {
    end,
    prune,
    handlers: [handler]
  };
}
