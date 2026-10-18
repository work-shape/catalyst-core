import type { KnowledgeSources, KnowledgeListingMode } from "../source-port";
import { z } from "zod";
import {
  AppError,
  knowledgeSourceItemsInputSchema,
  knowledgeSourceItemsOutputSchema,
  knowledgeSourcesOutputSchema,
  knowledgeLocateOutputSchema,
  knowledgeRetryInputSchema,
  KNOWLEDGE_SOURCE_ITEM_SHOWN_STATES,
  KNOWLEDGE_DOCUMENT_FORMATS,
  type KnowledgeSyncJobPayload,
  knowledgeFetchJob,
  knowledgeSourceKey,
  type KnowledgeFiles
} from "@work-shape/catalyst-core";
import { discardUnusableKnowledgeExtraction } from "../index-extraction";
import type { DataStoreRuntime } from "../../runtime";
import { createSourceStore, syncResult } from "./source-store";
import { enqueueSourceSync, sourceSyncStarted } from "./source-lifecycle";

// All operations use the same derived state: the item owns fetch state, the content owns indexing.
const JOIN = `from catalyst_kb.source_items i left join catalyst_kb.documents d on d.id=i.document_id left join catalyst_kb.contents c on c.sha256=d.content_sha256`;
const STATE = `case when i.state='fetched' then case c.state when 'extracted' then 'indexed' when 'failed' then 'failed' else 'fetched' end else i.state end`;
const FAILURE = `case when i.state='failed' then i.failure_code when i.state='fetched' and c.state='failed' then c.failure_code end`;
const rowSchema = z.object({
  id: z.string(),
  item_id: z.string(),
  source_id: z.string(),
  name: z.string(),
  path: z.string(),
  state: z.string(),
  failure_code: z.string().nullable(),
  document_id: z.string().nullable(),
  origin_link: z.string().nullable(),
  changed_at: z.coerce.date(),
  discovered_at: z.coerce.date(),
  fetched_at: z.coerce.date().nullable(),
  withdrawn_at: z.coerce.date().nullable(),
  purged_at: z.coerce.date().nullable()
});
const SELECT = `select i.id,i.item_id,i.source_id,i.name,i.path,i.document_id,i.origin_link,i.changed_at,i.discovered_at,i.fetched_at,i.withdrawn_at,i.purged_at,${STATE} as state,${FAILURE} as failure_code ${JOIN}`;
// Keep a bounded page in memory. A retry by code walks every matching item in pages.
const RETRY_BATCH_ITEMS = 100;

