import {
  PostgresExecutorError,
  type PostgresExecutor,
  type PostgresTarget
} from "@work-shape/catalyst-postgres-connector";
import { catalogTarget } from "./catalog";

const CONSTRAINT_EXISTS = `
  select exists (
    select 1
    from pg_catalog.pg_class t
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
    where n.nspname = 'public' and t.relname = $1 and t.relkind in ('r', 'p')
      and case when $4 = '23502' then exists (
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid = t.oid and a.attname = $3
          and a.attnum > 0 and not a.attisdropped
      ) else (exists (
        select 1 from pg_catalog.pg_constraint c
        where c.conrelid = t.oid and c.conname = $2
      ) or exists (
        select 1 from pg_catalog.pg_index i
        join pg_catalog.pg_class x on x.oid = i.indexrelid
        where i.indrelid = t.oid and x.relname = $2
      )) end
  ) as present
`;

/**
 * Called only after the failed verb has rolled back, as the platform role. A genuine
 * PostgreSQL check can name an object a security-definer trigger created from a row value;
 * those objects are gone now. One catalog query checks the name AND its table, never rows.
 * If verification fails, keep the original SQLSTATE and its fixed sentence, without names.
 */
export async function validateConstraintNames(
  executor: PostgresExecutor,
  platformTarget: PostgresTarget,
  error: unknown
): Promise<unknown> {
  if (!(error instanceof PostgresExecutorError) || error.kind !== "failed" || !error.constraint)
    return error;
  const { name, table, column } = error.constraint;
  const notNull = error.sqlState === "23502";
  if (table && (notNull ? column : name)) {
    try {
      const result = await executor.query({
        ...catalogTarget(platformTarget),
        sql: CONSTRAINT_EXISTS,
        parameters: [table, name ?? null, column ?? null, error.sqlState ?? null]
      });
      if (!result.truncated && result.rows[0]?.present === true)
        return new PostgresExecutorError("failed", error.sqlState, {
          table,
          ...(notNull ? { column } : { name })
        });
    } catch {
      // A failed catalog read cannot establish that a name is safe to repeat.
    }
  }
  return new PostgresExecutorError("failed", error.sqlState);
}
