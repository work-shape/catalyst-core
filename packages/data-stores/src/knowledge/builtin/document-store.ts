import { decodeKnowledgeDocumentCursor, listKnowledgeDocuments } from "./document-listing";
import { hasOutdatedProcessor, processingSummary } from "./processing-summary";
import { createKnowledgeFieldStore } from "./field-store";
import { documentOfFile } from "./document-of-file";
import { processingContents } from "./processing-store";
import { visibleSourceHits } from "./source-visibility";
import { z } from "zod";
import {
  AppError,
  KNOWLEDGE_CONTENT_STATES,
  KNOWLEDGE_DOCUMENT_FORMATS,
  KNOWLEDGE_LIVE_GENERATION_STATES,
  knowledgeDocumentStateOf,
  type BuiltinKnowledgeTarget,
  type DataStoreRecord,
  type DataStoreRecordsStore,
  type KnowledgeChunkInput,
  type KnowledgeDocumentStore,
  type KnowledgeEmbeddingGeneration,
  type KnowledgeEmbeddingModel,
  type KnowledgeRetriedDocument
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { databaseFailureError } from "../../failures";
import { ensureVectorExtension } from "../../provisioning";
import type { DataStoreRuntime } from "../../runtime";
import { createDocumentRemoval } from "./remove-documents";
import { searchKnowledgeStore } from "./search";

// The documents and contents of a Knowledge Base on the built-in backend, as its index job and
// its page reach them, in the store it owns, as the platform's role. A write locks the one
// content row it changes and nothing of the Knowledge Base beside it, so the contents of one
// Knowledge Base are indexed side by side, and adding documents (which locks `documents`) is
// not held up by indexing.
//
// Sensitive data. Chunks hold the document's text; file names and titles are on `documents`.
// None of it leaves this module but through the list and the search, which answer holders of
// `knowledge_base.use`, and the index job, which writes it here and sends the passages of a
// Knowledge Base that searches by meaning to its embedding model.
//
// Embeddings (KB-5d). Each generation has its table `catalyst_kb.embeddings_<generation>`, one
// `halfvec(<dimensions>)` per chunk, dropped with its chunk. The vector type comes from
// pgvector, which only a store whose Knowledge Base searches by meaning has: provisioning makes
// it there, and starting the first generation makes sure of it once more. A `pending` content
// keeps why it waits (`KNOWLEDGE_DOCUMENT_WAIT_CODES`) in `failure_code`, which holds a
// failure code only while it is `failed`: the store's tables need no new column for it.

/** How long one write of chunks may take, a large text included. */
const KNOWLEDGE_INDEX_WRITE_TIMEOUT_MS = 300_000;

/** How long a read, a failure mark or a retry may take. */
const KNOWLEDGE_DOCUMENTS_TIMEOUT_MS = 30_000;

/** How long one search of the store may take: each of its two reads, not the embedding. */
const KNOWLEDGE_SEARCH_TIMEOUT_MS = 15_000;

/** How many chunks one insert statement writes. */
const CHUNK_INSERT_BATCH = 500;

// Bound cross-database file lookups while finding a live original among shared copies.
const CONTENT_COPY_BATCH = 100;

const contentCopyRow = z.object({
  id: z.string(),
  added_at: z.string(),
  managed_file_id: z.string(),
  title: z.string(),
  file_name: z.string()
});

/** How long a write of one batch of vectors may take. */
const KNOWLEDGE_EMBEDDINGS_WRITE_TIMEOUT_MS = 120_000;

const generationRow = z.object({
  generation: z.number().int().min(1),
  binding_id: z.string(),
  model: z.string(),
  dimensions: z.number().int().min(1),
  state: z.enum(KNOWLEDGE_LIVE_GENERATION_STATES)
});

const passageRow = z.object({ id: z.string(), heading: z.string().nullable(), text: z.string() });

const countRow = z.object({ count: z.number().int() });

/** The table of a generation's vectors. The generation is a whole number the store gave out. */
function embeddingsTable(generation: number): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new AppError("INTERNAL", "A generation of embeddings is a whole number from 1");
  }
  return `catalyst_kb.embeddings_${generation}`;
}

/** A vector in pgvector's text form. Only finite numbers reach a store. */
function vectorText(vector: readonly number[]): string {
  if (!vector.every((value) => Number.isFinite(value))) {
    throw new AppError("INTERNAL", "An embedding holds a value that is not a finite number");
  }
  return `[${vector.join(",")}]`;
}

