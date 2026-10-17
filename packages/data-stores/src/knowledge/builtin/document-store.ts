import { z } from "zod";
import {
  AppError,
  KNOWLEDGE_CONTENT_STATES,
  KNOWLEDGE_DOCUMENT_FORMATS,
  knowledgeDocumentFailureCodeSchema,
  knowledgeDocumentStateOf,
  type BuiltinKnowledgeTarget,
  type DataStoreRecord,
  type KnowledgeChunkInput,
  type KnowledgeDocumentEntry,
  type KnowledgeDocumentStore,
  type KnowledgeRetriedDocument
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { databaseFailureError } from "../../failures";
import type { DataStoreRuntime } from "../../runtime";
import { createDocumentRemoval } from "./remove-documents";

// The documents and contents of a Knowledge Base on the built-in backend, as its index job and
// its page reach them, in the store it owns, as the platform's role. A write locks the one
// content row it changes and nothing of the Knowledge Base beside it, so the contents of one
// Knowledge Base are indexed side by side, and adding documents (which locks `documents`) is
// not held up by indexing.
//
// Sensitive data. Chunks hold the document's text; file names and titles are on `documents`.
// None of it leaves this module but through the list, which the page shows to holders of
// `knowledge_base.use`, and the index job, which writes it here.

/** How long one write of chunks may take, a large text included. */
const KNOWLEDGE_INDEX_WRITE_TIMEOUT_MS = 300_000;

/** How long a read, a failure mark or a retry may take. */
const KNOWLEDGE_DOCUMENTS_TIMEOUT_MS = 30_000;

/** How many chunks one insert statement writes. */
const CHUNK_INSERT_BATCH = 500;

const contentRow = z.object({
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  state: z.enum(KNOWLEDGE_CONTENT_STATES),
  chunking_revision: z.number().int().nullable(),
  file_id: z.string().nullable(),
  title: z.string().nullable(),
  file_name: z.string().nullable()
});

const documentRow = z.object({
  id: z.string(),
  managed_file_id: z.string(),
  file_name: z.string(),
  title: z.string(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  state: z.enum(KNOWLEDGE_CONTENT_STATES),
  failure_code: z.string().nullable(),
  added_at: z.string(),
  updated_at: z.string(),
  cursor_at: z.string()
});

const retriedRow = z.object({
  id: z.string(),
  managed_file_id: z.string(),
  content_sha256: z.string(),
  state: z.enum(KNOWLEDGE_CONTENT_STATES)
});

const failedContentRow = z.object({
  sha256: z.string(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS)
});

const cursorSchema = z.tuple([z.string().min(1).max(64), z.string().min(1).max(200)]);

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AppError(
      "VALIDATION_FAILED",
      "The cursor is not one this list answered.",
      { reason: "knowledge_cursor_invalid" },
      { exposeMessage: true }
    );
  }
}

