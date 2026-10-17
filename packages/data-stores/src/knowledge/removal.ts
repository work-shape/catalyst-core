import { z } from "zod";
import {
  auditActorFromIdentity,
  defineJobHandler,
  defineJobKind,
  KNOWLEDGE_BASE_ACTIONS,
  KNOWLEDGE_OPERATION_PREFIX,
  knowledgeExtractionKey,
  ObjectNotFound,
  type AuditRecorder,
  type BuiltinKnowledgeTarget,
  type KnowledgeDocumentStore,
  type KnowledgeFiles,
  type OperationDefinition,
  type OperationResource,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { enqueueStoreDrop } from "../jobs";
import type { KnowledgeRuntime } from "./runtime";

/** Bounds a user's removal batch; split larger removals into calls. */
const REMOVE_MAX = 100;
/** A removal includes one store write and enqueue, not the actual object deletion. */
const REMOVE_TIMEOUT_MS = 60_000;
/** Files left by interrupted adds are cleaned in bounded pages on retirement. */
const FILE_BATCH = 100;
const inputSchema = z.strictObject({
  documentIds: z.array(z.string().min(1).max(200)).min(1).max(REMOVE_MAX)
});
export const KNOWLEDGE_REMOVE_DOCUMENTS_JOB_KIND = "knowledge_base.remove_documents";

const removalJob = defineJobKind({
  kind: KNOWLEDGE_REMOVE_DOCUMENTS_JOB_KIND,
  payloadSchema: z.strictObject({
    knowledgeBaseId: z.string(),
    knowledgeBase: z.string(),
    documentIds: z.array(z.string()).optional()
  }),
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 600_000 },
  leaseMs: 120_000,
  concurrency: { global: 2, perKey: 1 }
});

/** An omitted document list means retirement; queued in the asset deletion transaction. */
export async function enqueueKnowledgeRemoval(
  stores: Pick<PlatformStores, "jobs">,
  runtime: KnowledgeRuntime,
  target: BuiltinKnowledgeTarget,
  documentIds?: readonly string[]
): Promise<void> {
  await stores.jobs.enqueue(
    removalJob,
    {
      knowledgeBaseId: target.assetId,
      knowledgeBase: target.name,
      ...(documentIds === undefined ? {} : { documentIds: [...documentIds] })
    },
    {
      clientInstanceId: runtime.clientInstanceId,
      subject: target.assetId,
      concurrencyKey: target.assetId
    }
  );
}

export function removeDocumentsOperation(
  runtime: KnowledgeRuntime,
  knowledgeBase: {
    name: string;
    assetId: string;
    resource: OperationResource;
    store: KnowledgeDocumentStore;
  }
): OperationDefinition {
  const target: BuiltinKnowledgeTarget = {
    backend: "builtin",
    name: knowledgeBase.name,
    assetId: knowledgeBase.assetId,
    methods: []
  };
  return {
    name: `${KNOWLEDGE_OPERATION_PREFIX}${knowledgeBase.name}.remove_documents`,
    effect: "changing",
    changeClass: "irreversible",
    action: KNOWLEDGE_BASE_ACTIONS.write,
    scope: "data_store_rows:write",
    auth: "principal",
    module: "knowledge",
    timeoutMs: REMOVE_TIMEOUT_MS,
    inputSchema,
    outputSchema: z.object({ removed: z.number().int() }),
    resource: () => knowledgeBase.resource,
    async execute(input, context) {
      const documentIds = [...new Set(inputSchema.parse(input).documentIds)];
      const removed = await knowledgeBase.store.withdrawDocuments(
        documentIds,
        () => enqueueKnowledgeRemoval(runtime.stores, runtime, target, documentIds),
        context.runtime.signal
      );
      await context.audit.record({
        type: "knowledge_base.documents_removed",
        status: "success",
        actor: auditActorFromIdentity(context.actor),
        subject: target.assetId,
        correlationId: context.correlationId,
        metadata: { documentIds, documents: removed }
      });
      return { removed };
    }
  };
}

