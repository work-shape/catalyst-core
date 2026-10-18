import { KNOWLEDGE_FIELD_SCHEMA } from "./field-schema";
import { RECORD_FIELDS_SCHEMA, RECORD_FIELDS_CONTENT_HASH } from "../../records/schema";
import { SOURCE_WITHDRAWAL_SCHEMA } from "./source-withdrawal-schema";
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

// A transactionally maintained projection keeps status reads independent of inventory size.
const SOURCE_COUNTS = `
  -- A content transition touches only the source items sharing that content, through
  -- documents_content_idx and this link; it never scans the full source inventory.
  create index source_items_document_idx on catalyst_kb.source_items(document_id) where document_id is not null;
  create table catalyst_kb.source_counts (
    source_id text not null,
    state text not null,
    failure_code text not null default '',
    items bigint not null,
    primary key(source_id,state,failure_code)
  );

  -- Deltas lock only the affected counters, in key order. Signed insert deltas let the
  -- upsert update existing counters atomically; every old state already has its counter.
  create function catalyst_kb.move_source_count(s text, old_state text, old_code text, new_state text, new_code text, n bigint default 1) returns void language plpgsql as $$
  begin
    if old_state is not distinct from new_state and coalesce(old_code,'')=coalesce(new_code,'') then return; end if;
    insert into catalyst_kb.source_counts(source_id,state,failure_code,items)
      select s,st,coalesce(fc,''),sum(delta) from (values(old_state,old_code,-n),(new_state,new_code,n)) as moves(st,fc,delta)
      where st is not null group by st,fc having sum(delta)<>0 order by st,fc
      on conflict(source_id,state,failure_code) do update set items=source_counts.items+excluded.items;
  end $$;

  -- Lock the content while projecting an item: an index completion cannot pass a fetch
  -- handoff and miss the newly fetched item, or count its previous state a second time.
  create function catalyst_kb.source_projection(item_state text, document text) returns table(state text,code text) language plpgsql as $$
  declare content_state text; content_code text;
  begin
    if item_state='fetched' then
      select c.state,c.failure_code into content_state,content_code from catalyst_kb.contents c join catalyst_kb.documents d on d.content_sha256=c.sha256 where d.id=document for share of c;
      return query select case content_state when 'extracted' then 'indexed' when 'failed' then 'failed' else 'fetched' end,case when content_state='failed' then content_code end;
    else return query select item_state,null::text;
    end if;
  end $$;

  create function catalyst_kb.source_item_count_changed() returns trigger language plpgsql as $$
  declare os text; oc text; ns text; nc text;
  begin
    if tg_op='UPDATE' and old.state is not distinct from new.state and old.failure_code is not distinct from new.failure_code and old.document_id is not distinct from new.document_id then return null; end if;
    if tg_op<>'INSERT' then
      select state,code into os,oc from catalyst_kb.source_projection(old.state,old.document_id);
      if old.state='failed' then oc=old.failure_code; end if;
    end if;
    if tg_op<>'DELETE' then
      select state,code into ns,nc from catalyst_kb.source_projection(new.state,new.document_id);
      if new.state='failed' then nc=new.failure_code; end if;
    end if;
    perform catalyst_kb.move_source_count(coalesce(new.source_id,old.source_id),os,oc,ns,nc);
    return null;
  end $$;
  create trigger source_item_count_changed after insert or delete or update of state,failure_code,document_id on catalyst_kb.source_items for each row execute function catalyst_kb.source_item_count_changed();

  create function catalyst_kb.source_content_count_changed() returns trigger language plpgsql as $$
  declare r record; os text; oc text; ns text; nc text;
  begin
    os=case old.state when 'extracted' then 'indexed' when 'failed' then 'failed' else 'fetched' end;
    ns=case new.state when 'extracted' then 'indexed' when 'failed' then 'failed' else 'fetched' end;
    oc=case when old.state='failed' then old.failure_code end;
    nc=case when new.state='failed' then new.failure_code end;
    if os is not distinct from ns and oc is not distinct from nc then return null; end if;
    for r in select i.source_id,count(*) as n from catalyst_kb.source_items i join catalyst_kb.documents d on d.id=i.document_id where i.state='fetched' and d.content_sha256=new.sha256 group by i.source_id order by i.source_id loop
      perform catalyst_kb.move_source_count(r.source_id,os,oc,ns,nc,r.n);
    end loop;
    return null;
  end $$;
  create trigger source_content_count_changed after update of state,failure_code on catalyst_kb.contents for each row execute function catalyst_kb.source_content_count_changed();

  insert into catalyst_kb.source_counts(source_id,state,failure_code,items)
    select i.source_id,
      case when i.state='fetched' then case c.state when 'extracted' then 'indexed' when 'failed' then 'failed' else 'fetched' end else i.state end,
      coalesce(case when i.state='failed' then i.failure_code when i.state='fetched' and c.state='failed' then c.failure_code end,''),count(*)
    from catalyst_kb.source_items i left join catalyst_kb.documents d on d.id=i.document_id left join catalyst_kb.contents c on c.sha256=d.content_sha256 group by 1,2,3;
`;

