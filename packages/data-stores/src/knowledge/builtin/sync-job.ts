import { sourceAuthority } from "../source-principal";
import {
  isOperationRunId,
  type PlatformStores,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import { sourceSyncStarted } from "./source-lifecycle";
import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import {
  DocumentSourceError,
  defineJobHandler,
  documentSourceErrorCodeOf,
  knowledgeFetchJob,
  knowledgeSourceKey,
  knowledgeSyncJob,
  subjectDedupeKey,
  type JobControl,
  type KnowledgeSyncJobPayload,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import { createSourceStore, sourceTransaction, type SourceProgress } from "./source-store";
import { sourceTarget, sourceCall, type SourceJobRuntime } from "./source-runtime";

// 100 ids keep queue rows bounded and limit the work lost with one lease to one batch.
const KNOWLEDGE_FETCH_BATCH_ITEMS = 100;

async function queueFetches(
  runtime: SourceJobRuntime,
  control: JobControl,
  payload: KnowledgeSyncJobPayload,
  ids: string[],
  runAfter?: Date
) {
  for (let start = 0; start < ids.length; start += KNOWLEDGE_FETCH_BATCH_ITEMS) {
    const sourceItemIds = ids.slice(start, start + KNOWLEDGE_FETCH_BATCH_ITEMS);
    await control.transaction((stores) =>
      stores.jobs.enqueue(
        knowledgeFetchJob,
        { ...payload, sourceItemIds },
        {
          clientInstanceId: runtime.data.clientInstanceId,
          subject: payload.knowledgeBaseId,
          concurrencyKey: knowledgeSourceKey(payload.knowledgeBaseId, payload.sourceId),
          dedupeKey: subjectDedupeKey(
            knowledgeFetchJob.kind,
            `${payload.syncRunId}:${createHash("sha256").update(JSON.stringify(sourceItemIds)).digest("hex")}`
          ),
          ...(runAfter ? { runAfter } : {})
        }
      )
    );
    // The queue commits first. A crash in this gap may enqueue a duplicate, which the
    // per-item fetch claim makes a no-op; a normal listing resume queues no item twice.
    await sourceTransaction(runtime.data, payload, control, (store) =>
      store.queued(payload, sourceItemIds)
    );
  }
}

class ListingFailure extends Error {
  constructor(
    readonly code: ReturnType<typeof documentSourceErrorCodeOf>,
    readonly retryAfterMs?: number
  ) {
    super("The source listing failed");
  }
}
async function listing<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new ListingFailure(
      documentSourceErrorCodeOf(error),
      error instanceof DocumentSourceError ? error.retryAfterMs : undefined
    );
  }
}

