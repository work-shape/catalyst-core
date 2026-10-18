import { supersedeWaitingSource } from "./source-supersession";
import { sourceTarget } from "./source-runtime";
import { sourceBoundaryKey } from "../source-boundary";
import { withdrawSourceItems, refreshSourceFreshness } from "./source-withdrawal";
import type { KnowledgeListingMode } from "../source-port";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  KNOWLEDGE_CONTENT_STATES,
  AppError,
  asManagedFileId,
  documentSourceItemSchema,
  KNOWLEDGE_FILE_MAX_BYTES,
  type KnowledgeSyncResult,
  knowledgeDocumentFormatOf,
  knowledgeSyncResultSchema,
  type DocumentSourceItem,
  type KnowledgeDocumentFormat,
  type KnowledgeFetchedDocument,
  type KnowledgeSyncJobPayload,
  type PlatformStores,
  type JobControl
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { settleSourceSync } from "./source-lifecycle";
import type { DataStoreRuntime } from "../../runtime";

// Source writes use the executor's job lease and the owned store transaction together.
// No outside request runs inside either transaction.
const SOURCE_STORE_TIMEOUT_MS = 30_000; // Bounds a page transaction; the job can resume it.
const progressSchema = z.object({
  pageToken: z.string().optional(),
  complete: z.boolean(),
  feedCursor: z.string().optional(),
  reconciled: z.boolean().optional(),
  listing: z.boolean().optional()
});
export type SourceProgress = z.infer<typeof progressSchema>;
const runSchema = z.object({
  mode: knowledgeSyncResultSchema.shape.mode,
  state: z.string(),
  cursor_after: z.string().nullable(),
  approval_request_id: z.string().nullable(),
  definition_key: z.string().nullable()
});
const itemSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  version: z.string(),
  name: z.string(),
  path: z.string(),
  mime: z.string(),
  size: z.coerce.number(),
  state: z.string(),
  attempts: z.number().int(),
  document_id: z.string().nullable(),
  origin_link: z.string().nullable(),
  enqueued_run_id: z.string().nullable(),
  fetch_job_id: z.string().nullable()
});
export type SourceItem = z.infer<typeof itemSchema>;
const idSchema = z.object({ id: z.string() });

function sourceItemId(sourceId: string, itemId: string): string {
  return `kbitem_${createHash("sha256")
    .update(JSON.stringify([sourceId, itemId]))
    .digest("hex")}`;
}
export function sourceFormat(item: {
  name: string;
  mime: string;
}): KnowledgeDocumentFormat | undefined {
  return knowledgeDocumentFormatOf({ filename: item.name, mimeType: item.mime });
}

