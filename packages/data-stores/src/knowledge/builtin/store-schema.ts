import { createHash } from "node:crypto";
import { z } from "zod";
import type { DataStoreAppliedMigration, DataStoreRecord } from "@work-shape/catalyst-core";
import type { DataStoreServer } from "../../server";

// The tables of the store a Knowledge Base on the built-in backend owns. They are in the schema
// `catalyst_kb`, which the platform's role makes and owns: no role of the store creates, reads
// or changes them, and no App binds the store. The platform's release brings them as numbered
// SQL, applied forward in one transaction and recorded in `catalyst_kb.migrations` of the
// store, so a dump of the store says itself how far its tables are. A later release adds a
// migration here and never changes one. Spec: Embeddings and documents on the built-in
// backend, "The store of a built-in Knowledge Base".
//
// What the tables will hold is the documents of the Knowledge Base: file text by page and its
// passages, from the slices that add and index files. The table of each generation of
// embeddings (`embeddings_<generation>`, `halfvec(<dimensions>)`) is made by the index job of
// that generation, because its dimension is the embedding model's.

/** How long applying the tables may take before the attempt fails. */
const KNOWLEDGE_STORE_SCHEMA_TIMEOUT_MS = 120_000;

interface KnowledgeStoreMigration {
  number: number;
  name: string;
  sql: string;
}

/** Each table and column as the spec's table names it. Generated text-search columns use the configurations Postgres ships. */
const DOCUMENTS = `
  create table catalyst_kb.contents (
    sha256 text primary key check (sha256 ~ '^[0-9a-f]{64}$'),
    format text not null,
    page_count integer check (page_count >= 0),
    extraction_revision integer,
    chunking_revision integer,
    state text not null default 'pending' check (state in ('pending', 'extracted', 'failed')),
    failure_code text,
    created_at timestamp with time zone not null default now(),
    updated_at timestamp with time zone not null default now()
  );

  create table catalyst_kb.documents (
    id text primary key,
    managed_file_id text not null,
    content_sha256 text not null references catalyst_kb.contents (sha256),
    title text not null,
    file_name text not null,
    origin_link text,
    added_by text,
    added_at timestamp with time zone not null default now(),
    withdrawn_at timestamp with time zone,
    title_search tsvector generated always as (
      to_tsvector('simple'::regconfig, title || ' ' || file_name)
    ) stored
  );
  create index documents_content_idx on catalyst_kb.documents (content_sha256);
  create index documents_title_search_idx on catalyst_kb.documents using gin (title_search);

  create table catalyst_kb.chunks (
    id text primary key,
    content_sha256 text not null references catalyst_kb.contents (sha256) on delete cascade,
    chunking_revision integer not null,
    position integer not null check (position >= 0),
    page integer check (page >= 1),
    heading text,
    text text not null,
    token_count integer not null check (token_count >= 0),
    search_de tsvector generated always as (to_tsvector('german'::regconfig, text)) stored,
    search_en tsvector generated always as (to_tsvector('english'::regconfig, text)) stored,
    unique (content_sha256, chunking_revision, position)
  );
  create index chunks_search_de_idx on catalyst_kb.chunks using gin (search_de);
  create index chunks_search_en_idx on catalyst_kb.chunks using gin (search_en);

  create table catalyst_kb.index_generations (
    generation integer primary key check (generation >= 1),
    binding_id text not null,
    model text not null,
    dimensions integer not null check (dimensions between 1 and 4000),
    state text not null check (state in ('building', 'active', 'retired')),
    chunk_count integer not null default 0 check (chunk_count >= 0),
    embedded_count integer not null default 0 check (embedded_count >= 0),
    started_at timestamp with time zone not null default now(),
    switched_at timestamp with time zone
  );
  create unique index index_generations_active_idx on catalyst_kb.index_generations ((true))
    where state = 'active';
`;

/**
 * The state of the synced sources of the Knowledge Base (SRC-0; spec: Synced sources, "The
 * sync engine"). An item is one row per `(source_id, item_id)`, `source_id` being the `id` of
 * the entry under `sources`; its own state ends at `fetched`, and from then on it shows its
 * document's. `purged_at` is when the purge removed what was derived from it, for `locate`. The
 * cursor of a source is written in the transaction of the page it covers. A document fetched
 * from a source names its item; one added by hand names none.
 */