function generationOf(row: z.infer<typeof generationRow>): KnowledgeEmbeddingGeneration {
  return {
    generation: row.generation,
    bindingId: row.binding_id,
    model: row.model,
    dimensions: row.dimensions,
    state: row.state
  };
}

/** Whether a generation embeds with exactly this model. */
function sameModel(generation: KnowledgeEmbeddingModel, model: KnowledgeEmbeddingModel): boolean {
  return (
    generation.bindingId === model.bindingId &&
    generation.model === model.model &&
    generation.dimensions === model.dimensions
  );
}

/** The dimensions of a model are written into the type of its table: a whole number only. */
function assertDimensions(model: KnowledgeEmbeddingModel): void {
  if (!Number.isSafeInteger(model.dimensions) || model.dimensions < 1) {
    throw new AppError("INTERNAL", "The dimensions of an embedding model are a whole number");
  }
}

/**
 * Whether chunk `c` is one a re-index embeds and a switch waits for: of a content not failed,
 * chunked at the content's revision, that a document not withdrawn holds. A content still
 * `pending` is in it, because its index job may have read the generations before this one was
 * started; it then has its vector before the switch.
 */
const REINDEXED_CHUNK = `exists (
    select 1 from catalyst_kb.contents ct
    where ct.sha256 = c.content_sha256 and ct.state <> 'failed'
      and ct.chunking_revision = c.chunking_revision
  )
  and exists (
    select 1 from catalyst_kb.documents d
    where d.content_sha256 = c.content_sha256 and d.withdrawn_at is null
  )`;

const reindexPassageRow = passageRow.extend({ title: z.string(), file_name: z.string() });

const estimateRow = z.object({
  chunks: z.number().int(),
  tokens: z.string().regex(/^\d+$/u),
  bytes: z.string().regex(/^\d+$/u)
});

const progressRow = generationRow.extend({
  chunk_count: z.number().int(),
  embedded_count: z.number().int(),
  started_at: z.string()
});

/** The generations being served or built, as the transaction sees them. */
async function liveGenerations(
  sql: PostgresChangeStatements
): Promise<KnowledgeEmbeddingGeneration[]> {
  const rows = z.array(generationRow).parse(
    await sql.run(
      `select generation, binding_id, model, dimensions, state from catalyst_kb.index_generations
       where state in ('building', 'active') order by generation`
    )
  );
  return rows.map(generationOf);
}