export function createKnowledgeSources(runtime: DataStoreRuntime): KnowledgeSources {
  const store = (id: string, signal: AbortSignal) => createSourceStore(runtime, id, signal);
  return {
    async start(payload: KnowledgeSyncJobPayload, mode: KnowledgeListingMode, signal: AbortSignal) {
      return store(payload.knowledgeBaseId, signal).change(async (sql) => {
        await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
        const bound = createSourceStore(
          runtime,
          payload.knowledgeBaseId,
          signal,
          runtime.stores,
          sql
        );
        const run = await bound.start(payload, mode);
        if (run.operationRunId === payload.operationRunId)
          await runtime.stores.transaction(async (stores) => {
            await enqueueSourceSync(stores, runtime, payload);
            if (run.created) await sourceSyncStarted(stores, runtime, payload);
          });
        return run.operationRunId;
      });
    },
    async sources(
      id: string,
      sources: readonly { id: string; connection: string }[],
      signal: AbortSignal
    ) {
      return store(id, signal).change(async (sql) => {
        const result = [];
        for (const source of sources) {
          const groups = z
            .array(z.object({ state: z.string(), code: z.string().nullable(), n: z.number() }))
            .parse(
              await sql.run(
                "select state,nullif(failure_code,'') as code,items::int as n from catalyst_kb.source_counts where source_id=$1::text and items>0",
                [source.id]
              )
            );
          const items = { discovered: 0, fetched: 0, indexed: 0, failed: 0, withdrawn: 0 };
          for (const state of Object.keys(items)) {
            const key = z.enum(KNOWLEDGE_SOURCE_ITEM_SHOWN_STATES).parse(state);
            items[key] = groups.filter((g) => g.state === key).reduce((n, g) => n + g.n, 0);
          }
          const rows = await sql.run(
            "select * from catalyst_kb.sync_runs where source_id=$1::text order by started_at desc limit 2",
            [source.id]
          );
          const runs = rows.map(syncResult),
            running = runs.find((r) => r.state === "running"),
            last = runs.find((r) => r.state !== "running");
          const elapsed = running
            ? Math.max((Date.now() - Date.parse(running.startedAt)) / 60000, 1 / 60)
            : 0;
          const complete = running
            ? running.counts.added + running.counts.skipped + running.counts.failed
            : 0;
          const rate = running ? complete / elapsed : 0;
          const [cursor] = z
            .array(
              z.object({
                last_change_at: z.coerce.date().nullable(),
                oldest_open_change_at: z.coerce.date().nullable()
              })
            )
            .parse(
              await sql.run(
                "select last_change_at,oldest_open_change_at from catalyst_kb.source_cursors where source_id=$1::text",
                [source.id]
              )
            );
          result.push({
            id: source.id,
            connection: source.connection,
            items,
            failures: groups
              .filter((g) => g.state === "failed" && g.code)
              .map((g) => ({ code: g.code, count: g.n })),
            ...(running
              ? {
                  running: {
                    syncRunId: running.syncRunId,
                    mode: running.mode,
                    startedAt: running.startedAt,
                    itemsPerMinute: rate,
                    ...(rate > 0
                      ? {
                          estimatedEndAt: new Date(
                            Date.now() + (items.discovered / rate) * 60000
                          ).toISOString()
                        }
                      : {})
                  }
                }
              : {}),
            ...(last ? { last } : {}),
            ...(cursor?.last_change_at
              ? { lastChangeAt: cursor.last_change_at.toISOString() }
              : {}),
            ...(cursor?.oldest_open_change_at
              ? { oldestOpenChangeAt: cursor.oldest_open_change_at.toISOString() }
              : {})
          });
        }
        return knowledgeSourcesOutputSchema.parse({ sources: result });
      });
    },
    async items(
      id: string,
      input: z.infer<typeof knowledgeSourceItemsInputSchema>,
      signal: AbortSignal
    ) {
      let cursor: { at: string; id: string } | undefined;
      if (input.cursor)
        try {
          cursor = z
            .object({ at: z.iso.datetime(), id: z.string() })
            .parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString()));
        } catch {
          throw new AppError("VALIDATION_FAILED", "The source item cursor is invalid");
        }
      const limit = input.limit ?? 50;
      return store(id, signal).change(async (sql) => {
        const rows = z
          .array(rowSchema)
          .parse(
            await sql.run(
              `${SELECT} where i.source_id=$1::text and ($2::text is null or ${STATE}=$2::text) and ($3::text is null or ${FAILURE}=$3::text) and ($4::timestamptz is null or i.changed_at<$4::timestamptz or (i.changed_at=$4::timestamptz and i.id>$5::text)) order by i.changed_at desc,i.id limit $6::int`,
              [
                input.source,
                input.state ?? null,
                input.failureCode ?? null,
                cursor?.at ?? null,
                cursor?.id ?? null,
                limit + 1
              ]
            )
          );
        const page = rows.slice(0, limit),
          last = page.at(-1);
        return knowledgeSourceItemsOutputSchema.parse({
          items: page.map((row) => ({
            id: row.id,
            itemId: row.item_id,
            name: row.name,
            path: row.path,
            state: row.state,
            ...(row.failure_code ? { failureCode: row.failure_code } : {}),
            ...(row.document_id ? { documentId: row.document_id } : {}),
            ...(row.origin_link ? { originLink: row.origin_link } : {}),
            changedAt: row.changed_at.toISOString()
          })),
          ...(rows.length > limit && last
            ? {
                nextCursor: Buffer.from(
                  JSON.stringify({ at: last.changed_at.toISOString(), id: last.id })
                ).toString("base64url")
              }
            : {})
        });
      });
    },
    async locate(id: string, itemId: string, signal: AbortSignal) {
      return store(id, signal).change(async (sql) => {
        const [row] = z
          .array(rowSchema)
          .parse(await sql.run(`${SELECT} where i.id=$1::text`, [itemId]));
        if (!row) throw new AppError("NOT_FOUND", "The source item is not available");
        return knowledgeLocateOutputSchema.parse({
          sourceItemId: row.id,
          source: row.source_id,
          itemId: row.item_id,
          state: row.state,
          discoveredAt: row.discovered_at.toISOString(),
          ...(row.fetched_at ? { fetchedAt: row.fetched_at.toISOString() } : {}),
          ...(row.withdrawn_at ? { withdrawnAt: row.withdrawn_at.toISOString() } : {}),
          ...(row.purged_at ? { purgedAt: row.purged_at.toISOString() } : {})
        });
      });
    },
    async syncedDocumentIds(id: string, ids: string[], signal: AbortSignal) {
      return store(id, signal).change(async (sql) =>
        z
          .array(z.object({ id: z.string() }))
          .parse(
            await sql.run(
              "select id from catalyst_kb.documents where id=any($1::text[]) and source_item_id is not null",
              [ids]
            )
          )
          .map((row) => row.id)
      );
    },
    async retry(
      id: string,
      input: z.infer<typeof knowledgeRetryInputSchema>,
      payload: KnowledgeSyncJobPayload,
      signal: AbortSignal,
      files: KnowledgeFiles,
      reprocess = false
    ) {
      let after = "",
        queued = 0;
      for (;;) {
        const ids = await store(id, signal).change(async (sql) => {
          await sql.run("lock table catalyst_kb.documents in share row exclusive mode");
          const rows = z
            .array(z.object({ id: z.string() }))
            .parse(
              await sql.run(
                `${SELECT} where i.id>$1::text and ($7::boolean or ${STATE}='failed') and i.state<>'withdrawn' and ($2::text is null or i.source_id=$2::text) and ($3::text[] is null or i.id=any($3::text[])) and ($4::text is null or ${FAILURE}=$4::text) and ($5::text[] is null or d.id=any($5::text[])) order by i.id limit $6::int`,
                [
                  after,
                  payload.sourceId,
                  "sourceItemIds" in input ? input.sourceItemIds : null,
                  "failureCode" in input ? input.failureCode : null,
                  "documentIds" in input ? input.documentIds : null,
                  RETRY_BATCH_ITEMS,
                  reprocess
                ]
              )
            );
          const ids = rows.map((r) => r.id);
          if (!ids.length) return ids;
          await sql.run(
            "select c.sha256 from catalyst_kb.contents c join catalyst_kb.documents d on d.content_sha256=c.sha256 join catalyst_kb.source_items i on i.document_id=d.id where i.id=any($1::text[]) order by c.sha256 for share of c",
            [ids]
          );
          if (reprocess)
            await sql.run(
              "update catalyst_kb.contents set state='pending',failure_code=null where sha256 in (select d.content_sha256 from catalyst_kb.documents d join catalyst_kb.source_items i on i.document_id=d.id where i.id=any($1::text[]))",
              [ids]
            );
          const bound = createSourceStore(runtime, id, signal, runtime.stores, sql);
          const run = await bound.start(payload, "full");
          const current = {
            ...payload,
            syncRunId: run.syncRunId,
            operationRunId: run.operationRunId
          };
          if (run.created)
            await sql.run(
              "update catalyst_kb.sync_runs set cursor_after=$2::text where id=$1::text",
              [run.syncRunId, JSON.stringify({ complete: true })]
            );
          const failed = z
            .array(z.object({ sha256: z.string(), format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS) }))
            .parse(
              await sql.run(
                `select distinct c.sha256,c.format ${JOIN} where i.id=any($1::text[]) and c.state='failed'`,
                [ids]
              )
            );
          for (const content of failed)
            await discardUnusableKnowledgeExtraction(files, {
              knowledgeBaseId: id,
              contentSha256: content.sha256
            });
          await sql.run(
            "update catalyst_kb.source_items set state='discovered',attempts=0,failure_code=null,enqueued_run_id=$2::text,fetch_job_id=null,changed_at=now() where id=any($1::text[])",
            [ids, run.syncRunId]
          );
          await runtime.stores.transaction(async (stores) => {
            await stores.jobs.enqueue(
              knowledgeFetchJob,
              { ...current, sourceItemIds: ids },
              {
                clientInstanceId: runtime.clientInstanceId,
                subject: id,
                concurrencyKey: knowledgeSourceKey(id, payload.sourceId)
              }
            );
            if (run.created) await sourceSyncStarted(stores, runtime, current);
          });
          return ids;
        });
        queued += ids.length;
        if (ids.length < RETRY_BATCH_ITEMS) return queued;
        after = ids.at(-1) ?? after;
      }
    }
  };
}
