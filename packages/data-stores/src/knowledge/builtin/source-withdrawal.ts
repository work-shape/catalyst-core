import { z } from "zod";
import type { KnowledgeSyncJobPayload, PlatformStores } from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import type { DataStoreRuntime } from "../../runtime";
import { enqueueKnowledgeRemoval } from "../removal";

/** Called under the document lock, before the item state changes: count triggers can
 * still read its old content. Queue the existing purge before the owned commit. */
export async function withdrawSourceItems(
  sql: PostgresChangeStatements,
  stores: PlatformStores,
  runtime: DataStoreRuntime,
  payload: KnowledgeSyncJobPayload,
  ids: readonly string[]
): Promise<number> {
  if (payload.syncRunId) {
    const active = await sql.run(
      "select id from catalyst_kb.sync_runs where id=$1::text and state='running'",
      [payload.syncRunId]
    );
    if (!active.length) return 0;
  }
  // Index completion takes the content before updating item projections. Withdrawal
  // takes that same order, including while indexing a previous version finishes.
  await sql.run(
    "select c.sha256 from catalyst_kb.contents c join catalyst_kb.documents d on d.content_sha256=c.sha256 join catalyst_kb.source_items i on i.document_id=d.id where i.id=any($1::text[]) and i.source_id=$2::text and i.state<>'withdrawn' order by c.sha256 for share of c",
    [[...ids], payload.sourceId]
  );
  const documents = z.array(z.object({ id: z.string() })).parse(
    await sql.run(
      `select d.id from catalyst_kb.documents d join catalyst_kb.source_items i on i.document_id=d.id
     where i.id=any($1::text[]) and i.source_id=$2::text and i.state<>'withdrawn'`,
      [[...ids], payload.sourceId]
    )
  );
  const changed = await sql.run(
    `update catalyst_kb.source_items set state='withdrawn',failure_code=null,fetch_job_id=null,
     withdrawn_at=now(),changed_at=now(),purged_at=case when document_id is null then now() else purged_at end where id=any($1::text[]) and source_id=$2::text and state<>'withdrawn' returning id`,
    [[...ids], payload.sourceId]
  );
  await sql.run(
    "update catalyst_kb.documents set withdrawn_at=now() where id=any($1::text[]) and withdrawn_at is null",
    [documents.map((d) => d.id)]
  );
  if (documents.length)
    await enqueueKnowledgeRemoval(
      stores,
      runtime,
      {
        backend: "builtin",
        assetId: payload.knowledgeBaseId,
        name: payload.knowledgeBaseId,
        methods: []
      },
      documents.map((d) => d.id)
    );
  await sql.run("update catalyst_kb.sync_runs set withdrawn=withdrawn+$2::int where id=$1::text", [
    payload.syncRunId,
    changed.length
  ]);
  await refreshSourceFreshness(sql, payload.sourceId, changed.length > 0);
  return changed.length;
}

/** Freshness is indexed work still open, rather than the last poll's wall clock. */
export async function refreshSourceFreshness(
  sql: PostgresChangeStatements,
  sourceId: string,
  changed: boolean
) {
  await sql.run(
    `insert into catalyst_kb.source_cursors(source_id,cursor,last_change_at,oldest_open_change_at)
    select $1::text,'',case when $2::boolean then now() end,(select min(open_change_at) from catalyst_kb.source_items where source_id=$1::text and open_change_at is not null) where $2::boolean or exists(select 1 from catalyst_kb.source_cursors where source_id=$1::text)
    on conflict(source_id) do update set last_change_at=case when $2::boolean then now() else source_cursors.last_change_at end,
      oldest_open_change_at=(select min(i.open_change_at) from catalyst_kb.source_items i
       where i.source_id=$1::text and i.open_change_at is not null)`,
    [sourceId, changed]
  );
}