export function createSourceStore(
  runtime: DataStoreRuntime,
  knowledgeBaseId: string,
  signal: AbortSignal,
  stores: PlatformStores = runtime.stores,
  statements?: PostgresChangeStatements
) {
  async function change<T>(work: (sql: PostgresChangeStatements) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    if (statements) return work(statements);
    const record = await stores.dataStores.getDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: knowledgeBaseId
    });
    if (!record || record.status !== "ready" || !record.ownerKnowledgeBaseId)
      throw new AppError("CONFLICT", "The source's owned store is not ready");
    return runtime.server.executor.change(
      {
        ...runtime.server.asPlatform(record.location.database),
        timeoutMs: SOURCE_STORE_TIMEOUT_MS,
        signal
      },
      work
    );
  }
  return {
    change,
    withdraw(payload: KnowledgeSyncJobPayload, ids: readonly string[]) {
      return change((sql) => withdrawSourceItems(sql, stores, runtime, payload, ids));
    },
    async start(payload: KnowledgeSyncJobPayload, mode: KnowledgeListingMode) {
      const target = await sourceTarget({ data: runtime }, payload, stores);
      if (!target) throw new AppError("CONFLICT", "The published source is unavailable");
      const definitionKey = sourceBoundaryKey(target.source);
      return change(async (sql) => {
        const superseded =
          mode === "initial"
            ? await supersedeWaitingSource(sql, stores, runtime, payload)
            : undefined;
        if (superseded) {
          await createSourceStore(runtime, knowledgeBaseId, signal, stores, sql).finish(
            superseded,
            "knowledge_source_refused"
          );
          // A replacement must re-list everything, even when requested as a changes poll.
          mode = "full";
        }
        // Return and lock the winner in the same statement. A finishing run cannot leave
        // a gap between a uniqueness refusal and a separate lookup of the running row.
        const [row] = z
          .array(z.object({ id: z.string(), operation_run_id: z.string(), created: z.boolean() }))
          .parse(
            await sql.run(
              "insert into catalyst_kb.sync_runs (id,source_id,mode,operation_run_id,cursor_before,definition_key) values ($1::text,$2::text,$3::text,$4::text,(select cursor from catalyst_kb.source_cursors where source_id=$2::text and definition_key=$5::text),$5::text) on conflict (source_id) where state='running' do update set source_id=sync_runs.source_id returning id,operation_run_id,(xmax=0) as created",
              [payload.syncRunId, payload.sourceId, mode, payload.operationRunId, definitionKey]
            )
          );
        if (!row) throw new AppError("INTERNAL", "The source sync could not be started");
        return {
          operationRunId: row.operation_run_id,
          syncRunId: row.id,
          created: row.created
        };
      });
    },
    async run(id: string) {
      return change(async (sql) => {
        const [row] = z
          .array(runSchema)
          .parse(
            await sql.run(
              "select mode, state, cursor_after, approval_request_id, definition_key from catalyst_kb.sync_runs where id = $1::text",
              [id]
            )
          );
        return (
          row && {
            mode: row.mode,
            state: row.state,
            approvalRequestId: row.approval_request_id,
            definitionKey: row.definition_key,
            progress:
              row.cursor_after === null
                ? undefined
                : progressSchema.parse(JSON.parse(row.cursor_after))
          }
        );
      });
    },
    async page(
      payload: KnowledgeSyncJobPayload,
      items: DocumentSourceItem[],
      progress: SourceProgress,
      formats: readonly KnowledgeDocumentFormat[],
      maxDocuments: number
    ) {
      return change(async (sql) => {
        const active = await sql.run(
          "select id from catalyst_kb.sync_runs where id=$1::text and state='running'",
          [payload.syncRunId]
        );
        if (!active.length) return { queued: [], limited: false };
        // Admission shares add_files' writer lock: concurrent sources cannot exceed the cap.
        await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
        await sql.run("lock table catalyst_kb.source_items in share row exclusive mode");
        const [count] = z
          .array(z.object({ n: z.number().int() }))
          .parse(
            await sql.run(
              `select ((select coalesce(sum(items),0) from catalyst_kb.source_counts where state <> 'withdrawn') + (select count(*) from catalyst_kb.documents where source_item_id is null and withdrawn_at is null))::int as n`
            )
          );
        // Take content locks before any count delta in this page. An index completion takes
        // its content first too, so a mixed page cannot invert that order.
        await sql.run(
          "select c.sha256 from catalyst_kb.contents c join catalyst_kb.documents d on d.content_sha256=c.sha256 join catalyst_kb.source_items i on i.document_id=d.id where i.source_id=$1::text and i.item_id=any($2::text[]) order by c.sha256 for share of c",
          [payload.sourceId, items.map((item) => item.id)]
        );
        let held = count?.n ?? 0;
        const queued: string[] = [];
        let limited = false;
        let changed = false;
        for (const raw of items) {
          const item = documentSourceItemSchema.parse(raw);
          const id = sourceItemId(payload.sourceId, item.id);
          const [old] = z
            .array(itemSchema)
            .parse(
              await sql.run(
                "select id, item_id, version, name, path, mime, size, state, attempts, document_id, origin_link, enqueued_run_id, fetch_job_id from catalyst_kb.source_items where id = $1::text",
                [id]
              )
            );
          if ((!old || old.state === "withdrawn") && held >= maxDocuments) {
            limited = true;
            break;
          }
          if (!old || old.state === "withdrawn") held++;
          const format = sourceFormat(item);
          const failure =
            item.size > KNOWLEDGE_FILE_MAX_BYTES
              ? "knowledge_file_over_limit"
              : !format
                ? "knowledge_file_format_unsupported"
                : !formats.includes(format)
                  ? "knowledge_file_format_unavailable"
                  : null;
          const same = old?.version === item.version && old.state !== "withdrawn";
          changed ||= !same || old?.name !== item.name || old.path !== item.path;
          await sql.run(
            `insert into catalyst_kb.source_items
            (id, source_id, item_id, version, path, name, mime, size, modified_at, origin_link, state, failure_code, parents, seen_run_id)
            values ($1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::bigint,$9::timestamptz,$10::text,$11::text,$12::text,$14::jsonb,$15::text)
            on conflict (source_id,item_id) do update set parents=excluded.parents, seen_run_id=excluded.seen_run_id,withdrawn_at=null,purged_at=null,version=excluded.version, path=excluded.path, name=excluded.name, mime=excluded.mime, size=excluded.size, modified_at=excluded.modified_at, origin_link=excluded.origin_link,
            state=case when $13::boolean then source_items.state else excluded.state end,
            failure_code=case when $13::boolean then source_items.failure_code else excluded.failure_code end,
            attempts=case when $13::boolean then source_items.attempts else 0 end,
            enqueued_run_id=case when $13::boolean then source_items.enqueued_run_id else null end,
            fetch_job_id=case when $13::boolean and source_items.enqueued_run_id=$15::text then source_items.fetch_job_id else null end,
            changed_at=case when source_items.version <> excluded.version or source_items.path <> excluded.path or source_items.name <> excluded.name then now() else source_items.changed_at end`,
            [
              id,
              payload.sourceId,
              item.id,
              item.version,
              item.path,
              item.name,
              item.mime,
              item.size,
              item.modifiedAt,
              item.originLink ?? null,
              failure ? "failed" : "discovered",
              failure,
              same,
              JSON.stringify(item.parents),
              payload.syncRunId
            ]
          );
          if (old?.document_id && same)
            await sql.run(
              "update catalyst_kb.documents set title=$2::text,file_name=$2::text,origin_link=$3::text where id=$1::text",
              [old.document_id, item.name, item.originLink ?? null]
            );
          if (
            (!same && !failure) ||
            (same && old.state === "discovered" && old.enqueued_run_id !== payload.syncRunId)
          )
            queued.push(id);
          await sql.run(
            `update catalyst_kb.sync_runs set discovered=discovered+$2::int, changed=changed+$3::int, moved=moved+$4::int, skipped=skipped+$5::int, failed=failed+$6::int where id=$1::text`,
            [
              payload.syncRunId,
              old ? 0 : 1,
              old && !same ? 1 : 0,
              same && old && (old.name !== item.name || old.path !== item.path) ? 1 : 0,
              same ? 1 : 0,
              !same && failure ? 1 : 0
            ]
          );
        }
        const cursor = JSON.stringify({ ...progress, complete: progress.complete || limited });
        await sql.run("update catalyst_kb.sync_runs set cursor_after=$2::text where id=$1::text", [
          payload.syncRunId,
          cursor
        ]);
        // The feed position and the listed page commit together. Listing progress belongs to
        // the run, so a full pass never mistakes its page token for a change-feed cursor.
        if (
          progress.feedCursor !== undefined &&
          (progress.listing !== true || progress.complete) &&
          !limited
        )
          await sql.run(
            `insert into catalyst_kb.source_cursors (source_id,cursor,definition_key) values ($1::text,$2::text,(select definition_key from catalyst_kb.sync_runs where id=$3::text)) on conflict(source_id) do update set cursor=excluded.cursor,definition_key=excluded.definition_key,updated_at=now()`,
            [payload.sourceId, progress.feedCursor, payload.syncRunId]
          );
        await refreshSourceFreshness(sql, payload.sourceId, changed);
        return { queued, limited };
      });
    },
    async pending(payload: KnowledgeSyncJobPayload, after: string, limit: number) {
      return change(async (sql) =>
        z
          .array(idSchema)
          .parse(
            await sql.run(
              "select id from catalyst_kb.source_items where source_id=$1::text and state='discovered' and id>$2::text and enqueued_run_id is distinct from $4::text order by id limit $3::int",
              [payload.sourceId, after, limit, payload.syncRunId]
            )
          )
          .map((row) => row.id)
      );
    },
    async queued(payload: KnowledgeSyncJobPayload, ids: string[]) {
      return change(async (sql) => {
        await sql.run(
          "update catalyst_kb.source_items set enqueued_run_id=$2::text where id=any($1::text[]) and source_id=$3::text and exists(select 1 from catalyst_kb.sync_runs where id=$2::text and state='running')",
          [ids, payload.syncRunId, payload.sourceId]
        );
      });
    },
    async claim(id: string, sourceId: string, jobId: string) {
      return change(
        async (sql) =>
          z.array(itemSchema).parse(
            await sql.run(
              `update catalyst_kb.source_items set fetch_job_id=$3::text
         where id=$1::text and source_id=$2::text and state='discovered'
           and (fetch_job_id is null or fetch_job_id=$3::text)
         returning id,item_id,version,name,path,mime,size,state,attempts,document_id,origin_link,enqueued_run_id,fetch_job_id`,
              [id, sourceId, jobId]
            )
          )[0]
      );
    },
    async release(ids: string[], jobId: string) {
      return change(async (sql) => {
        await sql.run(
          "update catalyst_kb.source_items set fetch_job_id=null where id=any($1::text[]) and fetch_job_id=$2::text",
          [ids, jobId]
        );
      });
    },
    async exhausted(
      payload: KnowledgeSyncJobPayload,
      ids: string[],
      jobId: string,
      attempts: number
    ) {
      return change(async (sql) => {
        const failed = await sql.run(
          `update catalyst_kb.source_items set state='failed',failure_code='knowledge_fetch_failed',
           attempts=case when fetch_job_id=$3::text then greatest(attempts,$4::int) else attempts end,fetch_job_id=null,changed_at=now()
           where source_id=$1::text and id=any($2::text[]) and state='discovered'
             and (fetch_job_id is null or fetch_job_id=$3::text)
             and (enqueued_run_id is null or enqueued_run_id=$5::text) returning id`,
          [payload.sourceId, ids, jobId, attempts, payload.syncRunId]
        );
        const [ended] = await sql.run(
          "update catalyst_kb.sync_runs set failed=failed+$2::int,state='failed',failure_code='knowledge_fetch_failed',ended_at=now() where id=$1::text and state='running' returning *",
          [payload.syncRunId, failed.length]
        );
        if (ended) await settleSourceSync(stores, runtime, payload, syncResult(ended), true);
      });
    },
    async item(id: string, sourceId: string) {
      return change(
        async (sql) =>
          z
            .array(itemSchema)
            .parse(
              await sql.run(
                "select id,item_id,version,name,path,mime,size,state,attempts,document_id,origin_link,enqueued_run_id,fetch_job_id from catalyst_kb.source_items where id=$1::text and source_id=$2::text",
                [id, sourceId]
              )
            )[0]
      );
    },
    async failure(payload: KnowledgeSyncJobPayload, item: SourceItem, code: string | undefined) {
      return change(async (sql) => {
        const attempts = item.attempts + 1;
        const changed = await sql.run(
          `update catalyst_kb.source_items set attempts=$3::int,state=$4::text,failure_code=$5::text,fetch_job_id=null,changed_at=now() where id=$1::text and version=$2::text and state='discovered' returning id`,
          [item.id, item.version, attempts, code ? "failed" : "discovered", code ?? null]
        );
        if (changed.length && code)
          await sql.run("update catalyst_kb.sync_runs set failed=failed+1 where id=$1::text", [
            payload.syncRunId
          ]);
      });
    },
    async fetched(
      payload: KnowledgeSyncJobPayload,
      item: SourceItem,
      document: KnowledgeFetchedDocument,
      byteSize: number,
      jobId: string
    ) {
      return change(async (sql) => {
        await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
        // Content completion updates open-change projections on its items. Lock both
        // hashes before the item, matching the indexer's content -> item order.
        await sql.run(
          "select sha256 from catalyst_kb.contents where sha256=any(array[$1::text,(select d.content_sha256 from catalyst_kb.documents d where d.source_item_id=$2::text)]) order by sha256 for share",
          [document.contentSha256, item.id]
        );
        const [held] = z
          .array(itemSchema)
          .parse(
            await sql.run(
              "select id,item_id,version,name,path,mime,size,state,attempts,document_id,origin_link,enqueued_run_id,fetch_job_id from catalyst_kb.source_items where id=$1::text for update",
              [item.id]
            )
          );
        if (
          !held ||
          held.version !== item.version ||
          held.state !== "discovered" ||
          held.fetch_job_id !== jobId
        )
          return false;
        const active = await sql.run(
          "select id from catalyst_kb.sync_runs where id=$1::text and state='running'",
          [payload.syncRunId]
        );
        if (!active.length) return false;
        // A cleanup that won before this transaction must never be given a new document.
        const copy = await stores.files.getManagedFile({
          clientInstanceId: runtime.clientInstanceId,
          fileId: asManagedFileId(document.fileId)
        });
        if (!copy || copy.status === "deleted")
          throw new AppError("CONFLICT", "The source copy was released before its handoff");
        await sql.run(
          "insert into catalyst_kb.contents (sha256,format) values ($1::text,$2::text) on conflict(sha256) do nothing",
          [document.contentSha256, document.format]
        );
        await sql.run(
          "update catalyst_kb.contents set state='pending',failure_code=null,chunking_revision=null where sha256=$1::text and state='failed'",
          [document.contentSha256]
        );
        await sql.run(
          `insert into catalyst_kb.documents (id,managed_file_id,content_sha256,title,file_name,origin_link,source_item_id)
          values ($1::text,$2::text,$3::text,$4::text,$4::text,$5::text,$6::text)
          on conflict (source_item_id) where source_item_id is not null do update set managed_file_id=excluded.managed_file_id,content_sha256=excluded.content_sha256,title=excluded.title,file_name=excluded.file_name,origin_link=excluded.origin_link,withdrawn_at=null`,
          [
            document.id,
            document.fileId,
            document.contentSha256,
            held.name,
            document.originLink ?? null,
            item.id
          ]
        );
        await sql.run(
          "update catalyst_kb.source_items set state='fetched',fetch_job_id=null,attempts=attempts+1,failure_code=null,document_id=$2::text,fetched_at=now(),changed_at=now(),withdrawn_at=null,purged_at=null where id=$1::text",
          [item.id, document.id]
        );
        await sql.run(
          "update catalyst_kb.sync_runs set added=added+$2::int,bytes_fetched=bytes_fetched+$3::bigint where id=$1::text",
          [payload.syncRunId, held.document_id ? 0 : 1, byteSize]
        );
        return true;
      });
    },
    async indexPayload(id: string) {
      return change(async (sql) => {
        const [row] = z
          .array(
            z.object({
              content_sha256: z.string(),
              managed_file_id: z.string(),
              state: z.enum(KNOWLEDGE_CONTENT_STATES)
            })
          )
          .parse(
            await sql.run(
              "select d.content_sha256,d.managed_file_id,c.state from catalyst_kb.documents d join catalyst_kb.contents c on c.sha256=d.content_sha256 where source_item_id=$1::text and withdrawn_at is null",
              [id]
            )
          );
        return (
          row && {
            contentSha256: row.content_sha256,
            fileId: row.managed_file_id,
            state: row.state
          }
        );
      });
    },
    async finish(payload: KnowledgeSyncJobPayload, failureCode?: string) {
      return change(async (sql) => {
        await refreshSourceFreshness(sql, payload.sourceId, false);
        const finished = await sql.run(
          `update catalyst_kb.sync_runs set state=$2::text,failure_code=$3::text,ended_at=now() where id=$1::text and state='running' and ($3::text is not null or (cursor_after::jsonb->>'complete'='true' and (cursor_after::jsonb->>'listing' is distinct from 'true' or cursor_after::jsonb->>'reconciled'='true') and not exists (select 1 from catalyst_kb.source_items where source_id=$4::text and state='discovered'))) returning id`,
          [
            payload.syncRunId,
            failureCode ? "failed" : "done",
            failureCode ?? null,
            payload.sourceId
          ]
        );
        const [row] = await sql.run("select * from catalyst_kb.sync_runs where id=$1::text", [
          payload.syncRunId
        ]);
        if (row)
          await settleSourceSync(stores, runtime, payload, syncResult(row), finished.length === 1);
      });
    }
  };
}
export type KnowledgeSourceStore = ReturnType<typeof createSourceStore>;

