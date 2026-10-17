import { z } from "zod";
import {
  defineJobHandler,
  defineJobKind,
  KNOWLEDGE_JOB_KINDS,
  knowledgeIndexJob,
  knowledgeContentJobPayloadSchema,
  knowledgeExtractionKey,
  ObjectNotFound,
  type KnowledgeContentJobPayload,
  type KnowledgeDocumentStore,
  type KnowledgeFiles,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { KnowledgeRuntime } from "./runtime";

// Bounds file locks and deletes per job. Large shared contents are walked by file id.
const RELEASE_BATCH = 100;
const releaseOriginalsJob = defineJobKind({
  ...knowledgeIndexJob,
  kind: KNOWLEDGE_JOB_KINDS.releaseOriginals,
  payloadSchema: knowledgeContentJobPayloadSchema.extend({
    fileIds: z.array(z.string().min(1)).min(1).max(RELEASE_BATCH).optional()
  })
});
const deleteOriginalsJob = defineJobKind({
  ...knowledgeIndexJob,
  kind: KNOWLEDGE_JOB_KINDS.deleteOriginals,
  payloadSchema: z.strictObject({
    knowledgeBaseId: z.string().min(1),
    fileIds: z.array(z.string().min(1)).min(1).max(RELEASE_BATCH)
  })
});

/** Marking and queuing deletion commit together, after terminal content commits. Readers see
 * the source notice immediately. A killed worker leaves both bytes and the job that deletes
 * them. Released files are skipped here: only their durable deletion job ever repeats I/O. */
export async function releaseSyncedOriginals(
  runtime: KnowledgeRuntime,
  payload: KnowledgeContentJobPayload & { fileIds?: string[] },
  store: KnowledgeDocumentStore,
  signal?: AbortSignal
): Promise<void> {
  let afterFileId: string | undefined;
  const pending: string[] = [];
  do {
    signal?.throwIfAborted();
    afterFileId = await store.releaseOriginalPage(
      {
        contentSha256: payload.contentSha256,
        ...(payload.fileIds ? { fileIds: payload.fileIds } : {}),
        limit: RELEASE_BATCH,
        ...(afterFileId ? { afterFileId } : {})
      },
      async (fileIds) => {
        const owner = { kind: "knowledge_base", id: payload.knowledgeBaseId } as const;
        const copies = await runtime.stores.files.listOwnedManagedFilesById({
          clientInstanceId: runtime.clientInstanceId,
          owner,
          fileIds
        });
        pending.push(
          ...copies.filter((copy) => copy.status === "available").map((copy) => copy.id)
        );
        // Available copies can be sparse among already released documents. Collect a full
        // batch across pages instead of creating one deletion job for every sparse page.
        while (
          pending.length >= RELEASE_BATCH ||
          (fileIds.length < RELEASE_BATCH && pending.length)
        ) {
          const batch = pending.splice(0, RELEASE_BATCH);
          await runtime.stores.transaction(async (stores) => {
            const held = (
              await stores.files.listOwnedManagedFilesById({
                clientInstanceId: runtime.clientInstanceId,
                owner,
                fileIds: batch,
                lock: true
              })
            ).filter((copy) => copy.status === "available");
            if (!held.length) return;
            await stores.files.markOwnedManagedFilesReleased({
              clientInstanceId: runtime.clientInstanceId,
              owner,
              fileIds: held.map((copy) => copy.id)
            });
            await stores.jobs.enqueue(
              deleteOriginalsJob,
              { knowledgeBaseId: payload.knowledgeBaseId, fileIds: held.map((copy) => copy.id) },
              {
                clientInstanceId: runtime.clientInstanceId,
                subject: payload.knowledgeBaseId,
                concurrencyKey: payload.knowledgeBaseId
              }
            );
          });
        }
      },
      signal
    );
  } while (afterFileId !== undefined);
}

/** Exhausted index settlement already holds a platform connection. Queue a separate pass
 * there; it acquires owned-store locks after settlement commits. */
export async function enqueueOriginalRelease(
  stores: PlatformStores,
  clientInstanceId: KnowledgeRuntime["clientInstanceId"],
  payload: KnowledgeContentJobPayload & { fileIds?: string[] }
) {
  const groups = payload.fileIds
    ? Array.from({ length: Math.ceil(payload.fileIds.length / RELEASE_BATCH) }, (_, index) =>
        payload.fileIds?.slice(index * RELEASE_BATCH, (index + 1) * RELEASE_BATCH)
      )
    : [undefined];
  for (const fileIds of groups) {
    await stores.jobs.enqueue(
      releaseOriginalsJob,
      { ...payload, ...(fileIds ? { fileIds } : {}) },
      {
        clientInstanceId,
        subject: payload.knowledgeBaseId,
        concurrencyKey: payload.knowledgeBaseId
      }
    );
  }
}

/** Metadata only: never fetch the original or load the retained text to decide release. */
export async function hasStoredKnowledgeExtraction(
  files: KnowledgeFiles,
  payload: Pick<KnowledgeContentJobPayload, "knowledgeBaseId" | "contentSha256">
): Promise<boolean> {
  try {
    await files.objects.head(
      knowledgeExtractionKey(payload.knowledgeBaseId, payload.contentSha256)
    );
    return true;
  } catch (error) {
    if (error instanceof ObjectNotFound) return false;
    throw error;
  }
}

export function createOriginalReleaseJobs(runtime: KnowledgeRuntime, files: KnowledgeFiles) {
  return {
    handlers: [
      defineJobHandler({
        kind: releaseOriginalsJob,
        slots: 1,
        async run(job, control) {
          const store = runtime.backend.documentStore({
            backend: "builtin",
            assetId: job.payload.knowledgeBaseId,
            name: job.payload.knowledgeBaseId,
            methods: []
          });
          if (!store) return;
          const content = await store.readContent(job.payload.contentSha256, control.signal);
          // A synced copy may join TXT first indexed from an upload. Its index handoff
          // persists the text before release; a finished content alone is not enough.
          if (
            content?.state === "extracted" &&
            !(await hasStoredKnowledgeExtraction(files, job.payload))
          )
            return;
          await releaseSyncedOriginals(runtime, job.payload, store, control.signal);
        }
      }),
      defineJobHandler({
        kind: deleteOriginalsJob,
        slots: 1,
        async run(job, control) {
          // Removal may already have deleted the row and its bytes; it uses the same unique key.
          const copies = await runtime.stores.files.listOwnedManagedFilesById({
            clientInstanceId: runtime.clientInstanceId,
            owner: { kind: "knowledge_base", id: job.payload.knowledgeBaseId },
            fileIds: job.payload.fileIds
          });
          for (const copy of copies) {
            control.signal.throwIfAborted();
            if (copy.status === "released") await files.objects.delete(copy.objectKey);
          }
        }
      })
    ],
    retries: [{ kind: releaseOriginalsJob }, { kind: deleteOriginalsJob }]
  };
}
