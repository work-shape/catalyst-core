import { z } from "zod";
import type { KnowledgePageCacheStore } from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

// The rows of the page cache in the Knowledge Base's own store (KB-13b). A row names the object
// that holds a fetched original; the caller puts and deletes the objects. A row is written only
// while its document is live, under a share lock on the document's row and its item's, so a
// withdrawal waits for the write or the write sees the withdrawal; and it is deleted only once
// its object is gone, so the rows never count fewer bytes than the store holds.

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

type Change = <T>(
  work: (sql: PostgresChangeStatements) => Promise<T>,
  signal?: AbortSignal
) => Promise<T>;

/** A live document of a connector source: withdrawn, removed and Workflow-fed ones are not. */
const LIVE = `d.withdrawn_at is null and i.state <> 'withdrawn' and i.source_id not like 'workflow:%'`;

const readRow = z.object({
  source_id: z.string(),
  item_id: z.string(),
  version: z.string(),
  content_sha256: z.string(),
  object_key: z.string().nullable(),
  byte_size: z.coerce.number().nullable(),
  expires_at: z.string().nullable()
});
const entryRow = z.object({
  document_id: z.string(),
  object_key: z.string(),
  byte_size: z.coerce.number()
});

export function createKnowledgePageCacheStore(change: Change): KnowledgePageCacheStore {
  return {
    read(documentId, signal) {
      return change(async (sql) => {
        const [row] = z.array(readRow).parse(
          await sql.run(
            `select i.source_id, i.item_id, i.version, d.content_sha256,
              p.object_key, p.byte_size::int8::text as byte_size,
              to_char(p.expires_at at time zone 'UTC', ${ISO_UTC}) as expires_at
            from catalyst_kb.documents d
            join catalyst_kb.source_items i on i.id = d.source_item_id
            left join catalyst_kb.page_cache p on p.document_id = d.id
              and p.content_sha256 = d.content_sha256 and p.expires_at > now()
            where d.id = $1::text and ${LIVE}`,
            [documentId]
          )
        );
        if (!row) return undefined;
        return {
          source: {
            sourceId: row.source_id,
            itemId: row.item_id,
            version: row.version,
            contentSha256: row.content_sha256
          },
          ...(row.object_key !== null && row.byte_size !== null && row.expires_at !== null
            ? {
                cached: {
                  objectKey: row.object_key,
                  byteSize: row.byte_size,
                  expiresAt: row.expires_at
                }
              }
            : {})
        };
      }, signal);
    },
    put(input, remove, signal) {
      return change(async (sql) => {
        // Held against a withdrawal or a purge of the document until this commits.
        const live = await sql.run(
          `select d.id from catalyst_kb.documents d
          join catalyst_kb.source_items i on i.id = d.source_item_id
          where d.id = $1::text and d.content_sha256 = $2::text and ${LIVE}
          for share of d, i`,
          [input.documentId, input.contentSha256]
        );
        if (!live.length) return { kept: false as const };
        // One writer of the cache at a time, so the bound holds across concurrent opens.
        await sql.script("lock table catalyst_kb.page_cache in share row exclusive mode");
        const replaced = z
          .array(z.object({ object_key: z.string() }))
          .parse(
            await sql.run(
              "select object_key from catalyst_kb.page_cache where document_id = $1::text",
              [input.documentId]
            )
          )
          .map((row) => row.object_key)
          .filter((key) => key !== input.objectKey);
        const [written] = z.array(z.object({ expires_at: z.string() })).parse(
          await sql.run(
            `insert into catalyst_kb.page_cache
              (document_id, content_sha256, object_key, byte_size, cached_at, expires_at)
            values ($1::text, $2::text, $3::text, $4::int8, now(),
              now() + make_interval(secs => $5::float8 / 1000))
            on conflict (document_id) do update set content_sha256 = excluded.content_sha256,
              object_key = excluded.object_key, byte_size = excluded.byte_size,
              cached_at = excluded.cached_at, expires_at = excluded.expires_at
            returning to_char(expires_at at time zone 'UTC', ${ISO_UTC}) as expires_at`,
            [
              input.documentId,
              input.contentSha256,
              input.objectKey,
              input.byteSize,
              input.lifetimeMs
            ]
          )
        );
        // The replaced object goes now; one that stays is left to the document's purge.
        if (replaced.length) await remove(replaced);
        // The oldest fetches go first until the cache is within its bound.
        const others = z.array(entryRow).parse(
          await sql.run(
            `select document_id, object_key, byte_size::int8::text as byte_size
            from catalyst_kb.page_cache where document_id <> $1::text
            order by cached_at, document_id`,
            [input.documentId]
          )
        );
        let total = input.byteSize + others.reduce((sum, row) => sum + row.byte_size, 0);
        const evict: z.infer<typeof entryRow>[] = [];
        for (const row of others) {
          if (total <= input.limitBytes) break;
          evict.push(row);
          total -= row.byte_size;
        }
        const stayed = new Set(
          evict.length ? await remove(evict.map((row) => row.object_key)) : []
        );
        const gone = evict.filter((row) => !stayed.has(row.object_key));
        if (gone.length)
          await sql.run(
            `delete from catalyst_kb.page_cache p using unnest($1::text[], $2::text[]) e(document_id, object_key)
            where p.document_id = e.document_id and p.object_key = e.object_key`,
            [gone.map((row) => row.document_id), gone.map((row) => row.object_key)]
          );
        return {
          kept: true as const,
          expiresAt: written?.expires_at ?? new Date().toISOString(),
          evicted: gone.length
        };
      }, signal);
    },
    expired(limit, signal) {
      return change(
        async (sql) =>
          z
            .array(entryRow)
            .parse(
              // Also an entry of a document withdrawn, removed or changed since: never served, so
              // it goes with the next expiry rather than staying to its own.
              await sql.run(
                `select p.document_id, p.object_key, p.byte_size::int8::text as byte_size
              from catalyst_kb.page_cache p
              left join catalyst_kb.documents d on d.id = p.document_id
              left join catalyst_kb.source_items i on i.id = d.source_item_id
              where p.expires_at <= now() or d.content_sha256 is distinct from p.content_sha256
                or not coalesce(${LIVE}, false)
              order by p.expires_at, p.document_id limit $1::int4`,
                [limit]
              )
            )
            .map((row) => ({ documentId: row.document_id, objectKey: row.object_key })),
        signal
      );
    },
    forget(entries, signal) {
      return change(async (sql) => {
        if (!entries.length) return;
        await sql.run(
          `delete from catalyst_kb.page_cache p using unnest($1::text[], $2::text[]) e(document_id, object_key)
          where p.document_id = e.document_id and p.object_key = e.object_key`,
          [entries.map((entry) => entry.documentId), entries.map((entry) => entry.objectKey)]
        );
      }, signal);
    },
    forgetDocuments(documentIds, signal) {
      return change(async (sql) => {
        if (!documentIds.length) return 0;
        const rows = await sql.run(
          "delete from catalyst_kb.page_cache where document_id = any($1::text[]) returning document_id",
          [[...documentIds]]
        );
        return rows.length;
      }, signal);
    },
    nextExpiry(signal) {
      return change(async (sql) => {
        const [row] = z.array(z.object({ next: z.string().nullable() })).parse(
          await sql.run(
            `select to_char(min(expires_at) at time zone 'UTC', ${ISO_UTC}) as next
            from catalyst_kb.page_cache`
          )
        );
        return row?.next ?? undefined;
      }, signal);
    }
  };
}
