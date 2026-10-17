import { z } from "zod";
import {
  defineJobHandler,
  defineJobKind,
  type BuiltinKnowledgeTarget,
  type JobRetry,
  type KnowledgeFiles,
  type KnowledgeBackend,
  type ManagedFileId,
  type ManagedFileOwner,
  type OwnedManagedFile,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import type { KnowledgeRuntime } from "./runtime";

// What a call of `knowledge.<id>.add_files` leaves behind when it does not add its files. Each
// copy is a Managed File the Knowledge Base owns with an object of its own; it holds a document
// only once the document's row is in the Knowledge Base's store.
//
// Which side wins is decided by state, not by time, and only the deletion of an object cannot
// be taken back. A removal goes in two steps:
//   1. It marks the copies deleted. The mark is a candidate flag, committed on its own.
//   2. It waits for the lock that writing documents takes and reads which candidates a document
//      names. A named one is marked available again and keeps its bytes; only the objects of
//      the rest are deleted.
// A write reads, under that lock, whether each copy it names is still available, and refuses
// with `knowledge_files_released` where one is marked. The read in step 2 starts after the mark
// committed and after every write that held the lock then has ended; a write that takes the
// lock later finds the mark. So what step 2 reads is final: no document ever names a copy whose
// object it deletes, however long either side stalls and in whichever order the two databases
// commit. A document can meet its copy marked deleted for a moment, between the steps, and
// finds it available again after step 2; a removal cut short between the steps leaves its marks
// to the job, which does step 2 for every marked copy of its window.
//
// The call removes what it copied when it is refused or fails. A process that ends in the
// middle of the call cannot, so every call first queues a job that looks again after the call's
// timeout: it removes every copy made in the call's window that no document names. The timeout
// decides only when the job looks; a call that is still running when it does loses its copies
// and is refused, and never ends with a document whose bytes are gone.
//
// An object is never shared: every copy has its own key, so removing one copy cannot take bytes
// another copy, or a Conversation's file, still holds. Two documents of the same bytes keep two
// objects; extraction still runs once per content (`catalyst_kb.contents`). Removing the
// objects of a deleted Knowledge Base is its retirement's (`removal.ts`).

/** The kind of the job that removes the copies a call of `add_files` left without documents. */
const KNOWLEDGE_FILE_CLEANUP_JOB_KIND = "knowledge_base.clean_files";

/** How long one call of `add_files` may take; when its job looks is built on it. */
export const KNOWLEDGE_ADD_FILES_TIMEOUT_MS = 300_000;

/** What the clocks of the process and of the database may differ by. */
const CLOCK_MARGIN_MS = 60_000;

/** How many copies one pass looks at; a job looks until a pass finds fewer. */
const CLEANUP_BATCH = 100;

const cleanupPayloadSchema = z.object({
  /** The id of the Knowledge Base's asset, which owns the copies and its store. */
  knowledgeBaseId: z.string().min(1).max(200),
  /** The Knowledge Base's id, for the messages of its store. */
  knowledgeBase: z.string().min(1).max(200),
  /** The window in which the call made its copies. */
  createdAfter: z.iso.datetime(),
  createdBefore: z.iso.datetime()
});
type CleanupPayload = z.infer<typeof cleanupPayloadSchema>;

const cleanupJob = defineJobKind({
  kind: KNOWLEDGE_FILE_CLEANUP_JOB_KIND,
  payloadSchema: cleanupPayloadSchema,
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 10 * 60_000 },
  leaseMs: 2 * 60_000,
  concurrency: { global: 2, perKey: 1 }
});

const ownerOf = (knowledgeBaseId: string): ManagedFileOwner => ({
  kind: "knowledge_base",
  id: knowledgeBaseId
});

/**
 * Queues the job that removes what this call may leave behind. The window holds every copy the
 * call makes within its timeout; the job looks once that timeout has passed for every call that
 * could have made a copy in the window.
 */