/** An ISO time in UTC, as the API answers times. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

export function createBuiltinDocumentStore(
  runtime: DataStoreRuntime,
  target: BuiltinKnowledgeTarget
): KnowledgeDocumentStore {
  async function inStore<T>(
    what: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    work: (sql: PostgresChangeStatements) => Promise<T>
  ): Promise<T> {
    const record = await storeOf(runtime, target);
    try {
      return await runtime.server.executor.change(
        {
          ...runtime.server.asPlatform(record.location.database),
          timeoutMs,
          ...(signal ? { signal } : {})
        },
        work
      );
    } catch (error) {
      throw databaseFailureError(error, what);
    }
  }

  return {
    ...createDocumentRemoval(runtime, target),
    readContent(contentSha256, signal) {
      return inStore("Reading the content", KNOWLEDGE_DOCUMENTS_TIMEOUT_MS, signal, async (sql) => {
        const [row] = z.array(contentRow).parse(
          await sql.run(
            `select c.format, c.state, c.chunking_revision,
               d.managed_file_id as file_id, d.title, d.file_name
             from catalyst_kb.contents c
             left join lateral (
               select managed_file_id, title, file_name from catalyst_kb.documents
               where content_sha256 = c.sha256 and withdrawn_at is null
               order by added_at, id limit 1
             ) d on true
             where c.sha256 = $1::pg_catalog.text`,
            [contentSha256]
          )
        );
        if (!row) return undefined;
        return {
          contentSha256,
          format: row.format,
          state: row.state,
          ...(row.chunking_revision === null ? {} : { chunkingRevision: row.chunking_revision }),
          ...(row.file_id !== null && row.title !== null && row.file_name !== null
            ? { document: { fileId: row.file_id, title: row.title, fileName: row.file_name } }
            : {})
        };
      });
    },

    writeChunks(input, signal) {
      return inStore(
        "Writing the passages",
        KNOWLEDGE_INDEX_WRITE_TIMEOUT_MS,
        signal,
        async (sql) => {
          if (!(await lockContent(sql, input.contentSha256))) return;
          await sql.run(
            "delete from catalyst_kb.chunks where content_sha256 = $1::pg_catalog.text",
            [input.contentSha256]
          );
          for (let start = 0; start < input.chunks.length; start += CHUNK_INSERT_BATCH) {
            await insertChunks(
              sql,
              input.contentSha256,
              input.chunkingRevision,
              input.chunks.slice(start, start + CHUNK_INSERT_BATCH)
            );
          }
          await sql.run(
            `update catalyst_kb.contents
           set state = 'extracted', failure_code = null, chunking_revision = $2::pg_catalog.int4,
             extraction_revision = $3::pg_catalog.int4, page_count = $4::pg_catalog.int4,
             updated_at = now()
           where sha256 = $1::pg_catalog.text`,
            [input.contentSha256, input.chunkingRevision, input.extractionRevision, input.pageCount]
          );
        }
      );
    },

    failContent(input, signal) {
      return inStore(
        "Marking the content failed",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          if (!(await lockContent(sql, input.contentSha256))) return;
          await sql.run(
            "delete from catalyst_kb.chunks where content_sha256 = $1::pg_catalog.text",
            [input.contentSha256]
          );
          await sql.run(
            `update catalyst_kb.contents
           set state = 'failed', failure_code = $2::pg_catalog.text, updated_at = now()
           where sha256 = $1::pg_catalog.text`,
            [input.contentSha256, input.code]
          );
        }
      );
    },

    listDocuments(input, signal) {
      const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
      return inStore(
        "Listing the documents",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          const rows = z.array(documentRow).parse(
            await sql.run(
              `select d.id, d.managed_file_id, d.file_name, d.title, c.format, c.state,
               c.failure_code,
               to_char(d.added_at at time zone 'UTC', ${ISO_UTC}) as added_at,
               to_char(c.updated_at at time zone 'UTC', ${ISO_UTC}) as updated_at,
               d.added_at::pg_catalog.text as cursor_at
             from catalyst_kb.documents d
             join catalyst_kb.contents c on c.sha256 = d.content_sha256
             where d.withdrawn_at is null
               and ($1::pg_catalog.text is null
                 or (d.added_at, d.id) < ($1::pg_catalog.timestamptz, $2::pg_catalog.text))
             order by d.added_at desc, d.id desc
             limit $3::pg_catalog.int4`,
              [after?.[0] ?? null, after?.[1] ?? null, input.limit + 1]
            )
          );
          const page = rows.slice(0, input.limit);
          const last = page.at(-1);
          return {
            documents: page.map(entryOf),
            ...(rows.length > input.limit && last
              ? { nextCursor: encodeCursor(last.cursor_at, last.id) }
              : {})
          };
        }
      );
    },

    failedContents(documentIds, signal) {
      if (documentIds.length === 0) return Promise.resolve([]);
      return inStore(
        "Reading the failed contents of documents",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          const rows = z.array(failedContentRow).parse(
            await sql.run(
              `select distinct c.sha256, c.format
             from catalyst_kb.documents d
             join catalyst_kb.contents c on c.sha256 = d.content_sha256
             where d.id = any($1::pg_catalog.text[]) and d.withdrawn_at is null
               and c.state = 'failed'
             order by c.sha256`,
              [[...documentIds]]
            )
          );
          return rows.map((row) => ({ contentSha256: row.sha256, format: row.format }));
        }
      );
    },
    retryDocuments(documentIds, signal) {
      if (documentIds.length === 0) return Promise.resolve([]);
      return inStore(
        "Retrying the documents",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          await sql.run(
            `update catalyst_kb.contents c
           set state = 'pending', failure_code = null, updated_at = now()
           where c.state = 'failed' and c.sha256 in (
             select content_sha256 from catalyst_kb.documents
             where id = any($1::pg_catalog.text[]) and withdrawn_at is null
           )`,
            [[...documentIds]]
          );
          const rows = z.array(retriedRow).parse(
            await sql.run(
              `select d.id, d.managed_file_id, d.content_sha256, c.state
             from catalyst_kb.documents d
             join catalyst_kb.contents c on c.sha256 = d.content_sha256
             where d.id = any($1::pg_catalog.text[]) and d.withdrawn_at is null`,
              [[...documentIds]]
            )
          );
          const byId = new Map(rows.map((row) => [row.id, row]));
          return documentIds.flatMap((id): KnowledgeRetriedDocument[] => {
            const row = byId.get(id);
            return row
              ? [
                  {
                    id,
                    fileId: row.managed_file_id,
                    contentSha256: row.content_sha256,
                    state: knowledgeDocumentStateOf(row.state)
                  }
                ]
              : [];
          });
        }
      );
    }
  };
}

function entryOf(row: z.infer<typeof documentRow>): KnowledgeDocumentEntry {
  const code = knowledgeDocumentFailureCodeSchema.safeParse(row.failure_code);
  return {
    id: row.id,
    fileId: row.managed_file_id,
    fileName: row.file_name,
    title: row.title,
    format: row.format,
    state: knowledgeDocumentStateOf(row.state),
    ...(row.state === "failed" && code.success ? { failureCode: code.data } : {}),
    addedAt: row.added_at,
    updatedAt: row.updated_at
  };
}

/** Locks the content's row for the transaction. False where the content is gone. */
async function lockContent(sql: PostgresChangeStatements, contentSha256: string): Promise<boolean> {
  const rows = await sql.run(
    "select 1 as held from catalyst_kb.contents where sha256 = $1::pg_catalog.text for update",
    [contentSha256]
  );
  return rows.length > 0;
}

