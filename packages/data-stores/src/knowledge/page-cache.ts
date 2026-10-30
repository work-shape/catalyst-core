import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import {
  AppError,
  auditActorFromIdentity,
  createPlatformId,
  defineJobHandler,
  defineJobKind,
  documentSourceErrorCodeOf,
  DocumentSourceError,
  KNOWLEDGE_FILE_MAX_BYTES,
  KNOWLEDGE_JOB_KINDS,
  KNOWLEDGE_PAGE_CACHE_LIFETIME_MS,
  KNOWLEDGE_SOURCE_UNREACHABLE,
  knowledgePageCachePrefix,
  ObjectNotFound,
  subjectDedupeKey,
  type AuditRecorder,
  type AuthenticatedIdentity,
  type BuiltinKnowledgeTarget,
  type KnowledgeDocumentStore,
  type KnowledgeFiles,
  type KnowledgePageCacheEntry,
  type PlatformStores
} from "@work-shape/catalyst-core";
import type { KnowledgeBaseDefinition } from "./definition";
import type { KnowledgePageSourcePort, KnowledgeRuntime } from "./runtime";

export type { KnowledgePageSourcePort };
import { sourceAuthority } from "./source-principal";
import { sourceSpool } from "./builtin/source-spool";

// The page cache of a Knowledge Base (KB-13b; spec: "Originals stay in the DMS", and its
// assumptions on retention, audit, authorization and region). Opening a cited page of a synced
// document whose original was released after extraction fetches the original through the
// source's Connection: as the Knowledge Base's ingestion principal, which needs `connection.use`
// before and after the call, through the Connection's shared binding. The caller has checked the
// reader's `knowledge_base.use`. The bytes are kept for 7 days from the fetch, within the
// Knowledge Base's `knowledge.pageCacheBytes`, and never served for a withdrawn document.

/** How long one fetch through the source may take, credentials and the whole stream included. */
const PAGE_FETCH_TIMEOUT_MS = 60_000;
/** How many expired entries one round of the expiry job deletes. */
const EXPIRE_BATCH = 200;

/** Who opens the page, for the audit event of a fetch. */
export interface KnowledgePageReader {
  actor: AuthenticatedIdentity;
  audit: AuditRecorder;
  correlationId: string;
}

const expireJob = defineJobKind({
  kind: KNOWLEDGE_JOB_KINDS.expirePageCache,
  payloadSchema: z.strictObject({ knowledgeBaseId: z.string(), knowledgeBase: z.string() }),
  maxAttempts: 5,
  backoff: { baseMs: 30_000, maxMs: 600_000 },
  leaseMs: 120_000,
  concurrency: { global: 2, perKey: 1 }
});

function unreachable(): AppError {
  return new AppError(
    "CONFLICT",
    "The source of this document cannot be reached right now.",
    { reason: KNOWLEDGE_SOURCE_UNREACHABLE },
    { exposeMessage: true }
  );
}

function unavailable(): AppError {
  return new AppError("NOT_FOUND", "The source document is no longer available.", undefined, {
    exposeMessage: true
  });
}

/** Deletes objects one by one; answers the keys whose object stayed. */
async function deleteObjects(files: KnowledgeFiles, keys: readonly string[]): Promise<string[]> {
  const stayed: string[] = [];
  for (const key of keys) {
    try {
      await files.objects.delete(key);
    } catch (error) {
      if (!(error instanceof ObjectNotFound)) stayed.push(key);
    }
  }
  return stayed;
}

async function readCached(files: KnowledgeFiles, objectKey: string) {
  try {
    return (await files.objects.get(objectKey)).body;
  } catch (error) {
    // An entry whose object is gone is a miss: the fetch replaces it.
    if (error instanceof ObjectNotFound) return undefined;
    throw error;
  }
}

/**
 * Opens a cited page of a synced document whose original was released: from the page cache
 * where it holds the document's current content, else fetched through the source into it.
 */