export async function enqueueKnowledgeFileCleanup(
  runtime: Pick<KnowledgeRuntime, "clientInstanceId" | "stores" | "now">,
  target: BuiltinKnowledgeTarget
): Promise<void> {
  const now = runtime.now().getTime();
  const createdBefore = now + KNOWLEDGE_ADD_FILES_TIMEOUT_MS + CLOCK_MARGIN_MS;
  await runtime.stores.jobs.enqueue(
    cleanupJob,
    {
      knowledgeBaseId: target.assetId,
      knowledgeBase: target.name,
      createdAfter: new Date(now - CLOCK_MARGIN_MS).toISOString(),
      createdBefore: new Date(createdBefore).toISOString()
    },
    {
      clientInstanceId: runtime.clientInstanceId,
      subject: target.assetId,
      runAfter: new Date(createdBefore + KNOWLEDGE_ADD_FILES_TIMEOUT_MS + CLOCK_MARGIN_MS),
      concurrencyKey: target.assetId
    }
  );
}

/**
 * Removes those of `copies` no document of the Knowledge Base names, in the two steps above,
 * and returns how many objects it deleted. A store it cannot read throws before any object is
 * deleted; the marks it made wait for the job.
 */
export async function removeUnusedKnowledgeCopies(
  runtime: Pick<KnowledgeRuntime, "clientInstanceId" | "stores" | "now"> & {
    backend: Pick<KnowledgeBackend, "documentFileIds">;
  },
  files: KnowledgeFiles,
  target: BuiltinKnowledgeTarget,
  copies: readonly OwnedManagedFile[],
  signal?: AbortSignal
): Promise<number> {
  if (copies.length === 0) return 0;
  const owner = ownerOf(target.assetId);
  // Step 1. A copy a document already names is left as it is.
  const live = copies.filter((copy) => !copy.deleted).map((copy) => copy.id);
  const namedBefore = new Set(await runtime.backend.documentFileIds(target, live, signal));
  const marked = live.filter((id) => !namedBefore.has(id));
  await runtime.stores.files.markOwnedManagedFilesDeleted({
    clientInstanceId: runtime.clientInstanceId,
    owner,
    fileIds: marked,
    deletedAt: runtime.now().toISOString()
  });
  // Step 2, for what this call marked and what was marked before.
  const markedIds = new Set<string>(marked);
  const candidates = copies.filter((copy) => copy.deleted || markedIds.has(copy.id));
  const named = new Set(
    await runtime.backend.documentFileIds(
      target,
      candidates.map((copy) => copy.id),
      signal
    )
  );
  await runtime.stores.files.restoreOwnedManagedFiles({
    clientInstanceId: runtime.clientInstanceId,
    owner,
    fileIds: candidates.filter((copy) => named.has(copy.id)).map((copy) => copy.id)
  });
  const unused = candidates.filter((copy) => !named.has(copy.id));
  for (const copy of unused) await files.objects.delete(copy.objectKey);
  // With its object gone the row goes too: no file name or checksum of a removed copy stays.
  await runtime.stores.files.deleteOwnedManagedFiles({
    clientInstanceId: runtime.clientInstanceId,
    owner,
    fileIds: unused.map((copy) => copy.id)
  });
  return unused.length;
}

async function cleanUp(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  payload: CleanupPayload,
  signal: AbortSignal
): Promise<void> {
  const target: BuiltinKnowledgeTarget = {
    backend: "builtin",
    assetId: payload.knowledgeBaseId,
    name: payload.knowledgeBase,
    methods: []
  };
  let afterFileId: ManagedFileId | undefined;
  for (;;) {
    const copies = await runtime.stores.files.listOwnedManagedFiles({
      clientInstanceId: runtime.clientInstanceId,
      owner: ownerOf(payload.knowledgeBaseId),
      createdAfter: payload.createdAfter,
      createdBefore: payload.createdBefore,
      ...(afterFileId ? { afterFileId } : {}),
      limit: CLEANUP_BATCH
    });
    await removeUnusedKnowledgeCopies(runtime, files, target, copies, signal);
    afterFileId = copies.at(-1)?.id;
    if (copies.length < CLEANUP_BATCH) return;
  }
}

/** The handler and the manual retry of the job, where the process keeps files. */
export function createKnowledgeFileCleanupJobs(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles | undefined
): { handlers: RegisteredJobHandler[]; retries: JobRetry[] } {
  if (!files) return { handlers: [], retries: [] };
  return {
    handlers: [
      defineJobHandler({
        kind: cleanupJob,
        slots: 1,
        run: (job, control) => cleanUp(runtime, files, job.payload, control.signal)
      })
    ],
    retries: [{ kind: cleanupJob }]
  };
}