const contentRow = z.object({
  synced: z.boolean(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  state: z.enum(KNOWLEDGE_CONTENT_STATES),
  chunking_revision: z.number().int().nullable(),
  processing_key: z.string().nullable(),
  requested_processing_key: z.string().nullable(),
  processor_revision: z.string().nullable(),
  path: z.string().nullable(),
  mime: z.string().nullable(),
  file_id: z.string().nullable(),
  title: z.string().nullable(),
  file_name: z.string().nullable()
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

export function createBuiltinDocumentStore(
  runtime: DataStoreRuntime,
  target: BuiltinKnowledgeTarget,
  /** Where the store's record is read: the rows of a transaction the caller holds, or the pool. */
  records: DataStoreRecordsStore = runtime.stores.dataStores
): KnowledgeDocumentStore {
  async function inStore<T>(
    what: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    work: (sql: PostgresChangeStatements) => Promise<T>
  ): Promise<T> {
    const record = await storeOf(runtime, records, target);
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
    fieldExtraction: createKnowledgeFieldStore((work, signal) =>
      inStore("Extracting fields", KNOWLEDGE_DOCUMENTS_TIMEOUT_MS, signal, work)
    ),
    requestProcessing(input, signal) {
      return inStore(
        "Authorizing confirmed processing",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          await sql.run(
            "update catalyst_kb.contents set requested_processing_key=$2::text where sha256=$1::text",
            [input.contentSha256, input.processingKey]
          );
        }
      );
    },
    hasOutdatedProcessor(revisions, signal) {
      return inStore(
        "Checking document processor versions",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        (sql) => hasOutdatedProcessor(sql, revisions)
      );
    },
    processingSummary(input, signal) {
      return inStore(
        "Reviewing document processing",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        (sql) => processingSummary(sql, input)
      );
    },
    processingContents(input, signal) {
      return inStore(
        "Reviewing document processing",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        (sql) => processingContents(sql, input)
      );
    },
    releaseOriginalPage(input, release, signal) {
      return inStore(
        "Releasing synced originals",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          // Same lock order as fetch/removal: documents, content, then platform files. Never
          // hold a platform connection while waiting for the owned-store documents lock.
          await sql.script("lock table catalyst_kb.documents in share row exclusive mode");
          const terminal = z
            .array(z.object({ sha256: z.string() }))
            .parse(
              await sql.run(
                "select sha256 from catalyst_kb.contents where sha256=any($1::text[]) and state <> 'pending' order by sha256 for update",
                [
                  typeof input.contentSha256 === "string"
                    ? [input.contentSha256]
                    : [...input.contentSha256]
                ]
              )
            );
          if (terminal.length === 0) return undefined;
          const rows = z.array(z.object({ managed_file_id: z.string() })).parse(
            await sql.run(
              // A Workflow-fed document keeps its copy: its source cannot be fetched (KBW-1).
              `select managed_file_id from catalyst_kb.documents where content_sha256=any($1::text[])
           and source_item_id is not null and managed_file_id > $2::text
           and not exists (select 1 from catalyst_kb.source_items i where i.id=source_item_id and i.source_id like 'workflow:%')
           and ($4::text[] is null or managed_file_id=any($4::text[]))
           order by managed_file_id limit $3::int4`,
              [
                terminal.map((row) => row.sha256),
                input.afterFileId ?? "",
                input.limit,
                input.fileIds ? [...input.fileIds] : null
              ]
            )
          );
          await release(rows.map((row) => row.managed_file_id));
          return rows.length === input.limit ? rows.at(-1)?.managed_file_id : undefined;
        }
      );
    },
    documentOfFile(fileId, signal) {
      return inStore("Reading a document", KNOWLEDGE_DOCUMENTS_TIMEOUT_MS, signal, (sql) =>
        documentOfFile(sql, fileId)
      );
    },
    readContent(contentSha256, signal) {
      return inStore("Reading the content", KNOWLEDGE_DOCUMENTS_TIMEOUT_MS, signal, async (sql) => {
        const [row] = z.array(contentRow).parse(
          await sql.run(
            `select c.format, c.state, c.chunking_revision, c.processing_key, c.processor_revision, c.requested_processing_key,
               (select path from catalyst_kb.source_items where document_id=d.id limit 1) as path,
               (select mime from catalyst_kb.source_items where document_id=d.id limit 1) as mime,
               exists (select 1 from catalyst_kb.documents s where s.content_sha256=c.sha256 and s.source_item_id is not null and s.withdrawn_at is null) as synced,
               d.managed_file_id as file_id, d.title, d.file_name
             from catalyst_kb.contents c
             left join lateral (
               select id, managed_file_id, title, file_name from catalyst_kb.documents
               where content_sha256 = c.sha256 and withdrawn_at is null
               order by added_at, id limit 1
             ) d on true
             where c.sha256 = $1::pg_catalog.text`,
            [contentSha256]
          )
        );
        if (!row) return undefined;
        // Documents live in the owned store; availability lives on the platform. Keep a
        // metadata fallback for retained-text re-indexing, but prefer a copy with bytes.
        let document =
          row.file_id !== null && row.title !== null && row.file_name !== null
            ? { fileId: row.file_id, title: row.title, fileName: row.file_name }
            : undefined;
        let after: z.infer<typeof contentCopyRow> | undefined;
        while (document) {
          const candidates = z.array(contentCopyRow).parse(
            await sql.run(
              `select id, added_at::text, managed_file_id, title, file_name from catalyst_kb.documents
             where content_sha256=$1::text and withdrawn_at is null
               and ($2::timestamptz is null or (added_at, id) > ($2::timestamptz, $3::text))
             order by added_at, id limit $4::int4`,
              [contentSha256, after?.added_at ?? null, after?.id ?? null, CONTENT_COPY_BATCH]
            )
          );
          const files = await runtime.stores.files.listOwnedManagedFilesById({
            clientInstanceId: runtime.clientInstanceId,
            owner: { kind: "knowledge_base", id: target.assetId },
            fileIds: candidates.map((candidate) => candidate.managed_file_id)
          });
          const available = new Set<string>(
            files.filter((file) => file.status === "available").map((file) => file.id)
          );
          const copy = candidates.find((candidate) => available.has(candidate.managed_file_id));
          if (copy) {
            document = {
              fileId: copy.managed_file_id,
              title: document.title,
              fileName: document.fileName
            };
            break;
          }
          const last = candidates.at(-1);
          if (!last || candidates.length < CONTENT_COPY_BATCH) break;
          after = last;
        }
        return {
          contentSha256,
          synced: row.synced,
          format: row.format,
          state: row.state,
          ...(row.chunking_revision === null ? {} : { chunkingRevision: row.chunking_revision }),
          ...(row.processing_key === null ? {} : { processingKey: row.processing_key }),
          ...(row.requested_processing_key === null
            ? {}
            : { requestedProcessingKey: row.requested_processing_key }),
          ...(row.processor_revision === null ? {} : { processorRevision: row.processor_revision }),
          ...(document
            ? {
                document: {
                  ...document,
                  ...(row.path ? { path: row.path } : {}),
                  ...(row.mime ? { mime: row.mime } : {})
                }
              }
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
           set state = $5::pg_catalog.text, failure_code = null,
             chunking_revision = $2::pg_catalog.int4, extraction_revision = $3::pg_catalog.int4,
             page_count = $4::pg_catalog.int4, updated_at = now(),
             document_type=$6::text, processor_revision=$7::text, processing_key=$8::text, requested_processing_key=null
           where sha256 = $1::pg_catalog.text`,
            [
              input.contentSha256,
              input.chunkingRevision,
              input.extractionRevision,
              input.pageCount,
              input.complete ? "extracted" : "pending",
              input.documentType ?? null,
              input.processorRevision ?? null,
              input.processingKey ?? null
            ]
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
          // Its chunks are gone, so it is chunked afresh when it is retried.
          await sql.run(
            `update catalyst_kb.contents
           set state = 'failed', failure_code = $2::pg_catalog.text, chunking_revision = null,
             page_count = $3::pg_catalog.int4, updated_at = now()
           where sha256 = $1::pg_catalog.text`,
            [input.contentSha256, input.code, input.pageCount ?? null]
          );
        }
      );
    },

    completeContent(input, signal) {
      return inStore(
        "Marking the content indexed",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          await sql.run(
            `update catalyst_kb.contents
           set state = 'extracted', failure_code = null, updated_at = now()
           where sha256 = $1::pg_catalog.text and state = 'pending'
             and chunking_revision = $2::pg_catalog.int4`,
            [input.contentSha256, input.chunkingRevision]
          );
        }
      );
    },

    waitContent(input, signal) {
      return inStore(
        "Noting why the content waits",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          await sql.run(
            `update catalyst_kb.contents
           set failure_code = $2::pg_catalog.text, updated_at = now()
           where sha256 = $1::pg_catalog.text and state = 'pending'
             and failure_code is distinct from $2::pg_catalog.text`,
            [input.contentSha256, input.code]
          );
        }
      );
    },

    embeddingGenerations(signal) {
      return inStore(
        "Reading the generations of embeddings",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        liveGenerations
      );
    },

    async startFirstGeneration(model, signal) {
      const record = await storeOf(runtime, records, target);
      // The type of the vectors. Outside the transaction below, which takes no time with it.
      try {
        await ensureVectorExtension(
          runtime.server,
          record,
          signal ?? AbortSignal.timeout(KNOWLEDGE_DOCUMENTS_TIMEOUT_MS)
        );
      } catch (error) {
        throw databaseFailureError(error, "Making pgvector in the store");
      }
      return inStore(
        "Starting the first generation of embeddings",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          // One caller starts it; one waiting here finds it started.
          await sql.run("lock table catalyst_kb.index_generations in exclusive mode");
          const [any] = await sql.run(
            "select 1 as held from catalyst_kb.index_generations limit 1"
          );
          if (any) return liveGenerations(sql);
          assertDimensions(model);
          await sql.run(
            `insert into catalyst_kb.index_generations
             (generation, binding_id, model, dimensions, state, switched_at)
           values (1, $1::pg_catalog.text, $2::pg_catalog.text, $3::pg_catalog.int4, 'active', now())`,
            [model.bindingId, model.model, model.dimensions]
          );
          await sql.script(
            `create table ${embeddingsTable(1)} (
             chunk_id text primary key references catalyst_kb.chunks (id) on delete cascade,
             embedding public.halfvec(${model.dimensions}) not null,
             created_at timestamp with time zone not null default now()
           );`
          );
          return liveGenerations(sql);
        }
      );
    },

    passagesToEmbed(input, signal) {
      return inStore(
        "Reading the passages to embed",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          const rows = z.array(passageRow).parse(
            await sql.run(
              `select c.id, c.heading, c.text from catalyst_kb.chunks c
             where c.content_sha256 = $1::pg_catalog.text
               and c.chunking_revision = $2::pg_catalog.int4
               and not exists (
                 select 1 from ${embeddingsTable(input.generation)} e where e.chunk_id = c.id
               )
             order by c.position
             limit $3::pg_catalog.int4`,
              [input.contentSha256, input.chunkingRevision, input.limit]
            )
          );
          return rows.map((row) => ({
            chunkId: row.id,
            ...(row.heading === null ? {} : { heading: row.heading }),
            text: row.text
          }));
        }
      );
    },

    writeEmbeddings(input, signal) {
      if (input.vectors.length === 0) return Promise.resolve(0);
      const { generation, dimensions } = input.generation;
      for (const { vector } of input.vectors) {
        if (vector.length !== dimensions) {
          throw new AppError(
            "INTERNAL",
            `An embedding of generation ${generation} has ${vector.length} values, not ${dimensions}`
          );
        }
      }
      const table = embeddingsTable(generation);
      const chunkIds = input.vectors.map((each) => each.chunkId);
      return inStore(
        "Writing the embeddings",
        KNOWLEDGE_EMBEDDINGS_WRITE_TIMEOUT_MS,
        signal,
        async (sql) => {
          // Held against a rewrite of their chunks, which locks a content's row for update, so
          // a passage found here is not removed before its vector is in. In one order, so two
          // writers of overlapping contents do not wait on each other in a circle.
          const held = await sql.run(
            `select 1 as held from catalyst_kb.contents where sha256 in (
               select content_sha256 from catalyst_kb.chunks where id = any($1::pg_catalog.text[])
             ) order by sha256 for share`,
            [{ type: "text[]", value: chunkIds }]
          );
          if (held.length === 0) return 0;
          // One writer per generation at a time keeps its count exact.
          const live = z.array(z.object({ state: z.string() })).parse(
            await sql.run(
              `select state from catalyst_kb.index_generations
           where generation = $1::pg_catalog.int4 and state in ('building', 'active') for update`,
              [generation]
            )
          );
          // A generation retired meanwhile has no table any more.
          if (live.length === 0) return 0;
          const written = await sql.run(
            `insert into ${table} (chunk_id, embedding)
           select v.chunk_id, v.embedding::public.halfvec(${dimensions})
           from unnest($1::pg_catalog.text[], $2::pg_catalog.text[]) as v (chunk_id, embedding)
           where exists (select 1 from catalyst_kb.chunks c where c.id = v.chunk_id)
           on conflict (chunk_id) do nothing
           returning chunk_id`,
            [
              { type: "text[]", value: chunkIds },
              { type: "text[]", value: input.vectors.map((each) => vectorText(each.vector)) }
            ]
          );
          // Only a generation being built shows its count, as the progress of a re-index, and
          // the switch counts it again. Counting every row of the table at each write grows
          // with the table: a write adds what it wrote to the count of a generation in use.
          if (live[0]?.state === "building") {
            const [count] = z
              .array(countRow)
              .parse(await sql.run(`select count(*)::pg_catalog.int4 as count from ${table}`));
            await sql.run(
              `update catalyst_kb.index_generations set embedded_count = $2::pg_catalog.int4
           where generation = $1::pg_catalog.int4`,
              [generation, count?.count ?? 0]
            );
          } else {
            await sql.run(
              `update catalyst_kb.index_generations set embedded_count = embedded_count + $2::pg_catalog.int4
           where generation = $1::pg_catalog.int4`,
              [generation, written.length]
            );
          }
          return written.length;
        }
      );
    },

    async startGeneration(model, signal) {
      assertDimensions(model);
      const record = await storeOf(runtime, records, target);
      try {
        await ensureVectorExtension(
          runtime.server,
          record,
          signal ?? AbortSignal.timeout(KNOWLEDGE_DOCUMENTS_TIMEOUT_MS)
        );
      } catch (error) {
        throw databaseFailureError(error, "Making pgvector in the store");
      }
      return inStore(
        "Starting a generation of embeddings",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          // One caller starts it; one waiting here finds it started.
          await sql.run("lock table catalyst_kb.index_generations in exclusive mode");
          const live = await liveGenerations(sql);
          const building = live.find((each) => each.state === "building");
          if (building && sameModel(building, model)) return building;
          if (building) {
            // A re-index to another model replaces the one being built: one model at a time.
            await sql.run(
              `update catalyst_kb.index_generations set state = 'retired'
               where generation = $1::pg_catalog.int4`,
              [building.generation]
            );
            await sql.script(`drop table if exists ${embeddingsTable(building.generation)};`);
          }
          const [next] = z
            .array(z.object({ next: z.number().int() }))
            .parse(
              await sql.run(
                "select coalesce(max(generation), 0)::pg_catalog.int4 + 1 as next from catalyst_kb.index_generations"
              )
            );
          const generation = next?.next ?? 1;
          const [goal] = z
            .array(countRow)
            .parse(
              await sql.run(
                `select count(*)::pg_catalog.int4 as count from catalyst_kb.chunks c where ${REINDEXED_CHUNK}`
              )
            );
          await sql.run(
            `insert into catalyst_kb.index_generations
             (generation, binding_id, model, dimensions, state, chunk_count)
           values ($1::pg_catalog.int4, $2::pg_catalog.text, $3::pg_catalog.text,
             $4::pg_catalog.int4, 'building', $5::pg_catalog.int4)`,
            [generation, model.bindingId, model.model, model.dimensions, goal?.count ?? 0]
          );
          await sql.script(
            `create table ${embeddingsTable(generation)} (
             chunk_id text primary key references catalyst_kb.chunks (id) on delete cascade,
             embedding public.halfvec(${model.dimensions}) not null,
             created_at timestamp with time zone not null default now()
           );`
          );
          return { generation, ...model, state: "building" as const };
        }
      );
    },

    passagesToReindex(input, signal) {
      return inStore(
        "Reading the passages to embed again",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          const rows = z.array(reindexPassageRow).parse(
            await sql.run(
              `select c.id, c.heading, c.text, d.title, d.file_name from catalyst_kb.chunks c
             cross join lateral (
               select title, file_name from catalyst_kb.documents
               where content_sha256 = c.content_sha256 and withdrawn_at is null
               order by added_at, id limit 1
             ) d
             where ${REINDEXED_CHUNK}
               and not exists (
                 select 1 from ${embeddingsTable(input.generation)} e where e.chunk_id = c.id
               )
             order by c.id
             limit $1::pg_catalog.int4`,
              [input.limit]
            )
          );
          return rows.map((row) => ({
            chunkId: row.id,
            ...(row.heading === null ? {} : { heading: row.heading }),
            text: row.text,
            title: row.title,
            fileName: row.file_name
          }));
        }
      );
    },

    switchGeneration(generation, signal) {
      return inStore(
        "Switching the generation of embeddings",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          const table = embeddingsTable(generation);
          // Read before the lock, so searches are not held while it is looked for. A passage
          // written after it is embedded by its own index job into what is active then.
          const [missing] = await sql.run(
            `select 1 as missing from catalyst_kb.chunks c where ${REINDEXED_CHUNK}
               and not exists (select 1 from ${table} e where e.chunk_id = c.id) limit 1`
          );
          if (missing) return { switched: false };
          // A search reads the active generation and its table in one transaction: this waits
          // for the searches under way and holds the next until the switch is committed, so no
          // search sees the passages of two generations or a table that is gone.
          await sql.run("lock table catalyst_kb.index_generations in access exclusive mode");
          const live = await liveGenerations(sql);
          if (!live.some((each) => each.generation === generation && each.state === "building")) {
            return { switched: false };
          }
          const retired = live.find((each) => each.state === "active");
          if (retired) {
            await sql.run(
              `update catalyst_kb.index_generations set state = 'retired'
               where generation = $1::pg_catalog.int4`,
              [retired.generation]
            );
          }
          const [count] = z
            .array(countRow)
            .parse(await sql.run(`select count(*)::pg_catalog.int4 as count from ${table}`));
          await sql.run(
            `update catalyst_kb.index_generations
             set state = 'active', switched_at = now(), embedded_count = $2::pg_catalog.int4
             where generation = $1::pg_catalog.int4`,
            [generation, count?.count ?? 0]
          );
          if (retired)
            await sql.script(`drop table if exists ${embeddingsTable(retired.generation)};`);
          return { switched: true, ...(retired ? { retired: retired.generation } : {}) };
        }
      );
    },

    retireGenerations(generations, signal) {
      if (generations.length === 0) return Promise.resolve([]);
      return inStore(
        "Dropping generations of embeddings",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          // As the switch: waits for the searches under way, so none reads a dropped table, and
          // for a writer of vectors, which finds the generation retired after.
          await sql.run("lock table catalyst_kb.index_generations in access exclusive mode");
          const live = await liveGenerations(sql);
          const retired = live.filter((each) => generations.includes(each.generation));
          for (const each of retired) {
            await sql.run(
              `update catalyst_kb.index_generations set state = 'retired'
               where generation = $1::pg_catalog.int4`,
              [each.generation]
            );
            await sql.script(`drop table if exists ${embeddingsTable(each.generation)};`);
          }
          return retired.map((each) => each.generation);
        }
      );
    },

    reindexEstimate(input, signal) {
      const missing =
        input.missingFrom === undefined
          ? ""
          : `and not exists (
                 select 1 from ${embeddingsTable(input.missingFrom)} e where e.chunk_id = c.id
               )`;
      return inStore(
        "Estimating a re-index",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) => {
          const [row] = z.array(estimateRow).parse(
            await sql.run(
              // The prefix (title, file name, heading) is embedded with each passage: about one
              // token per three characters of it, a little above the chunker's own estimate.
              `select count(*)::pg_catalog.int4 as chunks,
                 coalesce(sum(c.token_count + ceil(pg_catalog.char_length(
                   d.title || d.file_name || coalesce(c.heading, '')) / 3.0)), 0)::pg_catalog.int8::pg_catalog.text as tokens,
                 pg_catalog.pg_database_size(pg_catalog.current_database())::pg_catalog.text as bytes
               from catalyst_kb.chunks c
               cross join lateral (
                 select title, file_name from catalyst_kb.documents
                 where content_sha256 = c.content_sha256 and withdrawn_at is null
                 order by added_at, id limit 1
               ) d
               where ${REINDEXED_CHUNK} ${missing}`
            )
          );
          return {
            chunks: row?.chunks ?? 0,
            tokens: Number(row?.tokens ?? 0),
            storeBytes: Number(row?.bytes ?? 0)
          };
        }
      );
    },

    generationProgress(signal) {
      return inStore(
        "Reading the generations of embeddings",
        KNOWLEDGE_DOCUMENTS_TIMEOUT_MS,
        signal,
        async (sql) =>
          z
            .array(progressRow)
            .parse(
              await sql.run(
                `select generation, binding_id, model, dimensions, state, chunk_count,
                   embedded_count, started_at::text
                 from catalyst_kb.index_generations
                 where state in ('building', 'active') order by generation`
              )
            )
            .map((row) => ({
              ...generationOf(row),
              chunkCount: row.chunk_count,
              embeddedCount: row.embedded_count,
              startedAt: new Date(row.started_at).toISOString()
            }))
      );
    },

    async listDocuments(input, signal) {
      // Decode before entering the executor: callback errors become database failures there.
      const after =
        input.cursor === undefined ? undefined : decodeKnowledgeDocumentCursor(input.cursor);
      return inStore("Listing the documents", KNOWLEDGE_DOCUMENTS_TIMEOUT_MS, signal, (sql) =>
        listKnowledgeDocuments(sql, { limit: input.limit, ...(after ? { after } : {}) })
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
           set state = 'pending', failure_code = null, chunking_revision = null, updated_at = now()
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
    },

    async search(input, signal) {
      const answer = await searchKnowledgeStore(
        (work) =>
          inStore("Searching the documents", KNOWLEDGE_SEARCH_TIMEOUT_MS, signal, async (sql) => {
            await sql.script("set transaction read only");
            return work(sql);
          }),
        target,
        input
      );
      return visibleSourceHits(runtime, target.assetId, target.name, answer, (work) =>
        inStore("Checking source visibility", KNOWLEDGE_SEARCH_TIMEOUT_MS, signal, work)
      );
    }
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
  records: DataStoreRecordsStore,
  target: BuiltinKnowledgeTarget
): Promise<DataStoreRecord> {
  const record = await records.getDataStore({
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
