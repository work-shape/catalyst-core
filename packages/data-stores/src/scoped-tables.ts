import { z } from "zod";
import {
  AppError,
  type ScopedTables,
  sqlTokens,
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

/**
 * Functions that read a relation by name or run SQL from text, and views of column
 * statistics: what they read is no reference the rewrite below can filter.
 */
const UNFILTERABLE = new Set([
  "query_to_xml",
  "query_to_xmlschema",
  "query_to_xml_and_xmlschema",
  "cursor_to_xml",
  "cursor_to_xmlschema",
  "table_to_xml",
  "table_to_xmlschema",
  "table_to_xml_and_xmlschema",
  "schema_to_xml",
  "schema_to_xmlschema",
  "schema_to_xml_and_xmlschema",
  "database_to_xml",
  "database_to_xmlschema",
  "database_to_xml_and_xmlschema",
  "ts_stat",
  "ts_rewrite",
  "crosstab",
  "crosstab2",
  "crosstab3",
  "crosstab4",
  "connectby",
  "pg_stats",
  "pg_stats_ext",
  "pg_stats_ext_exprs",
  "pg_statistic",
  "pg_statistic_ext_data"
]);

/** The name Postgres reads: at most 63 bytes, cut at a character. */
function identifierName(text: string): string {
  const encoder = new TextEncoder();
  let name = "";
  for (const character of text) {
    if (encoder.encode(name + character).length > 63) break;
    name += character;
  }
  return name;
}

function unfilterable(message: string): never {
  throw new AppError("VALIDATION_FAILED", message, { reason: "scoped_sql_refused" });
}

/**
 * Every SQL read of a store with scoped tables, whoever wrote it: each scoped table it names
 * reads only the caller's rows. The statement gets a materialized CTE of the table's name in
 * front, so the table's name means the caller's rows wherever it stands, and no predicate of
 * the statement is evaluated on another row first. What would reach the table past that name
 * is refused: a schema-qualified name, an escaped identifier, and the functions above. A
 * caller with every value reads the table itself.
 */
export function scopedStatement(
  sql: string,
  tables: ScopedTables | undefined,
  access?: ActorAccess,
  parameters: readonly DataStoreParameter[] = []
) {
  if (!Object.keys(tables ?? {}).length) return { sql, parameters: [...parameters] };
  const tokens = sqlTokens(sql);
  const named = new Set<string>();
  tokens.forEach((token, index) => {
    if (token.kind !== "word" && token.kind !== "quoted") return;
    if (token.kind === "quoted" && token.unicode)
      unfilterable("SQL on a scoped Data Store spells identifiers without Unicode escapes");
    const name = identifierName(token.text);
    if (UNFILTERABLE.has(name)) unfilterable(`SQL on a scoped Data Store cannot use '${name}'`);
    if (!tables?.[name]) return;
    if (tokens[index - 1]?.text === ".")
      unfilterable(`Name scoped table '${name}' without a schema`);
    named.add(name);
  });
  const ctes: string[] = [];
  const bound = [...parameters];
  for (const table of named) {
    const filter = scopePredicate(tables, table, access, bound.length);
    if (filter.condition === "true") continue;
    ctes.push(
      `${quoteIdentifier(table)} as materialized (select * from public.${quoteIdentifier(table)} where ${filter.condition})`
    );
    bound.push(...filter.parameters);
  }
  if (!ctes.length) return { sql, parameters: bound };
  const [first, second] = tokens;
  if (first?.kind !== "word" || (first.text !== "select" && first.text !== "with"))
    unfilterable("Queries must be read-only SELECT or WITH statements");
  if (first.text === "select")
    return {
      sql: `${sql.slice(0, first.start)}with ${ctes.join(", ")} ${sql.slice(first.start)}`,
      parameters: bound
    };
  const at = second?.kind === "word" && second.text === "recursive" ? second.end : first.end;
  return { sql: `${sql.slice(0, at)} ${ctes.join(", ")},${sql.slice(at)}`, parameters: bound };
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