// Existing connector rows keep their cursors and gain kind=connector. A Workflow source
// has no connector cursor; its id is namespaced by the Workflow, never authored in kb.yaml.
const WORKFLOW_SOURCES = `
  alter table catalyst_kb.source_cursors
    alter column cursor drop not null,
    add column kind text not null default 'connector',
    add column workflow_id text,
    add constraint source_kind_check check (
      (kind = 'connector' and workflow_id is null and cursor is not null
          and position(':' in source_id) = 0)
      or (kind = 'workflow' and workflow_id is not null
          and workflow_id ~ '^[a-z][a-z0-9_-]{0,62}$'
          and source_id = 'workflow:' || workflow_id and cursor is null)
    );
`;

/** The tables of the store of a built-in Knowledge Base, in the order a store applies them. */
const KNOWLEDGE_STORE_MIGRATIONS: readonly KnowledgeStoreMigration[] = [
  { number: 1, name: "documents", sql: DOCUMENTS },
  { number: 2, name: "sources", sql: SOURCES },
  {
    number: 3,
    name: "source_fetch_claims",
    sql: `alter table catalyst_kb.source_items
      add column enqueued_run_id text,
      add column fetch_job_id text;`
  },
  { number: 4, name: "source_counts", sql: SOURCE_COUNTS },
  { number: 5, name: "source_withdrawal", sql: SOURCE_WITHDRAWAL_SCHEMA },
  { number: 6, name: "workflow_sources", sql: WORKFLOW_SOURCES },
  {
    number: 7,
    name: "document_processors",
    sql: `alter table catalyst_kb.contents
      add column document_type text,
      add column processor_revision text,
      add column processing_key text,
      add column requested_processing_key text;`
  },
  {
    number: 8,
    name: "record_content_hash",
    sql: RECORD_FIELDS_SCHEMA + RECORD_FIELDS_CONTENT_HASH
  },
  {
    number: 9,
    name: "source_superseded",
    sql: `alter table catalyst_kb.sync_runs drop constraint sync_runs_state_check;
      alter table catalyst_kb.sync_runs add constraint sync_runs_state_check
        check (state in ('running','done','failed','superseded')) not valid;
      alter table catalyst_kb.sync_runs validate constraint sync_runs_state_check;`
  },
  { number: 10, name: "field_extraction_budget", sql: KNOWLEDGE_FIELD_SCHEMA }
];

/** The level the store of a built-in Knowledge Base is at when its tables are this release's. */
export const KNOWLEDGE_STORE_LEVEL = Math.max(
  ...KNOWLEDGE_STORE_MIGRATIONS.map((migration) => migration.number)
);

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
