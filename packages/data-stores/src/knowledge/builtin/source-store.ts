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
import {
  emptyFirstPassStop,
  firstPassStopSchema,
  tallyFirstPass,
  UNSIZED_ITEM_BYTES
} from "../first-pass";

// Source writes use the executor's job lease and the owned store transaction together.
// No outside request runs inside either transaction.
const SOURCE_STORE_TIMEOUT_MS = 30_000; // Bounds a page transaction; the job can resume it.
const progressSchema = z.object({
  pageToken: z.string().optional(),
  complete: z.boolean(),
  feedCursor: z.string().optional(),
  reconciled: z.boolean().optional(),
  listing: z.boolean().optional(),
  /** A first sync above the stop waits here for one confirmation (KB-ISO-1b). */
  stop: firstPassStopSchema.optional()
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
const ITEM_COLUMNS =
  "id,item_id,version,name,path,mime,size,state,attempts,document_id,origin_link,enqueued_run_id,fetch_job_id";

export function sourceItemId(sourceId: string, itemId: string): string {
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
        // One read, one write per statement for the whole page: the lock above is held for
        // the page, so every statement saved here shortens the wait of the fetches behind it.
        // An item listed twice in a page keeps its last listing.
        const listed = [
          ...new Map(
            items.map((raw) => {
              const item = documentSourceItemSchema.parse(raw);
              return [item.id, item] as const;
            })
          ).values()
        ];
        const olds = new Map(
          z
            .array(itemSchema)
            .parse(
              await sql.run(
                `select ${ITEM_COLUMNS} from catalyst_kb.source_items where id = any($1::text[])`,
                [listed.map((item) => sourceItemId(payload.sourceId, item.id))]
              )
            )
            .map((row) => [row.id, row])
        );
        const rows: {
          id: string;
          item: DocumentSourceItem;
          failure: string | null;
        }[] = [];
        const renamed: { document: string; name: string; link: string }[] = [];
        let discovered = 0;
        let moved = 0;
        let skipped = 0;
        let changedCount = 0;
        let failed = 0;
        for (const item of listed) {
          const id = sourceItemId(payload.sourceId, item.id);
          const old = olds.get(id);
          if ((!old || old.state === "withdrawn") && held >= maxDocuments) {
            limited = true;
            break;
          }
          if (!old || old.state === "withdrawn") held++;
          const format = sourceFormat(item);
          const failure =
            (item.size ?? 0) > KNOWLEDGE_FILE_MAX_BYTES
              ? "knowledge_file_over_limit"
              : !format
                ? "knowledge_file_format_unsupported"
                : !formats.includes(format)
                  ? "knowledge_file_format_unavailable"
                  : null;
          const same = old?.version === item.version && old.state !== "withdrawn";
          changed ||= !same || old?.name !== item.name || old.path !== item.path;
          rows.push({ id, item, failure });
          if (old?.document_id && same)
            renamed.push({
              document: old.document_id,
              name: item.name,
              link: item.originLink ?? ""
            });
          if (
            (!same && !failure) ||
            (same && old.state === "discovered" && old.enqueued_run_id !== payload.syncRunId)
          )
            queued.push(id);
          if (!old) discovered++;
          if (old && !same) changedCount++;
          if (same && old && (old.name !== item.name || old.path !== item.path)) moved++;
          if (same) skipped++;
          if (!same && failure) failed++;
        }
        if (rows.length) {
          const column = <T>(pick: (row: (typeof rows)[number]) => T) => rows.map(pick);
          // Whether the stored row holds this version is read from the row itself, so the
          // statement needs no flag per item.
          await sql.run(
            `insert into catalyst_kb.source_items
            (id, source_id, item_id, version, path, name, mime, size, modified_at, origin_link, state, failure_code, parents, seen_run_id)
            select v.id,$1::text,v.item,v.version,v.path,v.name,v.mime,v.size,v.modified::timestamptz,nullif(v.link,''),case when v.failure<>'' then 'failed' else 'discovered' end,nullif(v.failure,''),v.parents::jsonb,$2::text
            from unnest($3::text[],$4::text[],$5::text[],$6::text[],$7::text[],$8::text[],$9::bigint[],$10::text[],$11::text[],$12::text[],$13::text[]) as v(id,item,version,path,name,mime,size,modified,link,failure,parents)
            on conflict (source_id,item_id) do update set parents=excluded.parents, seen_run_id=excluded.seen_run_id,withdrawn_at=null,purged_at=null,version=excluded.version, path=excluded.path, name=excluded.name, mime=excluded.mime, size=excluded.size, modified_at=excluded.modified_at, origin_link=excluded.origin_link,
            state=case when source_items.version=excluded.version and source_items.state<>'withdrawn' then source_items.state else excluded.state end,
            failure_code=case when source_items.version=excluded.version and source_items.state<>'withdrawn' then source_items.failure_code else excluded.failure_code end,
            attempts=case when source_items.version=excluded.version and source_items.state<>'withdrawn' then source_items.attempts else 0 end,
            enqueued_run_id=case when source_items.version=excluded.version and source_items.state<>'withdrawn' then source_items.enqueued_run_id else null end,
            fetch_job_id=case when source_items.version=excluded.version and source_items.state<>'withdrawn' and source_items.enqueued_run_id=excluded.seen_run_id then source_items.fetch_job_id else null end,
            changed_at=case when source_items.version <> excluded.version or source_items.path <> excluded.path or source_items.name <> excluded.name then now() else source_items.changed_at end`,
            [
              payload.sourceId,
              payload.syncRunId,
              column((row) => row.id),
              column((row) => row.item.id),
              column((row) => row.item.version),
              column((row) => row.item.path),
              column((row) => row.item.name),
              column((row) => row.item.mime),
              // A source that lists no size keeps 0; the fetch's bytes decide (CS-16).
              column((row) => row.item.size ?? 0),
              column((row) => row.item.modifiedAt),
              column((row) => row.item.originLink ?? ""),
              column((row) => row.failure ?? ""),
              column((row) => JSON.stringify(row.item.parents))
            ]
          );
        }
        if (renamed.length)
          await sql.run(
            `update catalyst_kb.documents d set title=v.name,file_name=v.name,origin_link=nullif(v.link,'')
            from unnest($1::text[],$2::text[],$3::text[]) as v(id,name,link) where d.id=v.id`,
            [
              renamed.map((row) => row.document),
              renamed.map((row) => row.name),
              renamed.map((row) => row.link)
            ]
          );
        await sql.run(
          `update catalyst_kb.sync_runs set discovered=discovered+$2::int, changed=changed+$3::int, moved=moved+$4::int, skipped=skipped+$5::int, failed=failed+$6::int where id=$1::text`,
          [payload.syncRunId, discovered, changedCount, moved, skipped, failed]
        );
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
    /** How many items this run has queued for fetching. */
    async enqueuedCount(payload: KnowledgeSyncJobPayload) {
      return change(async (sql) => {
        const [row] = z
          .array(z.object({ n: z.number().int() }))
          .parse(
            await sql.run(
              "select count(*)::int as n from catalyst_kb.source_items where source_id=$1::text and enqueued_run_id=$2::text",
              [payload.sourceId, payload.syncRunId]
            )
          );
        return row?.n ?? 0;
      });
    },
    /**
     * A first sync whose listing is complete and that left items unqueued at the stop waits
     * for one confirmation (KB-ISO-1b): it keeps what the whole pass holds, its items and their
     * listed bytes by format, as `stop` of its progress. Answers whether it stopped now.
     */
    async stopFirstPass(payload: KnowledgeSyncJobPayload, at: number) {
      return change(async (sql) => {
        const [run] = z
          .array(z.object({ mode: z.string(), cursor_after: z.string().nullable() }))
          .parse(
            await sql.run(
              "select mode,cursor_after from catalyst_kb.sync_runs where id=$1::text and state='running' for update",
              [payload.syncRunId]
            )
          );
        if (!run || run.mode !== "initial" || run.cursor_after === null) return false;
        const progress = progressSchema.parse(JSON.parse(run.cursor_after));
        const listed =
          progress.complete && (progress.listing !== true || progress.reconciled === true);
        if (!listed || progress.stop) return false;
        const left = await sql.run(
          "select 1 from catalyst_kb.source_items where source_id=$1::text and state='discovered' and enqueued_run_id is distinct from $2::text limit 1",
          [payload.sourceId, payload.syncRunId]
        );
        if (!left.length) return false;
        // Few groups however large the source: a format follows from MIME type and extension.
        const groups = z
          .array(
            z.object({
              mime: z.string(),
              ext: z.string().nullable(),
              n: z.number().int(),
              unsized: z.number().int(),
              bytes: z.coerce.number()
            })
          )
          .parse(
            await sql.run(
              "select mime,lower(substring(name from '\\.([^.]*)$')) as ext,count(*)::int as n,(count(*) filter (where size=0))::int as unsized,coalesce(sum(size),0)::text as bytes from catalyst_kb.source_items where source_id=$1::text and seen_run_id=$2::text and state in ('discovered','fetched') group by 1,2",
              [payload.sourceId, payload.syncRunId]
            )
          );
        const stop = emptyFirstPassStop(at);
        for (const group of groups) {
          const format = sourceFormat({ name: `item.${group.ext ?? ""}`, mime: group.mime });
          if (!format) continue;
          tallyFirstPass(
            stop,
            format,
            group.bytes + group.unsized * UNSIZED_ITEM_BYTES[format],
            group.n
          );
        }
        await sql.run("update catalyst_kb.sync_runs set cursor_after=$2::text where id=$1::text", [
          payload.syncRunId,
          JSON.stringify({ ...progress, stop })
        ]);
        return true;
      });
    },
    async queued(payload: KnowledgeSyncJobPayload, ids: string[]) {
      return change(async (sql) => {
        await sql.run(
          "update catalyst_kb.source_items set enqueued_run_id=$2::text where id=any($1::text[]) and source_id=$3::text and exists(select 1 from catalyst_kb.sync_runs where id=$2::text and state='running')",
          [ids, payload.syncRunId, payload.sourceId]
        );
      });
    },
    /**
     * Takes a group of items for one fetch job in one statement, those still waiting to be
     * fetched that no other job holds. Answered in the order of `ids`. No document lock: the
     * claim writes only the items' own rows, and everything that decides on them re-reads
     * them under its own lock (`fetchedMany`).
     */
    async claimMany(ids: readonly string[], sourceId: string, jobId: string) {
      return change(async (sql) => {
        const rows = z.array(itemSchema).parse(
          await sql.run(
            `update catalyst_kb.source_items set fetch_job_id=$3::text
         where id=any($1::text[]) and source_id=$2::text and state='discovered'
           and (fetch_job_id is null or fetch_job_id=$3::text)
         returning ${ITEM_COLUMNS}`,
            [[...ids], sourceId, jobId]
          )
        );
        const order = new Map(ids.map((id, index) => [id, index]));
        return rows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
      });
    },
    /** The items of a group as they stand, for those a batch finds fetched already. */
    async items(ids: readonly string[], sourceId: string) {
      return change(async (sql) =>
        z
          .array(itemSchema)
          .parse(
            await sql.run(
              `select ${ITEM_COLUMNS} from catalyst_kb.source_items where id=any($1::text[]) and source_id=$2::text`,
              [[...ids], sourceId]
            )
          )
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
    /**
     * Adopts a group of fetched copies in one transaction: each item whose version and claim
     * are still the fetch job's gets its document and turns `fetched`, in the same statements
     * for all. Answers the ids of the items it adopted; the others keep their state and the
     * caller releases their copies. Same checks, in the same lock order, as one item alone:
     * the documents, the contents of the new and of the former documents (by hash), the items.
     */
    async fetchedMany(
      payload: KnowledgeSyncJobPayload,
      entries: readonly {
        item: SourceItem;
        document: KnowledgeFetchedDocument;
        byteSize: number;
      }[],
      jobId: string
    ): Promise<Set<string>> {
      if (!entries.length) return new Set();
      return change(async (sql) => {
        await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
        const itemIds = entries.map((entry) => entry.item.id);
        // Content completion updates open-change projections on its items. Lock both
        // hashes before the item, matching the indexer's content -> item order.
        await sql.run(
          "select sha256 from catalyst_kb.contents where sha256=any($1::text[]) or sha256 in (select d.content_sha256 from catalyst_kb.documents d where d.source_item_id=any($2::text[])) order by sha256 for share",
          [[...new Set(entries.map((entry) => entry.document.contentSha256))], itemIds]
        );
        const held = new Map(
          z
            .array(itemSchema)
            .parse(
              await sql.run(
                `select ${ITEM_COLUMNS} from catalyst_kb.source_items where id=any($1::text[]) order by id for update`,
                [itemIds]
              )
            )
            .map((row) => [row.id, row])
        );
        const adoptable = entries.filter((entry) => {
          const row = held.get(entry.item.id);
          return (
            row !== undefined &&
            row.version === entry.item.version &&
            row.state === "discovered" &&
            row.fetch_job_id === jobId
          );
        });
        if (!adoptable.length) return new Set();
        const active = await sql.run(
          "select id from catalyst_kb.sync_runs where id=$1::text and state='running'",
          [payload.syncRunId]
        );
        if (!active.length) return new Set();
        // A cleanup that won before this transaction must never be given a new document.
        const copies = new Map(
          (
            await stores.files.listOwnedManagedFilesById({
              clientInstanceId: runtime.clientInstanceId,
              owner: { kind: "knowledge_base", id: payload.knowledgeBaseId },
              fileIds: adoptable.map((entry) => asManagedFileId(entry.document.fileId))
            })
          ).map((copy) => [copy.id as string, copy])
        );
        for (const entry of adoptable) {
          const copy = copies.get(entry.document.fileId);
          if (!copy || copy.status === "deleted")
            throw new AppError("CONFLICT", "The source copy was released before its handoff");
        }
        const column = <T>(pick: (entry: (typeof adoptable)[number]) => T) => adoptable.map(pick);
        await sql.run(
          "insert into catalyst_kb.contents (sha256,format) select * from unnest($1::text[],$2::text[]) on conflict(sha256) do nothing",
          [
            column((entry) => entry.document.contentSha256),
            column((entry) => entry.document.format)
          ]
        );
        await sql.run(
          "update catalyst_kb.contents set state='pending',failure_code=null,chunking_revision=null where sha256=any($1::text[]) and state='failed'",
          [column((entry) => entry.document.contentSha256)]
        );
        await sql.run(
          `insert into catalyst_kb.documents (id,managed_file_id,content_sha256,title,file_name,origin_link,source_item_id)
          select v.id,v.file,v.sha,v.name,v.name,nullif(v.link,''),v.item
          from unnest($1::text[],$2::text[],$3::text[],$4::text[],$5::text[],$6::text[]) as v(id,file,sha,name,link,item)
          on conflict (source_item_id) where source_item_id is not null do update set managed_file_id=excluded.managed_file_id,content_sha256=excluded.content_sha256,title=excluded.title,file_name=excluded.file_name,origin_link=excluded.origin_link,withdrawn_at=null`,
          [
            column((entry) => entry.document.id),
            column((entry) => entry.document.fileId),
            column((entry) => entry.document.contentSha256),
            column((entry) => held.get(entry.item.id)?.name ?? entry.item.name),
            column((entry) => entry.document.originLink ?? ""),
            column((entry) => entry.item.id)
          ]
        );
        await sql.run(
          `update catalyst_kb.source_items i set state='fetched',fetch_job_id=null,attempts=i.attempts+1,failure_code=null,document_id=v.document,fetched_at=now(),changed_at=now(),withdrawn_at=null,purged_at=null
          from unnest($1::text[],$2::text[]) as v(id,document) where i.id=v.id`,
          [column((entry) => entry.item.id), column((entry) => entry.document.id)]
        );
        await sql.run(
          "update catalyst_kb.sync_runs set added=added+$2::int,bytes_fetched=bytes_fetched+$3::bigint where id=$1::text",
          [
            payload.syncRunId,
            adoptable.filter((entry) => !held.get(entry.item.id)?.document_id).length,
            adoptable.reduce((sum, entry) => sum + entry.byteSize, 0)
          ]
        );
        return new Set(adoptable.map((entry) => entry.item.id));
      });
    },
    /** What the index job needs of each item's document, by item id, in one query. */
    async indexPayloads(ids: readonly string[]) {
      return change(async (sql) => {
        const rows = z
          .array(
            z.object({
              source_item_id: z.string(),
              content_sha256: z.string(),
              managed_file_id: z.string(),
              state: z.enum(KNOWLEDGE_CONTENT_STATES)
            })
          )
          .parse(
            await sql.run(
              "select d.source_item_id,d.content_sha256,d.managed_file_id,c.state from catalyst_kb.documents d join catalyst_kb.contents c on c.sha256=d.content_sha256 where d.source_item_id=any($1::text[]) and d.withdrawn_at is null",
              [[...ids]]
            )
          );
        return new Map(
          rows.map((row) => [
            row.source_item_id,
            { contentSha256: row.content_sha256, fileId: row.managed_file_id, state: row.state }
          ])
        );
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
    async finish(payload: KnowledgeSyncJobPayload, failureCode?: string, outcome?: "superseded") {
      return change(async (sql) => {
        await refreshSourceFreshness(sql, payload.sourceId, false);
        const finished = await sql.run(
          `update catalyst_kb.sync_runs set state=$2::text,failure_code=$3::text,ended_at=now() where id=$1::text and state='running' and ($2::text='superseded' or $3::text is not null or (cursor_after::jsonb->>'complete'='true' and (cursor_after::jsonb->>'listing' is distinct from 'true' or cursor_after::jsonb->>'reconciled'='true') and not exists (select 1 from catalyst_kb.source_items where source_id=$4::text and state='discovered'))) returning id`,
          [
            payload.syncRunId,
            outcome ?? (failureCode ? "failed" : "done"),
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
