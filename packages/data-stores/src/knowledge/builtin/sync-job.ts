import { sourceBoundaryKey } from "../source-boundary";
import { readSourcePages } from "./source-listing";
import { sourceAuthority } from "../source-principal";
import {
  isOperationRunId,
  type PlatformStores,
  type ClientInstanceId
} from "@work-shape/catalyst-core";
import { sourceSyncStarted } from "./source-lifecycle";
import { createHash } from "node:crypto";
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
import { createSourceStore, sourceTransaction } from "./source-store";
import { sourceTarget, type SourceJobRuntime } from "./source-runtime";
import { dropExhaustedPass, isWorkflowSourceId, runIngestPass } from "./ingest";
import { firstPassStopOf } from "../first-pass";

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
      // A Workflow's `ingest` call (KBW-1) reads its own items, not a source.
      if (isWorkflowSourceId(payload.sourceId)) {
        await runIngestPass(runtime, job, control);
        return;
      }
      let run = await store.run(payload.syncRunId);
      if (!run) {
        await store.change(async (sql) => {
          await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
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
      if (!run || run.state !== "running" || run.mode === "ingest") return;
      const found = await sourceTarget(runtime, payload);
      if (!found || run.definitionKey !== sourceBoundaryKey(found.source)) {
        await sourceTransaction(runtime.data, payload, control, (store) =>
          found
            ? store.finish(payload, undefined, "superseded")
            : store.finish(payload, "knowledge_source_unreachable")
        );
        return;
      }
      // KB-ISO-1b: a first sync fetches up to the stop until a person confirms the rest. The
      // listing goes on, so the confirmation knows what the whole source holds.
      const at = firstPassStopOf(runtime.input);
      const stops = run.mode === "initial" && run.progress?.stop?.confirmed !== true;
      let budget = stops ? Math.max(0, at - (await store.enqueuedCount(payload))) : Infinity;
      const queue = async (ids: string[]) => {
        const now = ids.slice(0, budget);
        budget -= now.length;
        if (now.length) await queueFetches(runtime, control, payload, now);
      };
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
          while (budget > 0) {
            const ids = await store.pending(payload, after, KNOWLEDGE_FETCH_BATCH_ITEMS);
            if (!ids.length) break;
            await queue(ids);
            after = ids.at(-1) ?? after;
          }
        }
        try {
          await readSourcePages(
            authorizedRuntime,
            payload,
            control,
            found.source,
            run.mode,
            run.progress,
            queue
          );
        } catch (error) {
          if (documentSourceErrorCodeOf(error) !== "cursor_expired") throw error;
          await sourceTransaction(runtime.data, payload, control, (store) =>
            store.change((sql) =>
              sql.run(
                "update catalyst_kb.sync_runs set mode='full',reason='cursor_expired',cursor_after=null where id=$1::text",
                [payload.syncRunId]
              )
            )
          );
          await readSourcePages(
            authorizedRuntime,
            payload,
            control,
            found.source,
            "full",
            undefined,
            queue
          );
        }
        // Listed to the end with items left at the stop: the run waits for a confirmation.
        if (stops)
          await sourceTransaction(runtime.data, payload, control, (store) =>
            store.stopFirstPass(payload, at)
          );
      } catch (error) {
        control.signal.throwIfAborted();
        const code =
          error instanceof ListingFailure ? error.code : documentSourceErrorCodeOf(error);
        if (code === "rate_limited") {
          await control.transaction((stores) =>
            stores.jobs.enqueue(knowledgeSyncJob, payload, {
              clientInstanceId: runtime.data.clientInstanceId,
              subject: payload.knowledgeBaseId,
              concurrencyKey: knowledgeSourceKey(payload.knowledgeBaseId, payload.sourceId),
              runAfter: new Date(
                Date.now() +
                  ((error instanceof ListingFailure || error instanceof DocumentSourceError
                    ? error.retryAfterMs
                    : undefined) ?? knowledgeSyncJob.backoff.baseMs)
              )
            })
          );
          return;
        }
        // Credential and listing failures are terminal for this pass. They withdraw nothing.
        await sourceTransaction(runtime.data, payload, control, (store) =>
          store.finish(
            payload,
            code === "over_limit"
              ? "knowledge_source_limit_reached"
              : code === "unauthorized" || code === "forbidden"
                ? "knowledge_source_refused"
                : "knowledge_source_unreachable"
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
      await dropExhaustedPass(runtime.data, stores, job.payload);
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