/** All cross-store writers take the owned document lock before borrowing a platform
 * transaction, matching add_files and purge. Reuse both connections inside the callback:
 * borrowing another platform connection here can deadlock a pool with one connection. */
export function sourceTransaction<T>(
  runtime: DataStoreRuntime,
  payload: KnowledgeSyncJobPayload,
  control: JobControl,
  work: (store: KnowledgeSourceStore, stores: PlatformStores) => Promise<T>
): Promise<T> {
  return createSourceStore(runtime, payload.knowledgeBaseId, control.signal).change(async (sql) => {
    await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
    return control.transaction((stores) =>
      work(createSourceStore(runtime, payload.knowledgeBaseId, control.signal, stores, sql), stores)
    );
  });
}

const syncRowSchema = z.object({
  id: z.string(),
  source_id: z.string(),
  mode: knowledgeSyncResultSchema.shape.mode,
  state: knowledgeSyncResultSchema.shape.state,
  reason: z.string().nullable(),
  discovered: z.number(),
  added: z.number(),
  changed: z.number(),
  moved: z.number(),
  withdrawn: z.number(),
  failed: z.number(),
  skipped: z.number(),
  bytes_fetched: z.coerce.number(),
  failure_code: z.string().nullable(),
  started_at: z.coerce.date(),
  ended_at: z.coerce.date().nullable()
});
export function syncResult(raw: unknown): KnowledgeSyncResult {
  const row = syncRowSchema.parse(raw);
  return knowledgeSyncResultSchema.parse({
    syncRunId: row.id,
    source: row.source_id,
    mode: row.mode,
    state: row.state,
    counts: {
      discovered: row.discovered,
      added: row.added,
      changed: row.changed,
      moved: row.moved,
      withdrawn: row.withdrawn,
      failed: row.failed,
      skipped: row.skipped
    },
    bytesFetched: row.bytes_fetched,
    startedAt: row.started_at.toISOString(),
    ...(row.ended_at ? { endedAt: row.ended_at.toISOString() } : {}),
    ...(row.reason === "cursor_expired" ? { reason: row.reason } : {}),
    ...(row.failure_code ? { failureCode: row.failure_code } : {})
  });
}
