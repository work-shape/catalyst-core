import { z } from "zod";
import {
  AppError,
  type BuiltinKnowledgeTarget,
  type KnowledgeDocumentStore,
  type KnowledgePurgeCursor,
  type KnowledgePurgePage
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { databaseFailureError } from "../../failures";
import type { DataStoreRuntime } from "../../runtime";

/**
 * Bounds one transaction: a withdrawal, or one page of a purge with its object deletions (at
 * most three object calls per document). A timeout rolls the page back and retries the job.
 */
const REMOVE_TIMEOUT_MS = 120_000;
const removedRow = z.object({
  id: z.string(),
  managed_file_id: z.string(),
  content_sha256: z.string()
});
const contentRow = z.object({ sha256: z.string() });
const countRow = z.object({ count: z.number().int() });

// The same lock as addKnowledgeDocuments: no add can acquire content while its last document
// and extraction result are being deleted. Index writes lock contents; deleting a content
// waits for them and cascades to chunks (and their generation vectors).
export function createDocumentRemoval(
  runtime: DataStoreRuntime,
  target: BuiltinKnowledgeTarget
): Pick<KnowledgeDocumentStore, "withdrawDocuments" | "purgeDocumentPage"> {
  async function change<T>(
    signal: AbortSignal | undefined,
    work: (sql: PostgresChangeStatements) => Promise<T>
  ): Promise<T> {
    const record = await runtime.stores.dataStores.getDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: target.assetId
    });
    if (!record || record.ownerKnowledgeBaseId === undefined) {
      throw new AppError("CONFLICT", "The Knowledge Base has no store for removal.");
    }
    // Removal has the same ownership boundary as the later database drop. Never purge a
    // database another record names, even when this record was repointed by an operator.
    const names = runtime.server.namesOf(target.assetId);
    const naming = await runtime.stores.dataStores.listDataStoresNaming({
      clientInstanceId: runtime.clientInstanceId,
      database: names.database,
      roles: [names.app, names.migration]
    });
    if (
      record.location.database !== names.database ||
      record.roles.app !== names.app ||
      record.roles.migration !== names.migration ||
      naming.some((other) => other.id !== record.id)
    ) {
      throw new AppError(
        "CONFLICT",
        "The Knowledge Base store names are not its own. Nothing was removed."
      );
    }
    try {
      return await runtime.server.executor.change(
        {
          ...runtime.server.asPlatform(record.location.database),
          timeoutMs: REMOVE_TIMEOUT_MS,
          ...(signal ? { signal } : {})
        },
        async (sql) => {
          await sql.script("lock table catalyst_kb.documents in share row exclusive mode");
          return work(sql);
        }
      );
    } catch (error) {
      throw databaseFailureError(error, "Removing the documents");
    }
  }
  return {
    async withdrawDocuments(documentIds, queue, signal) {
      const removed = await change(signal, async (sql) => {
        // A local removal has no durable exclusion in the source definition. Refuse the
        // whole batch: otherwise the next full pass either resurrects it or leaves a
        // fetched item pointing at a purged document. Source withdrawal owns this path.
        const synced = await sql.run(
          "select id from catalyst_kb.documents where id=any($1::text[]) and source_item_id is not null limit 1",
          [[...documentIds]]
        );
        if (synced.length) return undefined;
        const rows = await sql.run(
          `update catalyst_kb.documents set withdrawn_at = now()
          where id = any($1::pg_catalog.text[]) and withdrawn_at is null returning id`,
          [[...documentIds]]
        );
        // Queue durably before committing withdrawal. The worker takes this same lock, so it
        // cannot observe a half-finished withdrawal. If enqueue fails, withdrawal rolls back.
        if (rows.length > 0) await queue();
        return rows.length;
      });
      if (removed === undefined)
        throw new AppError(
          "CONFLICT",
          "Synced documents cannot be removed locally. Remove them in the source or change the published source boundary.",
          { reason: "knowledge_synced_document_remove_refused" },
          { exposeMessage: true }
        );
      return removed;
    },
    purgeDocumentPage(input, remove, signal) {
      return change(signal, async (sql): Promise<KnowledgePurgePage> => {
        const all = input.documentIds === undefined;
        if (input.after?.phase === "contents") {
          if (!all) return { documents: 0, chunks: 0, contents: 0 };
          return purgeUnheldContents(sql, input.after.after, input.limit, remove);
        }
        const rows = z.array(removedRow).parse(
          await sql.run(
            `select id, managed_file_id, content_sha256 from catalyst_kb.documents
          where ($1::pg_catalog.bool or (withdrawn_at is not null and id = any($2::pg_catalog.text[])))
            and id > $3::pg_catalog.text
          order by id limit $4::pg_catalog.int4`,
            [all, [...(input.documentIds ?? [])], input.after?.after ?? "", input.limit]
          )
        );
        const last = rows.at(-1)?.id;
        const next: KnowledgePurgeCursor | undefined =
          rows.length === input.limit && last !== undefined
            ? { phase: "documents", after: last }
            : all
              ? { phase: "contents" }
              : undefined;
        if (rows.length === 0)
          return { documents: 0, chunks: 0, contents: 0, ...(next ? { next } : {}) };
        const pageIds = rows.map((row) => row.id);
        // A copy another document still names goes with that document's page.
        const fileRows = z.array(z.object({ managed_file_id: z.string() })).parse(
          await sql.run(
            `select distinct managed_file_id from catalyst_kb.documents d
          where id = any($1::pg_catalog.text[]) and not exists (
            select 1 from catalyst_kb.documents kept where kept.managed_file_id = d.managed_file_id
              and not (kept.id = any($1::pg_catalog.text[])))
          order by managed_file_id`,
            [pageIds]
          )
        );
        const keptFiles = new Set(await remove.files(fileRows.map((row) => row.managed_file_id)));
        let purged = rows.filter((row) => !keptFiles.has(row.managed_file_id));
        // The contents only purged documents hold. Index writes lock their content; this waits.
        const contents = z.array(contentRow).parse(
          await sql.run(
            `select sha256 from catalyst_kb.contents c
          where sha256 = any($1::pg_catalog.text[])
            and not exists (select 1 from catalyst_kb.documents d where d.content_sha256 = c.sha256
              and not (d.id = any($2::pg_catalog.text[])))
          order by sha256 for update`,
            [[...new Set(purged.map((row) => row.content_sha256))], purged.map((row) => row.id)]
          )
        );
        const keptContents = new Set(await remove.extractions(contents.map((row) => row.sha256)));
        purged = purged.filter((row) => !keptContents.has(row.content_sha256));
        const hashes = contents.map((row) => row.sha256).filter((sha) => !keptContents.has(sha));
        await sql.run("delete from catalyst_kb.documents where id = any($1::pg_catalog.text[])", [
          purged.map((row) => row.id)
        ]);
        const chunks = await deleteContents(sql, hashes);
        return {
          documents: purged.length,
          chunks,
          contents: hashes.length,
          ...(next ? { next } : {})
        };
      });
    }
  };
}

