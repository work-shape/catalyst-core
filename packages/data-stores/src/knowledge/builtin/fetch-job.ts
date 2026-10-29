import { sourceBoundaryKey } from "../source-boundary";
import { sourceAuthority, type SourceAuthority } from "../source-principal";
import { enqueueOriginalRelease, hasStoredKnowledgeExtraction } from "../original-release";
import { removeAbandonedSourceSpools, sourceSpool } from "./source-spool";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  createPlatformId,
  defineJobHandler,
  DocumentSourceError,
  documentSourceErrorCodeOf,
  enqueueKnowledgeIndex,
  KNOWLEDGE_FETCH_MAX_ATTEMPTS,
  KNOWLEDGE_FETCH_WINDOW_BYTES,
  KNOWLEDGE_FETCH_WINDOW_ITEMS,
  KNOWLEDGE_FETCH_WINDOW_WAIT_MS,
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeFetchJob,
  knowledgeSourceKey,
  knowledgeIndexPayloadOfFetch,
  type JobControl,
  type KnowledgeDocumentFailureCode,
  type KnowledgeFetchJobPayload,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import { enqueueKnowledgeFileCleanup, removeUnusedKnowledgeCopies } from "../file-cleanup";
import { knowledgeDocumentFileIds } from "./documents";
import {
  createSourceStore,
  sourceTransaction,
  sourceFormat,
  type SourceItem
} from "./source-store";
import { sourceTarget, sourceCall, type SourceJobRuntime } from "./source-runtime";

// Match the executor's item backoff without spending job attempts for a failed neighbour.
const FETCH_BACKOFF_BASE_MS = knowledgeFetchJob.backoff.baseMs;
// A source that rate-limits without naming a time waits a minute; its items spend no attempt.
const SOURCE_RATE_LIMIT_WAIT_MS = 60_000;
// Bounds the copy window that the existing file-cleanup job protects after a killed worker.
const FETCH_BATCH_TIMEOUT_MS = 240_000;
// Items fetched, then adopted together: one transaction and one document lock for the group.
const FETCH_GROUP_ITEMS = 25;

/**
 * How many of `items`, in order, the fetch window still has room for (KB-ISO-3b), with `held`
 * in it now.
 */
function roomFor(
  items: readonly Pick<SourceItem, "size">[],
  held: { items: number; bytes: number },
  window: { items: number; bytes: number }
): number {
  let count = 0;
  let bytes = held.bytes;
  for (const item of items) {
    if (held.items + count >= window.items || bytes + item.size > window.bytes) break;
    bytes += item.size;
    count++;
  }
  return count;
}

async function queueAgain(
  runtime: SourceJobRuntime,
  control: JobControl,
  payload: KnowledgeFetchJobPayload,
  ids: string[],
  waitMs: number,
  waitsForWindow = false
) {
  if (!ids.length) return;
  const { waitsForWindow: _waited, ...ordinary } = payload;
  await control.transaction((stores) =>
    stores.jobs.enqueue(
      knowledgeFetchJob,
      {
        ...ordinary,
        sourceItemIds: ids,
        ...(waitsForWindow ? { waitsForWindow: true as const } : {})
      },
      {
        clientInstanceId: runtime.data.clientInstanceId,
        subject: payload.knowledgeBaseId,
        concurrencyKey: knowledgeSourceKey(payload.knowledgeBaseId, payload.sourceId),
        runAfter: new Date(Date.now() + waitMs)
      }
    )
  );
}
/**
 * Whether a fetched item's content still needs an index job: not when it failed, and not when
 * it is indexed and its extracted text is kept.
 */
async function needsIndex(
  runtime: SourceJobRuntime,
  knowledgeBaseId: string,
  content: { state: string; contentSha256: string },
  retained: Set<string>
) {
  if (content.state === "failed") return false;
  if (content.state !== "extracted") return true;
  if (retained.has(content.contentSha256)) return false;
  if (
    await hasStoredKnowledgeExtraction(runtime.input.files, {
      knowledgeBaseId,
      contentSha256: content.contentSha256
    })
  ) {
    retained.add(content.contentSha256);
    return false;
  }
  return true;
}