const SOURCES = `
  create table catalyst_kb.source_items (
    id text primary key,
    source_id text not null,
    item_id text not null,
    version text not null,
    path text not null,
    name text not null,
    mime text not null,
    size bigint not null check (size >= 0),
    modified_at timestamp with time zone not null,
    origin_link text,
    document_id text,
    state text not null default 'discovered'
      check (state in ('discovered', 'fetched', 'failed', 'withdrawn')),
    attempts integer not null default 0 check (attempts >= 0),
    failure_code text,
    discovered_at timestamp with time zone not null default now(),
    changed_at timestamp with time zone not null default now(),
    fetched_at timestamp with time zone,
    withdrawn_at timestamp with time zone,
    purged_at timestamp with time zone,
    unique (source_id, item_id),
    check ((state = 'failed') = (failure_code is not null))
  );
  create index source_items_source_state_idx on catalyst_kb.source_items (source_id, state);
  create index source_items_source_changed_idx
    on catalyst_kb.source_items (source_id, changed_at desc, id);

  create table catalyst_kb.sync_runs (
    id text primary key,
    source_id text not null,
    mode text not null check (mode in ('initial', 'changes', 'full')),
    reason text,
    operation_run_id text not null,
    cursor_before text,
    cursor_after text,
    discovered integer not null default 0 check (discovered >= 0),
    added integer not null default 0 check (added >= 0),
    changed integer not null default 0 check (changed >= 0),
    moved integer not null default 0 check (moved >= 0),
    withdrawn integer not null default 0 check (withdrawn >= 0),
    failed integer not null default 0 check (failed >= 0),
    skipped integer not null default 0 check (skipped >= 0),
    bytes_fetched bigint not null default 0 check (bytes_fetched >= 0),
    state text not null default 'running' check (state in ('running', 'done', 'failed')),
    failure_code text,
    started_at timestamp with time zone not null default now(),
    ended_at timestamp with time zone,
    check ((state = 'running') = (ended_at is null))
  );
  create index sync_runs_source_started_idx on catalyst_kb.sync_runs (source_id, started_at desc);
  create unique index sync_runs_running_idx on catalyst_kb.sync_runs (source_id)
    where state = 'running';

  create table catalyst_kb.source_cursors (
    source_id text primary key,
    cursor text not null,
    last_change_at timestamp with time zone,
    oldest_open_change_at timestamp with time zone,
    updated_at timestamp with time zone not null default now()
  );

  alter table catalyst_kb.documents
    add column source_item_id text references catalyst_kb.source_items (id);
  create unique index documents_source_item_idx on catalyst_kb.documents (source_item_id)
    where source_item_id is not null;
`;

/** The tables of the store of a built-in Knowledge Base, in the order a store applies them. */
const KNOWLEDGE_STORE_MIGRATIONS: readonly KnowledgeStoreMigration[] = [
  { number: 1, name: "documents", sql: DOCUMENTS },
  { number: 2, name: "sources", sql: SOURCES }
];

/** The level the store of a built-in Knowledge Base is at when its tables are this release's. */
export const KNOWLEDGE_STORE_LEVEL = KNOWLEDGE_STORE_MIGRATIONS.length;

const appliedRow = z.object({ number: z.number().int() });

/**
 * Brings the tables of the store a Knowledge Base owns to this release, as the platform's role,
 * in one transaction: what is applied stays, what is missing is added in number order. Answers
 * every migration the store holds now.
 */
export async function applyKnowledgeStoreSchema(
  server: DataStoreServer,
  record: Pick<DataStoreRecord, "location">,
  signal: AbortSignal
): Promise<DataStoreAppliedMigration[]> {
  return server.executor.change(
    {
      ...server.asPlatform(record.location.database),
      timeoutMs: KNOWLEDGE_STORE_SCHEMA_TIMEOUT_MS,
      signal
    },
    async (sql) => {
      await sql.script(
        `create schema if not exists catalyst_kb;
         revoke all on schema catalyst_kb from public;
         create table if not exists catalyst_kb.migrations (
           number integer primary key,
           name text not null,
           applied_at timestamp with time zone not null default now()
         );
         lock table catalyst_kb.migrations in exclusive mode;`
      );
      const applied = new Set(
        z
          .array(appliedRow)
          .parse(await sql.run("select number from catalyst_kb.migrations"))
          .map((row) => row.number)
      );
      for (const migration of KNOWLEDGE_STORE_MIGRATIONS) {
        if (applied.has(migration.number)) continue;
        await sql.script(migration.sql);
        await sql.run(
          "insert into catalyst_kb.migrations (number, name) values ($1::pg_catalog.int4, $2::pg_catalog.text)",
          [migration.number, migration.name]
        );
      }
      return KNOWLEDGE_STORE_MIGRATIONS.map(({ number, name, sql: text }) => ({
        number,
        name,
        sha256: createHash("sha256").update(text).digest("hex")
      }));
    }
  );
}
