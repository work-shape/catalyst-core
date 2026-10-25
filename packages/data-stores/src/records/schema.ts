/**
 * REC-0's DDL in every Data Store's platform-owned schema. Only the platform role can
 * read or change it. No foreign key crosses databases into the owning Knowledge Base.
 * Document identity is (knowledge_base_id, document_id), never the bare document id.
 * A missing object key is SQL NULL until assignment; JSON scalar keys keep their type.
 * Candidates/quotes are customer data: purge and recompute through the withdrawal outbox
 * (REC-1b), within the Synced sources and records retention deadline. Never audit values.
 */
export const RECORD_FIELDS_SCHEMA = `
  create table if not exists catalyst.record_fields (
    table_name text not null,
    record_key jsonb check (jsonb_typeof(record_key) in ('string', 'number', 'boolean')),
    field_name text not null,
    knowledge_base_id text not null,
    document_id text not null,
    kind text not null,
    value jsonb not null,
    page integer not null check (page >= 1),
    quote text not null,
    document_date date,
    extracted_at timestamp with time zone not null,
    evidence jsonb not null check (
      evidence = '{"status":"passed"}'::jsonb or evidence in (
        '{"status":"failed","reason":"page_not_found"}'::jsonb,
        '{"status":"failed","reason":"quote_not_found"}'::jsonb,
        '{"status":"failed","reason":"value_not_parsed"}'::jsonb
      )
    ),
    state text not null check (state in ('extracted', 'confirmed', 'corrected', 'conflict')),
    decided_by text,
    decided_at timestamp with time zone,
    check ((decided_by is null) = (decided_at is null)),
    unique nulls not distinct (table_name, record_key, field_name, knowledge_base_id, document_id)
  );
`;

/** Owned releases 8 and 11 share this additive step; existing columns keep their values. */
export const RECORD_FIELDS_CONTENT_HASH = `alter table catalyst.record_fields add column if not exists content_sha256 text;`;

/**
 * REC-KEEP: a person's correction stands beside the value read, in `corrected_value`, held
 * exactly while the candidate is `corrected`; `value`, its page, quote and evidence stay what the
 * document reads. Owned release 16 and every store's schema setup share this step, which runs
 * once: a store that has the check passes over it. A row corrected before it holds the person's
 * value in `value`, the value read being lost: that value moves to `corrected_value` too, and its
 * evidence is marked as not holding, so it never counts as read once the decision is replaced.
 */
export const RECORD_FIELDS_CORRECTED_VALUE = `
  do $corrected$
  begin
    if not exists (
      select 1 from pg_catalog.pg_constraint
      where conrelid = 'catalyst.record_fields'::pg_catalog.regclass
        and conname = 'record_fields_corrected_value_check'
    ) then
      alter table catalyst.record_fields add column if not exists corrected_value jsonb;
      update catalyst.record_fields
        set corrected_value = value,
          evidence = '{"status":"failed","reason":"value_not_parsed"}'::jsonb
        where state = 'corrected' and corrected_value is null;
      alter table catalyst.record_fields add constraint record_fields_corrected_value_check
        check ((state = 'corrected') = (corrected_value is not null));
    end if;
  end $corrected$;
`;