export function createKnowledgeRemovalJobs(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles | undefined,
  audit: AuditRecorder
) {
  if (!files) return { handlers: [], retries: [] };
  return {
    handlers: [
      defineJobHandler({
        kind: removalJob,
        slots: 1,
        async run(job, control) {
          const payload = job.payload;
          const record = await control.transaction((stores) =>
            stores.dataStores.getDataStore({
              clientInstanceId: runtime.clientInstanceId,
              id: payload.knowledgeBaseId
            })
          );
          if (!record || record.ownerKnowledgeBaseId === undefined) return;
          const retiring = payload.documentIds === undefined;
          // A retirement job must never purge a live store, including one revived under this id.
          if (retiring && record.status !== "retired") return;
          const target: BuiltinKnowledgeTarget = {
            backend: "builtin",
            assetId: record.id,
            name: payload.knowledgeBase,
            methods: []
          };
          const store = runtime.backend.documentStore(target);
          if (!store) return;
          let counts = {
            documents: 0,
            chunks: 0,
            contents: 0,
            files: 0,
            objects: 0,
            extractionResults: 0
          };
          const owner = { kind: "knowledge_base" as const, id: record.id };
          const deleteFiles = async (stores: PlatformStores, fileIds: string[]) => {
            const copies = await stores.files.listOwnedManagedFilesById({
              clientInstanceId: runtime.clientInstanceId,
              owner,
              fileIds
            });
            // This row lock also fences the final extraction write in the worker. Bytes are
            // deleted before the transaction commits the marks; an interrupted attempt repeats.
            await stores.files.markOwnedManagedFilesDeleted({
              clientInstanceId: runtime.clientInstanceId,
              owner,
              fileIds: copies.map((copy) => copy.id),
              deletedAt: runtime.now().toISOString()
            });
            for (const copy of copies) await files.objects.delete(copy.objectKey);
            counts.files += fileIds.length;
            counts.objects += copies.length;
          };
          if (record.level > 0) {
            await store.purgeDocuments(
              payload.documentIds === undefined ? {} : { documentIds: payload.documentIds },
              (plan) =>
                control.transaction(async (stores) => {
                  counts = {
                    ...counts,
                    documents: plan.documents,
                    chunks: plan.chunks,
                    contents: plan.contentSha256s.length
                  };
                  await deleteFiles(stores, plan.fileIds);
                  for (const sha256 of plan.contentSha256s) {
                    const key = knowledgeExtractionKey(record.id, sha256);
                    try {
                      await files.objects.head(key);
                      counts.extractionResults += 1;
                      counts.objects += 1;
                    } catch (error) {
                      if (!(error instanceof ObjectNotFound)) throw error;
                    }
                    await files.objects.delete(key);
                  }
                }),
              control.signal
            );
          }
          if (retiring) {
            // Include copies an interrupted add left without a document. A late add cannot adopt
            // them: retirement refuses the store, and the add's copy check sees the deletion mark.
            let afterFileId;
            for (;;) {
              const copies = await runtime.stores.files.listOwnedManagedFiles({
                clientInstanceId: runtime.clientInstanceId,
                owner,
                createdAfter: "0001-01-01T00:00:00.000Z",
                createdBefore: "9999-01-01T00:00:00.000Z",
                ...(afterFileId ? { afterFileId } : {}),
                limit: FILE_BATCH
              });
              await control.transaction(async (stores) => {
                await deleteFiles(
                  stores,
                  copies.filter((copy) => !copy.deleted).map((copy) => copy.id)
                );
                // A previous cleanup may have marked an unclaimed copy before its object delete.
                for (const copy of copies.filter((copy) => copy.deleted))
                  await files.objects.delete(copy.objectKey);
              });
              afterFileId = copies.at(-1)?.id;
              if (copies.length < FILE_BATCH) break;
            }
          }
          await audit.record({
            type: retiring ? "knowledge_base.deleted" : "knowledge_base.documents_purged",
            status: "success",
            subject: record.id,
            correlationId: job.correlationId,
            metadata: counts
          });
          if (retiring) await control.transaction((stores) => enqueueStoreDrop(stores, record));
        }
      })
    ],
    retries: [{ kind: removalJob }]
  };
}
