import {
  isOperationRunId,
  createPlatformId,
  knowledgeSyncJob,
  knowledgeSourceKey,
  subjectDedupeKey,
  type KnowledgeSyncJobPayload,
  type KnowledgeSyncResult,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../../runtime";

export async function enqueueSourceSync(
  stores: PlatformStores,
  runtime: Pick<DataStoreRuntime, "clientInstanceId">,
  payload: KnowledgeSyncJobPayload
) {
  await stores.jobs.enqueue(knowledgeSyncJob, payload, {
    clientInstanceId: runtime.clientInstanceId,
    subject: payload.knowledgeBaseId,
    concurrencyKey: knowledgeSourceKey(payload.knowledgeBaseId, payload.sourceId),
    dedupeKey: subjectDedupeKey(knowledgeSyncJob.kind, payload.syncRunId)
  });
}

export async function sourceSyncStarted(
  stores: PlatformStores,
  runtime: Pick<DataStoreRuntime, "clientInstanceId">,
  payload: KnowledgeSyncJobPayload
) {
  await stores.audit.appendAuditEvent({
    clientInstanceId: runtime.clientInstanceId,
    type: "knowledge_base.sync_started",
    status: "success",
    subject: payload.knowledgeBaseId,
    correlationId: payload.operationRunId,
    metadata: {
      source: payload.sourceId,
      syncRunId: payload.syncRunId,
      counts: { discovered: 0, added: 0, changed: 0, moved: 0, withdrawn: 0, failed: 0, skipped: 0 }
    }
  });
}

/** Finishing the Operation Run is the once-only gate for the minimized completion event. */
export async function settleSourceSync(
  stores: PlatformStores,
  runtime: Pick<DataStoreRuntime, "clientInstanceId">,
  payload: KnowledgeSyncJobPayload,
  result: KnowledgeSyncResult,
  finished: boolean
) {
  if (result.state === "running") return;
  if (!isOperationRunId(payload.operationRunId)) return;
  await stores.operationRuns.finish({
    clientInstanceId: runtime.clientInstanceId,
    id: payload.operationRunId,
    end:
      result.state === "failed"
        ? {
            status: "failed",
            finishedAt: result.endedAt ?? new Date().toISOString(),
            error: {
              code: result.failureCode ?? "knowledge_source_unreachable",
              message: "The Knowledge Base source sync failed"
            }
          }
        : {
            status: "done",
            finishedAt: result.endedAt ?? new Date().toISOString(),
            output: { value: { ...result } }
          }
  });
  if (finished)
    await stores.audit.appendAuditEvent({
      clientInstanceId: runtime.clientInstanceId,
      type: "knowledge_base.sync_finished",
      status: result.state === "failed" ? "failed" : "success",
      subject: payload.knowledgeBaseId,
      correlationId: payload.operationRunId,
      metadata: { ...result }
    });
}

export function initialSyncIds(knowledgeBaseId: string, sourceId: string) {
  return {
    knowledgeBaseId,
    sourceId,
    syncRunId: createPlatformId("kbsync"),
    operationRunId: createPlatformId<"OperationRunId">("oprun")
  };
}
