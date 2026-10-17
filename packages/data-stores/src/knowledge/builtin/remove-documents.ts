import { z } from "zod";
import {
  AppError,
  type BuiltinKnowledgeTarget,
  type KnowledgeDocumentStore
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { databaseFailureError } from "../../failures";
import type { DataStoreRuntime } from "../../runtime";

/** Bounds one removal transaction, including its object deletions. A timeout retries the job. */
const REMOVE_TIMEOUT_MS = 300_000;
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
): Pick<KnowledgeDocumentStore, "withdrawDocuments" | "purgeDocuments"> {
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
    withdrawDocuments(documentIds, queue, signal) {
      return change(signal, async (sql) => {
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
    },
    purgeDocuments(input, remove, signal) {
      return change(signal, async (sql) => {
        const all = input.documentIds === undefined;
        const rows = z.array(removedRow).parse(
          await sql.run(
            `select id, managed_file_id, content_sha256 from catalyst_kb.documents
          where ($1::pg_catalog.bool or (withdrawn_at is not null and id = any($2::pg_catalog.text[])))
          order by id`,
            [all, [...(input.documentIds ?? [])]]
          )
        );
        const ids = rows.map((row) => row.id);
        // On retirement include orphan contents too. Otherwise visit only this batch's hashes.
        const contents = z.array(contentRow).parse(
          await sql.run(
            `select sha256 from catalyst_kb.contents c
          where ($1::pg_catalog.bool or sha256 = any($2::pg_catalog.text[]))
            and not exists (select 1 from catalyst_kb.documents d where d.content_sha256 = c.sha256
              and not (d.id = any($3::pg_catalog.text[])))
          order by sha256 for update`,
            [all, [...new Set(rows.map((row) => row.content_sha256))], ids]
          )
        );
        const hashes = contents.map((row) => row.sha256);
        const [count] = z.array(countRow).parse(
          await sql.run(
            `select count(*)::pg_catalog.int4 as count
          from catalyst_kb.chunks where content_sha256 = any($1::pg_catalog.text[])`,
            [hashes]
          )
        );
        const fileRows = z.array(z.object({ managed_file_id: z.string() })).parse(
          await sql.run(
            `select distinct managed_file_id from catalyst_kb.documents d
          where id = any($1::pg_catalog.text[]) and not exists (
            select 1 from catalyst_kb.documents kept where kept.managed_file_id = d.managed_file_id
              and not (kept.id = any($1::pg_catalog.text[])))`,
            [ids]
          )
        );
        await remove({
          fileIds: fileRows.map((row) => row.managed_file_id),
          contentSha256s: hashes,
          documents: rows.length,
          chunks: count?.count ?? 0
        });
        await sql.run("delete from catalyst_kb.documents where id = any($1::pg_catalog.text[])", [
          ids
        ]);
        await sql.run(
          "delete from catalyst_kb.contents where sha256 = any($1::pg_catalog.text[])",
          [hashes]
        );
      });
    }
  };
}