export async function openCachedPage(
  runtime: KnowledgeRuntime,
  files: KnowledgeFiles,
  input: {
    knowledgeBaseId: string;
    knowledgeBase: string;
    definition: KnowledgeBaseDefinition;
    store: KnowledgeDocumentStore;
    documentId: string;
    reader?: KnowledgePageReader;
  },
  signal?: AbortSignal
): Promise<AsyncIterable<Uint8Array>> {
  const { store, documentId } = input;
  const port = runtime.pageSource;
  const cache = store.pageCache;
  if (!port || !cache) throw unavailable();
  // A withdrawn or removed document reads nothing here, also from the cache.
  const found = await cache.read(documentId, signal);
  if (!found) throw unavailable();
  const item = found.source;
  // A source no longer published names no Connection to fetch through.
  const source = input.definition.sources?.find((candidate) => candidate.id === item.sourceId);
  if (!source) throw unavailable();
  if (found.cached) {
    const body = await readCached(files, found.cached.objectKey);
    if (body) return body;
  }

  const folderIds = source.folders;
  const started = Date.now();
  const audit = async (outcome: { bytes?: number; failure?: string }) => {
    if (!input.reader) return;
    await input.reader.audit.record({
      type: "knowledge_base.page_fetched",
      status: outcome.failure === undefined ? "success" : "failed",
      ...(outcome.failure === undefined ? {} : { reason: outcome.failure }),
      actor: auditActorFromIdentity(input.reader.actor),
      subject: input.knowledgeBaseId,
      correlationId: input.reader.correlationId,
      metadata: {
        knowledgeBase: input.knowledgeBase,
        documentId,
        source: source.id,
        durationMs: Date.now() - started,
        ...(outcome.bytes === undefined ? {} : { bytes: outcome.bytes }),
        ...(outcome.failure === undefined ? {} : { failure: outcome.failure })
      }
    });
  };

  const directory = await sourceSpool(runtime.clientInstanceId, input.knowledgeBaseId);
  const path = join(directory, "page");
  try {
    let size = 0;
    const hash = createHash("sha256");
    const deadline = AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS);
    const callSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      // The ingestion principal's own right on the Connection, read afresh before and after.
      const authority = await sourceAuthority(
        runtime.stores,
        runtime.clientInstanceId,
        input.knowledgeBaseId,
        source.connection
      );
      const { capability, context } = await port.openSource(source.connection, callSignal);
      await authority.require();
      async function* bytes() {
        for await (const chunk of capability.fetch(
          {
            itemId: item.itemId,
            version: item.version,
            maxBytes: KNOWLEDGE_FILE_MAX_BYTES,
            boundary: { folderIds }
          },
          context
        )) {
          callSignal.throwIfAborted();
          size += chunk.byteLength;
          if (size > KNOWLEDGE_FILE_MAX_BYTES)
            throw new DocumentSourceError("over_limit", "The source item exceeds the file limit");
          hash.update(chunk);
          yield chunk;
        }
      }
      await pipeline(bytes(), createWriteStream(path), { signal: callSignal });
      await authority.require();
    } catch (error) {
      // The reader went away: nothing was fetched for them, and nothing is said.
      if (signal?.aborted) throw error;
      const code = documentSourceErrorCodeOf(error);
      runtime.logger.info(
        { knowledgeBaseId: input.knowledgeBaseId, source: source.id, code },
        "A cited page could not be fetched from its source"
      );
      await audit({ failure: `source_${code}` });
      throw unreachable();
    }
    // Bytes other than the indexed content are not the page the passage cites.
    if (hash.digest("hex") !== found.source.contentSha256) {
      await audit({ bytes: size, failure: "source_changed" });
      throw unreachable();
    }
    const objectKey = `${knowledgePageCachePrefix(input.knowledgeBaseId, documentId)}${createPlatformId("kbpage")}`;
    await files.objects.put(objectKey, createReadStream(path), { size });
    let kept: Awaited<ReturnType<typeof cache.put>>;
    try {
      kept = await cache.put(
        {
          documentId,
          contentSha256: found.source.contentSha256,
          objectKey,
          byteSize: size,
          lifetimeMs: KNOWLEDGE_PAGE_CACHE_LIFETIME_MS,
          limitBytes: port.cacheBytes
        },
        (keys) => deleteObjects(files, keys),
        signal
      );
    } catch (error) {
      await deleteObjects(files, [objectKey]);
      throw error;
    }
    if (!kept.kept) {
      // Withdrawn while it was fetched: never served, and nothing of it stays.
      await deleteObjects(files, [objectKey]);
      throw unavailable();
    }
    await audit({ bytes: size });
    await runtime.stores.jobs.runAgainAfter(
      expireJob,
      { knowledgeBaseId: input.knowledgeBaseId, knowledgeBase: input.knowledgeBase },
      {
        clientInstanceId: runtime.clientInstanceId,
        subject: input.knowledgeBaseId,
        concurrencyKey: input.knowledgeBaseId,
        dedupeKey: subjectDedupeKey(expireJob.kind, input.knowledgeBaseId),
        runAfter: new Date(kept.expiresAt)
      }
    );
    const body = await readCached(files, objectKey);
    if (!body) throw unavailable();
    return body;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      runtime.logger.warn(
        { knowledgeBaseId: input.knowledgeBaseId },
        "Removing a page spool failed; the next source worker removes it"
      );
    });
  }
}

