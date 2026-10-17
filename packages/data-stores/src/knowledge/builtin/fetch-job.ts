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
  KNOWLEDGE_FILE_MAX_BYTES,
  knowledgeFetchJob,
  knowledgeIndexPayloadOfFetch,
  type JobControl,
  type KnowledgeFetchJobPayload,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import { enqueueKnowledgeFileCleanup } from "../file-cleanup";
import {
  createSourceStore,
  sourceFormat,
  type SourceItem,
  type KnowledgeSourceStore
} from "./source-store";
import { sourceTarget, sourceCall, type SourceJobRuntime } from "./source-runtime";

// Match the executor's item backoff without spending job attempts for a failed neighbour.
const FETCH_BACKOFF_BASE_MS = knowledgeFetchJob.backoff.baseMs;
// A source that rate-limits without naming a time waits a minute; its items spend no attempt.
const SOURCE_RATE_LIMIT_WAIT_MS = 60_000;
// Bounds the copy window that the existing file-cleanup job protects after a killed worker.
const FETCH_BATCH_TIMEOUT_MS = 240_000;

async function queueAgain(
  runtime: SourceJobRuntime,
  control: JobControl,
  payload: KnowledgeFetchJobPayload,
  ids: string[],
  waitMs: number
) {
  if (!ids.length) return;
  await control.transaction((stores) =>
    stores.jobs.enqueue(
      knowledgeFetchJob,
      { ...payload, sourceItemIds: ids },
      {
        clientInstanceId: runtime.data.clientInstanceId,
        subject: payload.knowledgeBaseId,
        runAfter: new Date(Date.now() + waitMs)
      }
    )
  );
}
async function queueIndex(
  runtime: SourceJobRuntime,
  control: JobControl,
  store: KnowledgeSourceStore,
  payload: KnowledgeFetchJobPayload,
  id: string
) {
  const content = await store.indexPayload(id);
  if (content)
    await control.transaction((stores) =>
      enqueueKnowledgeIndex(stores.jobs, knowledgeIndexPayloadOfFetch(payload, content), {
        clientInstanceId: runtime.data.clientInstanceId,
        dedupe: true
      })
    );
}

async function fetchItem(
  runtime: SourceJobRuntime,
  control: JobControl,
  payload: KnowledgeFetchJobPayload,
  item: SourceItem,
  connection: string,
  signal: AbortSignal
) {
  const format = sourceFormat(item);
  if (!format) throw new DocumentSourceError("over_limit", "The source format is unavailable");
  // The store requires a known length for a streamed put, and Managed Files require the
  // checksum at creation. Spool on disk (never in memory), hashing while reading the source,
  // then stream that file into ObjectStorage. The row precedes the stored object, as add_files
  // requires, so its existing cleanup can find every interrupted copy.
  const directory = await sourceSpool(runtime.data.clientInstanceId, payload.knowledgeBaseId);
  const path = join(directory, "body");
  try {
    const hash = createHash("sha256");
    let size = 0;
    await sourceCall(runtime, connection, signal, async ({ capability, context }) => {
      async function* bytes() {
        for await (const chunk of capability.fetch(
          { itemId: item.item_id, version: item.version, maxBytes: KNOWLEDGE_FILE_MAX_BYTES },
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
    });
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
    await runtime.input.files.objects.put(copy.objectKey, createReadStream(path), {
      contentType: item.mime,
      size
    });
    signal.throwIfAborted();
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
      const signal = AbortSignal.any([control.signal, AbortSignal.timeout(FETCH_BATCH_TIMEOUT_MS)]);
      const store = createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal);
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
      for (let index = 0; index < payload.sourceItemIds.length; index++) {
        const id = payload.sourceItemIds[index];
        if (!id) continue;
        control.signal.throwIfAborted();
        if (signal.aborted) {
          await queueAgain(
            runtime,
            control,
            payload,
            [...retry, ...payload.sourceItemIds.slice(index)],
            0
          );
          return;
        }
        const item = await store.item(id, payload.sourceId);
        if (!item || item.state === "failed" || item.state === "withdrawn") continue;
        if (item.state === "fetched") {
          await queueIndex(runtime, control, store, payload, id);
          continue;
        }
        let document;
        try {
          document = await fetchItem(
            runtime,
            control,
            payload,
            item,
            found.source.connection,
            signal
          );
        } catch (error) {
          control.signal.throwIfAborted();
          if (signal.aborted) {
            await queueAgain(
              runtime,
              control,
              payload,
              [...retry, ...payload.sourceItemIds.slice(index)],
              0
            );
            return;
          }
          const code = documentSourceErrorCodeOf(error);
          if (code === "rate_limited") {
            const wait =
              error instanceof DocumentSourceError
                ? (error.retryAfterMs ?? SOURCE_RATE_LIMIT_WAIT_MS)
                : SOURCE_RATE_LIMIT_WAIT_MS;
            await queueAgain(
              runtime,
              control,
              payload,
              [...retry, ...payload.sourceItemIds.slice(index)],
              Math.max(wait, retryMs)
            );
            return;
          }
          if (code === "unauthorized") {
            await control.transaction(() => store.finish(payload, "knowledge_source_refused"));
            return;
          }
          const failure =
            code === "over_limit"
              ? "knowledge_file_over_limit"
              : item.attempts + 1 >= KNOWLEDGE_FETCH_MAX_ATTEMPTS
                ? "knowledge_fetch_failed"
                : undefined;
          await control.transaction(() => store.failure(payload, item, failure));
          if (!failure) {
            retry.push(id);
            retryMs = Math.max(retryMs, FETCH_BACKOFF_BASE_MS * 2 ** item.attempts);
          }
          continue;
        }
        // The copy is committed first. These three owned-store rows commit together. If the
        // queue commit is interrupted afterwards, replay sees fetched and queues the index.
        const current = await sourceTarget(runtime, payload);
        if (!current || JSON.stringify(current.source) !== JSON.stringify(found.source)) return;
        await control.transaction(() => store.fetched(payload, item, document, document.byteSize));
        await queueIndex(runtime, control, store, payload, id);
      }
      await queueAgain(runtime, control, payload, retry, retryMs);
      await control.transaction(() => store.finish(payload));
    }
  });
}