async function insertChunks(
  sql: PostgresChangeStatements,
  contentSha256: string,
  chunkingRevision: number,
  chunks: readonly KnowledgeChunkInput[]
): Promise<void> {
  if (chunks.length === 0) return;
  await sql.run(
    `insert into catalyst_kb.chunks
       (id, content_sha256, chunking_revision, position, page, heading, text, token_count)
     select $1::pg_catalog.text || ':' || $2::pg_catalog.int4 || ':' || c.position,
       $1::pg_catalog.text, $2::pg_catalog.int4, c.position, c.page, c.heading, c.text,
       c.token_count
     from unnest($3::pg_catalog.int4[], $4::pg_catalog.int4[], $5::pg_catalog.text[],
       $6::pg_catalog.text[], $7::pg_catalog.int4[])
       as c (position, page, heading, text, token_count)`,
    [
      contentSha256,
      chunkingRevision,
      { type: "integer[]", value: chunks.map((chunk) => chunk.position) },
      { type: "integer[]", value: chunks.map((chunk) => chunk.page ?? null) },
      { type: "text[]", value: chunks.map((chunk) => chunk.heading ?? null) },
      { type: "text[]", value: chunks.map((chunk) => chunk.text) },
      { type: "integer[]", value: chunks.map((chunk) => chunk.tokenCount) }
    ]
  );
}

/** The record of the store the Knowledge Base owns, while it can be written. */
async function storeOf(
  runtime: DataStoreRuntime,
  target: BuiltinKnowledgeTarget
): Promise<DataStoreRecord> {
  const record = await runtime.stores.dataStores.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: target.assetId
  });
  if (!record || record.status === "retired" || record.ownerKnowledgeBaseId === undefined) {
    throw new AppError(
      "CONFLICT",
      `Knowledge Base '${target.name}' has no store for its documents.`,
      { reason: "knowledge_store_not_ready" },
      { exposeMessage: true }
    );
  }
  return record;
}
