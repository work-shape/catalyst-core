import { z } from "zod";
import {
  AppError,
  type ScopedTables,
  viewerScopeBindings,
  type ActorAccess,
  type DataStoreParameter,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { quoteIdentifier } from "./server";

export { scopedTablesSchema, type ScopedTables } from "@work-shape/catalyst-core";

export function scopePredicate(
  tables: ScopedTables | undefined,
  table: string,
  access?: ActorAccess,
  offset = 0,
  alias?: string
): { condition: string; parameters: DataStoreParameter[]; unassigned: boolean } {
  const parameters: DataStoreParameter[] = [];
  let unassigned = false;
  const clauses = Object.entries(tables?.[table]?.scope ?? {}).map(([dimension, column]) => {
    const values = access?.scopeOf(dimension) ?? [];
    if (values === "all") return "true";
    unassigned ||= values.length === 0;
    parameters.push({ type: "text[]", value: [...values] });
    return `${alias ? `${quoteIdentifier(alias)}.` : ""}${quoteIdentifier(column)} = ANY($${offset + parameters.length}::text[])`;
  });
  return { condition: clauses.length ? clauses.join(" and ") : "true", parameters, unassigned };
}

export function requireScopedRows(
  tables: ScopedTables | undefined,
  table: string,
  rows: readonly JsonObject[],
  access?: ActorAccess
): void {
  for (const [dimension, column] of Object.entries(tables?.[table]?.scope ?? {})) {
    const values = access?.scopeOf(dimension) ?? [];
    for (const row of rows) {
      const value = row[column];
      if (typeof value !== "string" || value.length === 0)
        throw new AppError(
          "VALIDATION_FAILED",
          `Table '${table}' requires a value in scope column '${column}'`,
          { reason: "scope_value_required", table, column }
        );
      if (values !== "all" && !values.includes(value))
        throw new AppError("FORBIDDEN", "The row is outside your assigned data", {
          reason: "scope_value_denied"
        });
    }
  }
}

/** A published SQL read is authored and reviewed. Its viewer values always come from the resolver. */
export function bindViewerScopes(
  sql: string,
  parameters: readonly DataStoreParameter[] = [],
  access?: ActorAccess
) {
  let statement = "";
  let from = 0;
  const bound = [...parameters];
  for (const binding of viewerScopeBindings(sql)) {
    const scope = access?.scopeOf(binding.dimension) ?? [];
    bound.push(
      binding.all
        ? { type: "boolean", value: scope === "all" }
        : { type: "text[]", value: scope === "all" ? [] : [...scope] }
    );
    statement += sql.slice(from, binding.start) + `$${bound.length}`;
    from = binding.end;
  }
  return { sql: statement + sql.slice(from), parameters: bound };
}

/** Free query callers may select one table's columns. Expressions, joins and functions use a reviewed named query. */
export function scopedQuery(
  sql: string,
  tables: ScopedTables | undefined,
  access?: ActorAccess,
  parameters: readonly DataStoreParameter[] = []
) {
  if (!Object.keys(tables ?? {}).length) return { sql, parameters: [...parameters] };
  const read =
    /^\s*select\s+(\*|"?[a-z_][a-z0-9_]*"?(?:\s*,\s*"?[a-z_][a-z0-9_]*"?)*)\s+from\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*;?\s*$/iu.exec(
      sql
    );
  if (!read?.[2] || !tables?.[read[2]])
    throw new AppError(
      "VALIDATION_FAILED",
      "Free SQL on a scoped Data Store is refused. Select one table or use a published named query.",
      { reason: "scoped_sql_refused" }
    );
  const filter = scopePredicate(tables, read[2], access, parameters.length);
  return {
    sql: `select ${read[1]} from public.${quoteIdentifier(read[2])} where ${filter.condition}`,
    parameters: [...parameters, ...filter.parameters]
  };
}

/** Checked inside the DDL transaction before commit; scope columns stay text and NOT NULL. */
export async function checkScopedColumns(
  sql: Pick<PostgresChangeStatements, "run">,
  tables: ScopedTables | undefined
): Promise<void> {
  for (const [table, metadata] of Object.entries(tables ?? {})) {
    for (const column of Object.values(metadata.scope)) {
      const rows = z.array(z.object({ valid: z.boolean() })).parse(
        await sql.run(
          `select a.attnotnull and a.atttypid = 'pg_catalog.text'::pg_catalog.regtype as valid
        from pg_catalog.pg_attribute a join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = $1 and a.attname = $2 and not a.attisdropped`,
          [table, column]
        )
      );
      if (!rows[0]?.valid)
        throw new AppError(
          "VALIDATION_FAILED",
          `Scoped table '${table}' requires text column '${column}' NOT NULL; a migration cannot drop it or change its type`,
          { reason: "scope_column_invalid", table, column }
        );
    }
  }
}