export function createKnowledgeSyncHandler(runtime: SourceJobRuntime): RegisteredJobHandler {
  return defineJobHandler({
    kind: knowledgeSyncJob,
    slots: 2,
    async run(job, control) {
      const { payload } = job;
      const store = createSourceStore(runtime.data, payload.knowledgeBaseId, control.signal);
      // The publish queues ids in its transaction; the owned database is provisioned later.
      // Retry until it exists, then create the initial run exactly once.
      let run = await store.run(payload.syncRunId);
      if (!run) {
        await store.change(async (sql) => {
          const bound = createSourceStore(
            runtime.data,
            payload.knowledgeBaseId,
            control.signal,
            runtime.data.stores,
            sql
          );
          const started = await bound.start(payload, "initial");
          if (started.operationRunId !== payload.operationRunId)
            await control.transaction((stores) =>
              settleJoinedInitial(
                stores,
                runtime.data.clientInstanceId,
                payload.operationRunId,
                started.operationRunId
              )
            );
          if (started.created)
            await control.transaction((stores) => sourceSyncStarted(stores, runtime.data, payload));
        });
        run = await store.run(payload.syncRunId);
      }
      if (!run || run.state !== "running") return;
      const found = await sourceTarget(runtime, payload);
      if (!found) {
        await sourceTransaction(runtime.data, payload, control, (store) =>
          store.finish(payload, "knowledge_source_unreachable")
        );
        return;
      }
      if (run.mode === "changes")
        throw new Error("Change-feed ingestion is not available in this release");
      let progress: SourceProgress = run.progress ?? { complete: false };
      try {
        const authorizedRuntime = {
          ...runtime,
          authority: await listing(() =>
            sourceAuthority(
              runtime.data.stores,
              runtime.data.clientInstanceId,
              payload.knowledgeBaseId,
              found.source.connection
            )
          )
        };
        if (run.progress) {
          // A crash between the owned page commit and the platform queue commit is recovered
          // here. Keyset pages never load a source's full inventory into the process.
          let after = "";
          for (;;) {
            const ids = await store.pending(payload, after, KNOWLEDGE_FETCH_BATCH_ITEMS);
            if (!ids.length) break;
            await queueFetches(runtime, control, payload, ids);
            after = ids.at(-1) ?? after;
          }
        }
        if (!run.progress) {
          const feed = await listing(() =>
            sourceCall(
              authorizedRuntime,
              found.source.connection,
              payload.knowledgeBaseId,
              control.signal,
              ({ capability, context }) =>
                capability.changes({ boundary: { folderIds: found.source.folders } }, context)
            )
          );
          progress = {
            complete: false,
            ...(feed.kind === "changes" ? { feedCursor: feed.nextCursor } : {})
          };
        }
        while (!progress.complete) {
          const page = await listing(() =>
            sourceCall(
              authorizedRuntime,
              found.source.connection,
              payload.knowledgeBaseId,
              control.signal,
              ({ capability, context }) =>
                capability.list(
                  {
                    boundary: { folderIds: found.source.folders },
                    ...(progress.pageToken ? { pageToken: progress.pageToken } : {})
                  },
                  context
                )
            )
          );
          if (page.nextPageToken !== undefined && page.nextPageToken === progress.pageToken)
            throw new Error("The source repeated its page token");
          const next: SourceProgress = {
            complete: page.nextPageToken === undefined,
            ...(page.nextPageToken === undefined ? {} : { pageToken: page.nextPageToken }),
            ...(progress.feedCursor === undefined ? {} : { feedCursor: progress.feedCursor })
          };
          const items = page.items.filter(
            (item) =>
              item.parents.some((parent) => found.source.folders.includes(parent)) &&
              (!found.source.include ||
                found.source.include.some((pattern) => matchesGlob(item.name, pattern))) &&
              !found.source.exclude?.some(
                (pattern) =>
                  matchesGlob(item.path.slice(1), pattern) || matchesGlob(item.path, pattern)
              )
          );
          const result = await sourceTransaction(runtime.data, payload, control, (store) =>
            store.page(
              payload,
              items,
              next,
              runtime.input.documentFormats,
              runtime.input.maxDocuments
            )
          );
          await queueFetches(runtime, control, payload, result.queued);
          if (result.limited) {
            await sourceTransaction(runtime.data, payload, control, (store) =>
              store.finish(payload, "knowledge_source_limit_reached")
            );
            return;
          }
          progress = next;
        }
        await sourceTransaction(runtime.data, payload, control, (store) => store.finish(payload));
      } catch (error) {
        control.signal.throwIfAborted();
        if (!(error instanceof ListingFailure)) throw error;
        const { code } = error;
        if (code === "rate_limited") {
          await control.transaction((stores) =>
            stores.jobs.enqueue(knowledgeSyncJob, payload, {
              clientInstanceId: runtime.data.clientInstanceId,
              subject: payload.knowledgeBaseId,
              concurrencyKey: knowledgeSourceKey(payload.knowledgeBaseId, payload.sourceId),
              runAfter: new Date(
                Date.now() + (error.retryAfterMs ?? knowledgeSyncJob.backoff.baseMs)
              )
            })
          );
          return;
        }
        // Credential and listing failures are terminal for this pass. They withdraw nothing.
        await sourceTransaction(runtime.data, payload, control, (store) =>
          store.finish(
            payload,
            code === "unauthorized" ? "knowledge_source_refused" : "knowledge_source_unreachable"
          )
        );
      }
    },
    async onExhausted(job, stores) {
      const owned = await stores.dataStores.getDataStore({
        clientInstanceId: runtime.data.clientInstanceId,
        id: job.payload.knowledgeBaseId
      });
      if (!owned || owned.status !== "ready") {
        const id = job.payload.operationRunId;
        if (isOperationRunId(id))
          await stores.operationRuns.finish({
            clientInstanceId: runtime.data.clientInstanceId,
            id,
            end: {
              status: "failed",
              finishedAt: new Date().toISOString(),
              error: {
                code: "knowledge_source_unreachable",
                message: "The Knowledge Base source store is unavailable"
              }
            }
          });
        return;
      }
      const store = createSourceStore(
        runtime.data,
        job.payload.knowledgeBaseId,
        new AbortController().signal,
        stores
      );
      await store.finish(job.payload, "knowledge_source_unreachable");
    }
  });
}

async function settleJoinedInitial(
  stores: PlatformStores,
  clientInstanceId: ClientInstanceId,
  candidate: string,
  joined: string
) {
  if (!isOperationRunId(candidate)) return;
  await stores.operationRuns.finish({
    clientInstanceId,
    id: candidate,
    end: {
      status: "done",
      finishedAt: new Date().toISOString(),
      resultRef: `operation_run:${joined}`
    }
  });
}