/**
 * Deletes contents no document holds, such as those of a deletion cut short between its two
 * stores, at most `limit` after `after`. Retirement only: no add can take a content then.
 */
async function purgeUnheldContents(
  sql: PostgresChangeStatements,
  after: string | undefined,
  limit: number,
  remove: { extractions(contentSha256s: string[]): Promise<string[]> }
): Promise<KnowledgePurgePage> {
  const contents = z.array(contentRow).parse(
    await sql.run(
      `select sha256 from catalyst_kb.contents c
      where sha256 > $1::pg_catalog.text
        and not exists (select 1 from catalyst_kb.documents d where d.content_sha256 = c.sha256)
      order by sha256 limit $2::pg_catalog.int4 for update`,
      [after ?? "", limit]
    )
  );
  const last = contents.at(-1)?.sha256;
  const kept = new Set(await remove.extractions(contents.map((row) => row.sha256)));
  const hashes = contents.map((row) => row.sha256).filter((sha) => !kept.has(sha));
  const chunks = await deleteContents(sql, hashes);
  return {
    documents: 0,
    chunks,
    contents: hashes.length,
    ...(contents.length === limit && last !== undefined
      ? { next: { phase: "contents", after: last } }
      : {})
  };
}

/** Deletes contents no document names, with their chunks, and answers how many chunks went. */
async function deleteContents(
  sql: PostgresChangeStatements,
  hashes: readonly string[]
): Promise<number> {
  const [count] = z.array(countRow).parse(
    await sql.run(
      `select count(*)::pg_catalog.int4 as count
      from catalyst_kb.chunks where content_sha256 = any($1::pg_catalog.text[])`,
      [[...hashes]]
    )
  );
  await sql.run("delete from catalyst_kb.contents where sha256 = any($1::pg_catalog.text[])", [
    [...hashes]
  ]);
  return count?.count ?? 0;
}
