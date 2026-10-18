/** PROC-2: only counters and pending markers; no document payload or extraction result. */
export const KNOWLEDGE_FIELD_SCHEMA = `
  create table catalyst_kb.field_budgets (
    month text primary key,
    currency text not null,
    spent numeric not null default 0 check (spent >= 0)
  );
  alter table catalyst_kb.documents add column fields_pending boolean not null default false,
    add column fields_pending_reason jsonb;
`;