export async function releaseCopy(
  runtime: SourceJobRuntime,
  payload: Pick<KnowledgeFetchJobPayload, "knowledgeBaseId">,
  fileId: string
) {
  const target = {
    backend: "builtin" as const,
    assetId: payload.knowledgeBaseId,
    name: payload.knowledgeBaseId,
    methods: []
  };
  const copies = await runtime.data.stores.files.listOwnedManagedFilesById({
    clientInstanceId: runtime.data.clientInstanceId,
    owner: { kind: "knowledge_base", id: payload.knowledgeBaseId },
    fileIds: [fileId]
  });
  await removeUnusedKnowledgeCopies(
    {
      clientInstanceId: runtime.data.clientInstanceId,
      stores: runtime.data.stores,
      now: () => new Date(),
      backend: {
        documentFileIds: (_target, ids, signal) =>
          knowledgeDocumentFileIds(runtime.data, target, ids, signal)
      }
    },
    runtime.input.files,
    target,
    copies.map((copy) => ({ ...copy, deleted: copy.status === "deleted" }))
  );
}

type FetchedDocument = Awaited<ReturnType<typeof fetchItem>>;

class SourceFormatRefusal extends Error {
  constructor(readonly code: KnowledgeDocumentFailureCode) {
    super("The source document format is unavailable");
  }
}

async function fetchItem(
  runtime: SourceJobRuntime,
  control: JobControl,
  payload: KnowledgeFetchJobPayload,
  item: SourceItem,
  connection: string,
  folderIds: readonly string[],
  signal: AbortSignal
) {
  const format = sourceFormat(item);
  if (!format) throw new SourceFormatRefusal("knowledge_file_format_unsupported");
  if (!runtime.input.documentFormats.includes(format))
    throw new SourceFormatRefusal("knowledge_file_format_unavailable");
  // The store requires a known length for a streamed put, and Managed Files require the
  // checksum at creation. Spool on disk (never in memory), hashing while reading the source,
  // then stream that file into ObjectStorage. The row precedes the stored object, as add_files
  // requires, so its existing cleanup can find every interrupted copy.
  const directory = await sourceSpool(runtime.data.clientInstanceId, payload.knowledgeBaseId);
  const path = join(directory, "body");
  try {
    const hash = createHash("sha256");
    let size = 0;
    await sourceCall(
      runtime,
      connection,
      payload.knowledgeBaseId,
      signal,
      async ({ capability, context }) => {
        async function* bytes() {
          for await (const chunk of capability.fetch(
            {
              itemId: item.item_id,
              version: item.version,
              maxBytes: KNOWLEDGE_FILE_MAX_BYTES,
              boundary: { folderIds }
            },
            context
          )) {
            context.signal.throwIfAborted();
            size += chunk.byteLength;
            if (size > KNOWLEDGE_FILE_MAX_BYTES)
              throw new DocumentSourceError(
                "over_limit",
                "The source item exceeds KNOWLEDGE_FILE_MAX_BYTES"
              );
            hash.update(chunk);
            yield chunk;
          }
        }
        await pipeline(bytes(), createWriteStream(path), { signal: context.signal });
      }
    );
    signal.throwIfAborted();
    const contentSha256 = hash.digest("hex");
    const copy = await control.transaction((stores) =>
      stores.files.createManagedFile({
        clientInstanceId: runtime.data.clientInstanceId,
        ownerUserId: payload.knowledgeBaseId,
        owner: { kind: "knowledge_base", id: payload.knowledgeBaseId },
        filename: item.name,
        mimeType: item.mime,
        byteSize: size,
        checksum: contentSha256,
        objectKey: `knowledge-bases/${payload.knowledgeBaseId}/${createPlatformId("kbobj")}`
      })
    );
    try {
      await runtime.input.files.objects.put(copy.objectKey, createReadStream(path), {
        contentType: item.mime,
        size
      });
      signal.throwIfAborted();
    } catch (error) {
      await releaseCopy(runtime, payload, copy.id);
      throw error;
    }
    return {
      id: item.document_id ?? createPlatformId("kbdoc"),
      fileId: copy.id,
      contentSha256,
      byteSize: size,
      format,
      title: item.name,
      fileName: item.name,
      ...(item.origin_link ? { originLink: item.origin_link } : {}),
      sourceItemId: item.id
    };
  } finally {
    await rm(directory, { recursive: true, force: true }).catch(() => {
      runtime.data.logger.warn(
        { knowledgeBaseId: payload.knowledgeBaseId },
        "Removing a source spool failed; the replacement worker removes it"
      );
    });
  }
}

