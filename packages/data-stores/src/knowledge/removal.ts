import { z } from "zod";
import {
  AppError,
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
  type KnowledgePurgeCursor,
  type ManagedFileId,
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
/**
 * How many documents one page of a purge takes. A page makes at most three object calls per
 * document (the copy, then the head and delete of an unshared extraction result), so it stays
 * well inside the store transaction's timeout, and commits on its own.
 */
const PURGE_PAGE = 100;
/** The code of a purge that kept something, on the store of a deleted Knowledge Base too. */
const PURGE_INCOMPLETE = "knowledge_purge_incomplete";
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

/** What a purge deleted, as its audit event counts it. */
interface PurgeCounts {
  documents: number;
  chunks: number;
  contents: number;
  files: number;
  objects: number;
  extractionResults: number;
}

/** Deletes an object; one that is already gone counts as deleted. */
async function deleteObject(files: KnowledgeFiles, key: string): Promise<void> {
  try {
    await files.objects.delete(key);
  } catch (error) {
    if (!(error instanceof ObjectNotFound)) throw error;
  }
}

async function objectExists(files: KnowledgeFiles, key: string): Promise<boolean> {
  try {
    await files.objects.head(key);
    return true;
  } catch (error) {
    if (error instanceof ObjectNotFound) return false;
    throw error;
  }
}

/**
 * Deletes the objects of `copies` one by one and answers which went and which stayed. A copy
 * whose object cannot be deleted stays, as the record a later attempt finds, and holds up no
 * other.
 */
async function deleteCopyObjects(
  files: KnowledgeFiles,
  copies: readonly { id: ManagedFileId; objectKey: string }[]
): Promise<{ gone: ManagedFileId[]; kept: ManagedFileId[] }> {
  const gone: ManagedFileId[] = [];
  const kept: ManagedFileId[] = [];
  for (const copy of copies) {
    try {
      await deleteObject(files, copy.objectKey);
      gone.push(copy.id);
    } catch {
      kept.push(copy.id);
    }
  }
  return { gone, kept };
}

// Purging a Knowledge Base's documents, and on its deletion every document, file and object it
// has. The purge goes in pages of `PURGE_PAGE` documents, each committed on its own, so what
// is deleted stays deleted when an attempt fails, and the next attempt continues where it
// stopped. An object that cannot be deleted keeps the rows that lead to it, is counted, and
// holds up no other; the attempt then ends failed with `knowledge_purge_incomplete` and the
// executor tries again, until it gives up and an operator retries the job. The store of a
// deleted Knowledge Base is dropped only after a purge that kept nothing.
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
          const counts: PurgeCounts = {
            documents: 0,
            chunks: 0,
            contents: 0,
            files: 0,
            objects: 0,
            extractionResults: 0
          };
          let kept = 0;
          const owner = { kind: "knowledge_base" as const, id: record.id };
          const deleteCopies = async (
            read: (stores: PlatformStores) => Promise<{ id: ManagedFileId; objectKey: string }[]>
          ) => {
            const result = await control.transaction(async (stores) => {
              const copies = await read(stores);
              const objects = await deleteCopyObjects(files, copies);
              await stores.files.deleteOwnedManagedFiles({
                clientInstanceId: runtime.clientInstanceId,
                owner,
                fileIds: objects.gone
              });
              return objects;
            });
            // Committed: the rows and their objects are gone, whatever the page does next.
            counts.files += result.gone.length;
            counts.objects += result.gone.length;
            kept += result.kept.length;
            return result.kept;
          };
          const remove = {
            files: (fileIds: string[]) =>
              deleteCopies((stores) =>
                // The row locks fence the final extraction write in the worker: one that holds
                // a row ends before its bytes go, and one that comes later finds no copy.
                stores.files.listOwnedManagedFilesById({
                  clientInstanceId: runtime.clientInstanceId,
                  owner,
                  fileIds,
                  lock: true
                })
              ),
            // After the copies of every holder are gone, so no extraction writes a result again.
            async extractions(contentSha256s: string[]) {
              const failed: string[] = [];
              for (const sha256 of contentSha256s) {
                const key = knowledgeExtractionKey(record.id, sha256);
                try {
                  const existed = await objectExists(files, key);
                  await deleteObject(files, key);
                  if (existed) {
                    counts.extractionResults += 1;
                    counts.objects += 1;
                  }
                } catch {
                  failed.push(sha256);
                }
              }
              kept += failed.length;
              return failed;
            }
          };
          const purge = async () => {
            if (record.level === 0) return;
            let after: KnowledgePurgeCursor | undefined;
            do {
              const page = await store.purgeDocumentPage(
                {
                  ...(payload.documentIds === undefined
                    ? {}
                    : { documentIds: payload.documentIds }),
                  ...(after ? { after } : {}),
                  limit: PURGE_PAGE
                },
                remove,
                control.signal
              );
              counts.documents += page.documents;
              counts.chunks += page.chunks;
              counts.contents += page.contents;
              after = page.next;
            } while (after);
          };
          const sweep = async () => {
            // Include copies an interrupted add left without a document. A late add cannot adopt
            // them: retirement refuses the store, and the add's copy check finds no copy.
            let afterFileId: ManagedFileId | undefined;
            for (;;) {
              const copies = await runtime.stores.files.listOwnedManagedFiles({
                clientInstanceId: runtime.clientInstanceId,
                owner,
                createdAfter: "0001-01-01T00:00:00.000Z",
                createdBefore: "9999-01-01T00:00:00.000Z",
                ...(afterFileId ? { afterFileId } : {}),
                limit: FILE_BATCH
              });
              await deleteCopies(() => Promise.resolve(copies));
              afterFileId = copies.at(-1)?.id;
              if (copies.length < FILE_BATCH) return;
            }
          };
          let failure: unknown;
          try {
            await purge();
            if (retiring) await sweep();
          } catch (error) {
            failure = error;
          }
          const type = retiring ? "knowledge_base.deleted" : "knowledge_base.documents_purged";
          if (failure === undefined && kept === 0) {
            await audit.record({
              type,
              status: "success",
              subject: record.id,
              correlationId: job.correlationId,
              metadata: { ...counts }
            });
            if (retiring) await control.transaction((stores) => enqueueStoreDrop(stores, record));
            return;
          }
          const message =
            failure === undefined
              ? `${kept} objects of Knowledge Base '${payload.knowledgeBase}' could not be deleted, and the rows that lead to them stay. The removal tries again; once it has given up, an operator retries its job.`
              : `The removal of documents of Knowledge Base '${payload.knowledgeBase}' stopped. Its next attempt continues where it stopped.`;
          if (retiring && !control.signal.aborted) {
            // The deleted Knowledge Base's store says why it is still there.
            await control.transaction(async (stores) => {
              const current = await stores.dataStores.getDataStore({
                clientInstanceId: runtime.clientInstanceId,
                id: record.id,
                lock: true
              });
              if (current?.status !== "retired") return;
              await stores.dataStores.putDataStore({
                ...current,
                failure: { code: PURGE_INCOMPLETE, message },
                updatedAt: runtime.now().toISOString()
              });
            });
          }
          // What this attempt deleted is audited, so the events of all attempts add up.
          await audit.record({
            type,
            status: "failed",
            reason: PURGE_INCOMPLETE,
            subject: record.id,
            correlationId: job.correlationId,
            metadata: { ...counts }
          });
          if (failure !== undefined) throw failure;
          throw new AppError("CONFLICT", message, { reason: PURGE_INCOMPLETE });
        }
      })
    ],
    retries: [{ kind: removalJob }]
  };
}