/**
 * Deletes the page cache of the named documents: their objects by prefix, including one a
 * killed open left without a row, then their rows. Answers the entries deleted and whether
 * every object went.
 */
export async function removeCachedPages(
  files: KnowledgeFiles,
  store: KnowledgeDocumentStore,
  knowledgeBaseId: string,
  documentIds: readonly string[],
  signal?: AbortSignal
): Promise<{ entries: number; objects: number; complete: boolean }> {
  if (!store.pageCache || !documentIds.length) return { entries: 0, objects: 0, complete: true };
  let objects = 0;
  const gone: string[] = [];
  for (const documentId of documentIds) {
    try {
      objects += (
        await files.objects.deletePrefix(knowledgePageCachePrefix(knowledgeBaseId, documentId))
      ).deleted;
      gone.push(documentId);
    } catch {
      // The row stays as the record of what is still there; the purge tries again.
    }
  }
  const entries = await store.pageCache.forgetDocuments(gone, signal);
  return { entries, objects, complete: gone.length === documentIds.length };
}

/** Deletes every object of a Knowledge Base's page cache: on its deletion, before its store goes. */
export async function removePageCache(
  files: KnowledgeFiles,
  knowledgeBaseId: string
): Promise<number> {
  return (await files.objects.deletePrefix(knowledgePageCachePrefix(knowledgeBaseId))).deleted;
}

/**
 * The job that deletes the entries of a Knowledge Base whose 7 days are over, queued for the
 * moment the earliest one expires, and again for the next after it ran.
 */
export function createPageCacheExpiryHandler(runtime: KnowledgeRuntime, files: KnowledgeFiles) {
  return defineJobHandler({
    kind: expireJob,
    slots: 1,
    async run(job, control) {
      const { knowledgeBaseId, knowledgeBase } = job.payload;
      const record = await runtime.stores.dataStores.getDataStore({
        clientInstanceId: runtime.clientInstanceId,
        id: knowledgeBaseId
      });
      // A deleted Knowledge Base's cache goes with its store and its prefix.
      if (!record || record.ownerKnowledgeBaseId === undefined || record.status !== "ready") return;
      const target: BuiltinKnowledgeTarget = {
        backend: "builtin",
        assetId: knowledgeBaseId,
        name: knowledgeBase,
        methods: []
      };
      const cache = runtime.backend.documentStore(target)?.pageCache;
      if (!cache) return;
      let stayed = 0;
      for (;;) {
        const expired = await cache.expired(EXPIRE_BATCH, control.signal);
        const keep = new Set(
          await deleteObjects(
            files,
            expired.map((entry) => entry.objectKey)
          )
        );
        const gone: KnowledgePageCacheEntry[] = expired.filter(
          (entry) => !keep.has(entry.objectKey)
        );
        await cache.forget(gone, control.signal);
        stayed += keep.size;
        if (expired.length < EXPIRE_BATCH || keep.size === expired.length) break;
      }
      if (stayed)
        throw new AppError(
          "CONFLICT",
          `${stayed} expired cited pages of Knowledge Base '${knowledgeBase}' could not be deleted; the job tries again.`
        );
      const next = await cache.nextExpiry(control.signal);
      if (next)
        await control.transaction((stores: PlatformStores) =>
          stores.jobs.runAgainAfter(expireJob, job.payload, {
            clientInstanceId: runtime.clientInstanceId,
            subject: knowledgeBaseId,
            concurrencyKey: knowledgeBaseId,
            dedupeKey: subjectDedupeKey(expireJob.kind, knowledgeBaseId),
            runAfter: new Date(next)
          })
        );
    }
  });
}

export const pageCacheExpiryJob = expireJob;