export function createKnowledgeFetchHandler(runtime: SourceJobRuntime): RegisteredJobHandler {
  return defineJobHandler({
    kind: knowledgeFetchJob,
    slots: 4,
    async run(job, control) {
      const { payload } = job;
      const found = await sourceTarget(runtime, payload);
      if (!found) return;
      const boundaryKey = sourceBoundaryKey(found.source);
      const active = await createSourceStore(
        runtime.data,
        payload.knowledgeBaseId,
        control.signal
      ).run(payload.syncRunId);
      if (!active || active.state === "failed" || active.state === "superseded") return;
      if (active.definitionKey !== sourceBoundaryKey(found.source)) {
        await sourceTransaction(runtime.data, payload, control, (store) =>
          store.finish(payload, undefined, "superseded")
        );
        return;
      }
      const signal = AbortSignal.any([control.signal, AbortSignal.timeout(FETCH_BATCH_TIMEOUT_MS)]);
      const store = createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal);
      let authority: SourceAuthority;
      try {
        authority = await sourceAuthority(
          runtime.data.stores,
          runtime.data.clientInstanceId,
          payload.knowledgeBaseId,
          found.source.connection
        );
      } catch (error) {
        if (documentSourceErrorCodeOf(error) !== "unauthorized") throw error;
        await sourceTransaction(runtime.data, payload, control, (store) =>
          store.finish(payload, "knowledge_source_refused")
        );
        return;
      }
      await removeAbandonedSourceSpools(runtime.data.clientInstanceId, payload.knowledgeBaseId);
      await enqueueKnowledgeFileCleanup(
        {
          clientInstanceId: runtime.data.clientInstanceId,
          stores: runtime.data.stores,
          now: () => new Date()
        },
        { backend: "builtin", assetId: payload.knowledgeBaseId, name: found.name, methods: [] }
      );
      const retry: string[] = [];
      let retryMs = 0;
      const window = runtime.input.fetchWindow ?? {
        items: KNOWLEDGE_FETCH_WINDOW_ITEMS,
        bytes: KNOWLEDGE_FETCH_WINDOW_BYTES
      };
      // The contents of this batch whose copies no index job queued by it will release.
      const releases = new Map<
        string,
        ReturnType<typeof knowledgeIndexPayloadOfFetch> & { fileIds: string[] }
      >();
      const retained = new Set<string>();
      // Hands fetched items to indexing: their contents in one read, their index jobs in one
      // transaction. The copies a queued index job will release are left to it.
      async function handoff(ids: readonly string[]) {
        if (!ids.length) return;
        const contents = await store.indexPayloads(ids);
        const queue: ReturnType<typeof knowledgeIndexPayloadOfFetch>[] = [];
        for (const id of ids) {
          const content = contents.get(id);
          if (!content) continue;
          const indexPayload = knowledgeIndexPayloadOfFetch(payload, content);
          const previous = releases.get(content.contentSha256);
          if (previous) previous.fileIds.push(content.fileId);
          else releases.set(content.contentSha256, { ...indexPayload, fileIds: [content.fileId] });
          if (await needsIndex(runtime, payload.knowledgeBaseId, content, retained))
            queue.push(indexPayload);
        }
        if (!queue.length) return;
        await control.transaction(async (stores) => {
          for (const content of queue) {
            const queued = await enqueueKnowledgeIndex(stores.jobs, content, {
              clientInstanceId: runtime.data.clientInstanceId,
              dedupe: true
            });
            // A job that has not started will release this copy at its end, after the document
            // committed above. One already running may have passed its scan: the release job.
            if (queued.status === "queued") releases.delete(content.contentSha256);
          }
        });
      }
      type Fetched = { item: SourceItem; document: FetchedDocument };
      // Adopts what a group fetched, in one transaction, and hands it to indexing. False when
      // the source changed or an item did, and the pass ends here.
      async function adopt(group: readonly Fetched[]): Promise<boolean> {
        if (!group.length) return true;
        let adopted: Set<string>;
        try {
          const current = await sourceTarget(runtime, payload);
          adopted =
            current && sourceBoundaryKey(current.source) === boundaryKey
              ? await sourceTransaction(runtime.data, payload, control, (store) =>
                  store.fetchedMany(
                    payload,
                    group.map(({ item, document }) => ({
                      item,
                      document,
                      byteSize: document.byteSize
                    })),
                    job.id
                  )
                )
              : new Set();
        } catch (error) {
          // Preserve the handoff failure if cleanup also fails.
          for (const { document } of group)
            await releaseCopy(runtime, payload, document.fileId).catch(() => {
              runtime.data.logger.warn(
                { knowledgeBaseId: payload.knowledgeBaseId },
                "Source copy cleanup will be retried"
              );
            });
          throw error;
        }
        for (const { item, document } of group)
          if (!adopted.has(item.id)) await releaseCopy(runtime, payload, document.fileId);
        await handoff(group.filter(({ item }) => adopted.has(item.id)).map(({ item }) => item.id));
        return adopted.size === group.length;
      }
      const fetchBatch = async () => {
        const ids = payload.sourceItemIds.filter((id) => id !== "");
        // Items an earlier attempt fetched need only their handoff.
        const known = ids.length ? await store.items(ids, payload.sourceId) : [];
        const fetched = new Set(
          known.filter((row) => row.state === "fetched").map((row) => row.id)
        );
        await handoff([...fetched]);
        for (let start = 0; start < payload.sourceItemIds.length; start += FETCH_GROUP_ITEMS) {
          const groupIds = payload.sourceItemIds
            .slice(start, start + FETCH_GROUP_ITEMS)
            .filter((id) => id !== "" && !fetched.has(id));
          // The items the fetch window has no room for (KB-ISO-3b): they wait with the rest.
          let over: string[] = [];
          const later = () => [...over, ...payload.sourceItemIds.slice(start + FETCH_GROUP_ITEMS)];
          control.signal.throwIfAborted();
          // The executor owns the job lease; the item owns its fetch. Even a duplicate job
          // without a concurrency key cannot create another Managed File for this version.
          let items: SourceItem[] = [];
          if (groupIds.length) {
            const held = await store.fetchWindow();
            if (held.items >= window.items || held.bytes >= window.bytes) over = groupIds;
            else {
              items = await store.claimMany(groupIds, payload.sourceId, job.id);
              const room = roomFor(items, held, window);
              if (room < items.length) {
                over = items.slice(room).map((each) => each.id);
                await store.release(over, job.id);
                items = items.slice(0, room);
              }
            }
          }
          const group: Fetched[] = [];
          /** Gives back the claims of the items not yet fetched; their ids go to a new job. */
          const leave = async (from: number) => {
            const rest = items.slice(from).map((each) => each.id);
            if (rest.length) await store.release(rest, job.id);
            return rest;
          };
          for (let index = 0; index < items.length; index++) {
            const item = items[index];
            if (!item) continue;
            control.signal.throwIfAborted();
            if (signal.aborted) {
              const rest = await leave(index);
              await adopt(group);
              await queueAgain(runtime, control, payload, [...retry, ...rest, ...later()], 0);
              return;
            }
            try {
              group.push({
                item,
                document: await fetchItem(
                  { ...runtime, authority },
                  control,
                  payload,
                  item,
                  found.source.connection,
                  found.source.folders,
                  signal
                )
              });
            } catch (error) {
              control.signal.throwIfAborted();
              if (signal.aborted) {
                const rest = await leave(index);
                await adopt(group);
                await queueAgain(runtime, control, payload, [...retry, ...rest, ...later()], 0);
                return;
              }
              if (error instanceof SourceFormatRefusal) {
                await sourceTransaction(runtime.data, payload, control, (store) =>
                  store.failure(payload, item, error.code)
                );
                continue;
              }
              const code = documentSourceErrorCodeOf(error);
              if (code === "rate_limited") {
                const rest = await leave(index);
                await adopt(group);
                const wait =
                  error instanceof DocumentSourceError
                    ? (error.retryAfterMs ?? SOURCE_RATE_LIMIT_WAIT_MS)
                    : SOURCE_RATE_LIMIT_WAIT_MS;
                // Earlier ordinary failures keep their own backoff. They must not move this
                // rate-limited remainder away from the time the source named.
                await queueAgain(runtime, control, payload, retry, retryMs);
                await queueAgain(runtime, control, payload, [...rest, ...later()], wait);
                return;
              }
              if (code === "forbidden" || code === "not_found") {
                await sourceTransaction(runtime.data, payload, control, (store) =>
                  store.withdraw(payload, [item.id])
                );
                continue;
              }
              if (code === "unauthorized") {
                await leave(index);
                await adopt(group);
                await sourceTransaction(runtime.data, payload, control, (store) =>
                  store.finish(payload, "knowledge_source_refused")
                );
                return;
              }
              const failure =
                code === "over_limit"
                  ? "knowledge_file_over_limit"
                  : item.attempts + 1 >= KNOWLEDGE_FETCH_MAX_ATTEMPTS
                    ? "knowledge_fetch_failed"
                    : undefined;
              await sourceTransaction(runtime.data, payload, control, (store) =>
                store.failure(payload, item, failure)
              );
              if (!failure) {
                retry.push(item.id);
                retryMs = Math.max(retryMs, FETCH_BACKOFF_BASE_MS * 2 ** item.attempts);
              }
            }
          }
          // The owned rows commit before the queue. A replay restores the index handoff.
          if (!(await adopt(group))) return;
          if (over.length) {
            // The window is full: the rest waits for indexing and spends no attempt. Earlier
            // ordinary failures keep their own backoff.
            control.logger.info(
              { knowledgeBaseId: payload.knowledgeBaseId, waiting: later().length },
              "The fetch window is full; the rest of the batch waits"
            );
            await queueAgain(runtime, control, payload, retry, retryMs);
            await queueAgain(
              runtime,
              control,
              payload,
              later(),
              KNOWLEDGE_FETCH_WINDOW_WAIT_MS,
              true
            );
            return;
          }
        }
        await queueAgain(runtime, control, payload, retry, retryMs);
        await sourceTransaction(runtime.data, payload, control, (store) => store.finish(payload));
      };
      await fetchBatch();
      // A content index may have finished its final scan while this batch was still adopting
      // copies. Hand off once per content after the whole batch, without deduping against a
      // running index/release. If content is still pending, its index owns release instead.
      for (const content of releases.values()) {
        await control.transaction((stores) =>
          enqueueOriginalRelease(stores, runtime.data.clientInstanceId, content)
        );
      }
    },
    async onExhausted(job, stores) {
      // Settlement already holds the platform job row. This only updates source state;
      // it never takes the document lock or borrows another platform connection.
      await createSourceStore(
        runtime.data,
        job.payload.knowledgeBaseId,
        new AbortController().signal,
        stores
      ).exhausted(job.payload, job.payload.sourceItemIds, job.id, job.attempts);
    }
  });
}
