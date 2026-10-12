import type {
  PostgresExecutor,
  PostgresQueryResult,
  PostgresTarget
} from "@vivd-catalyst/postgres-connector";
import {
  AppError,
  type DataStoreColumn,
  type DataStoreColumnType,
  type DataStoreRows,
  type DataStoreScalarType,
  type DataStoreTable
} from "@vivd-catalyst/core";
import { z } from "zod";

// What a store's database says of itself, in the product's own words: the tables of the
// schema `public` as the app role reads them from the catalog, and the product's name for a
// type the database names its own way.

/** The product's scalar type for each name Postgres gives a type without its length. */
const SCALAR_OF_NATIVE: Readonly<Record<string, DataStoreScalarType>> = {
  text: "text",
  "character varying": "text",
  character: "text",
  uuid: "text",
  smallint: "integer",
  integer: "integer",
  bigint: "integer",
  numeric: "number",
  real: "number",
  "double precision": "number",
  boolean: "boolean",
  date: "date",
  "timestamp with time zone": "timestamp",
  "timestamp without time zone": "timestamp"
};

/** The product's name of a type, from the database's: `numeric(12,2)[]` is `number[]`. */
function columnTypeOf(nativeType: string): DataStoreColumnType {
  const list = nativeType.endsWith("[]");
  const scalar = SCALAR_OF_NATIVE[nativeType.replace(/\[\]$/u, "").replace(/\(.*\)/u, "")];
  if (scalar === undefined) return "other";
  return list ? `${scalar}[]` : scalar;
}

/** A result of the executor as the contract answers rows: each column with both type names. */
export function rowsOf(result: PostgresQueryResult) {
  return {
    columns: result.columns.map((column) => ({
      name: column.name,
      type: columnTypeOf(column.type),
      nativeType: column.type
    })),
    rows: result.rows,
    truncated: result.truncated
  } satisfies DataStoreRows;
}

/**
 * The tables of `public` with their columns, or the one table of a name. The name is bound,
 * never written into the statement. The schema the platform keeps in the store is not read.
 */
const TABLES = `
  select c.relname as table_name,
    pg_catalog.obj_description(c.oid, 'pg_class') as table_comment,
    least(greatest(c.reltuples, 0), 2147483647)::integer as row_estimate,
    a.attname as column_name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) as native_type,
    not a.attnotnull as nullable,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid) as column_default,
    a.attgenerated <> '' as generated,
    pg_catalog.col_description(c.oid, a.attnum) as column_comment,
    exists (
      select 1 from pg_catalog.pg_index i
      where i.indrelid = c.oid and i.indisprimary and a.attnum = any (i.indkey)
    ) as primary_key
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_attribute a on a.attrelid = c.oid
  left join pg_catalog.pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
  where n.nspname = 'public' and c.relkind in ('r', 'p')
    and a.attnum > 0 and not a.attisdropped
    and ($1::text is null or c.relname = $1::text)
  order by c.relname, a.attnum
`;

const columnRow = z.object({
  table_name: z.string(),
  table_comment: z.string().nullable(),
  row_estimate: z.number(),
  column_name: z.string(),
  native_type: z.string(),
  nullable: z.boolean(),
  column_default: z.string().nullable(),
  generated: z.boolean(),
  column_comment: z.string().nullable(),
  primary_key: z.boolean()
});

/**
 * The target for a statement of the platform's own that reads the catalog: every name in it
 * means what the database means by it, whatever a migration put into `public`.
 */
export function catalogTarget(target: PostgresTarget): PostgresTarget {
  return { ...target, location: { ...target.location, schemas: ["pg_catalog"] } };
}

/** A column as `describe` answers it, and whether the database computes its value itself. */
type CatalogColumn = DataStoreColumn & { generated: boolean };

export async function readTables(
  executor: PostgresExecutor,
  target: PostgresTarget,
  table?: string
): Promise<(Omit<DataStoreTable, "columns"> & { columns: CatalogColumn[] })[]> {
  const read = await executor.query({
    ...catalogTarget(target),
    sql: TABLES,
    parameters: [{ type: "text", value: table ?? null }]
  });
  if (read.truncated) {
    throw new AppError(
      "CONFLICT",
      `The store has more columns than one read of its tables answers (${read.rows.length}, POSTGRES_RESULT_MAX_ROWS). Read one table at a time.`,
      { reason: "schema_too_large" }
    );
  }
  const tables = new Map<string, Omit<DataStoreTable, "columns"> & { columns: CatalogColumn[] }>();
  for (const row of z.array(columnRow).parse(read.rows)) {
    const known = tables.get(row.table_name) ?? {
      name: row.table_name,
      ...(row.table_comment === null ? {} : { comment: row.table_comment }),
      columns: [],
      rowEstimate: row.row_estimate
    };
    known.columns.push({
      name: row.column_name,
      type: columnTypeOf(row.native_type),
      nativeType: row.native_type,
      nullable: row.nullable,
      ...(row.column_default === null || row.generated ? {} : { default: row.column_default }),
      primaryKey: row.primary_key,
      ...(row.column_comment === null ? {} : { comment: row.column_comment }),
      generated: row.generated
    });
    tables.set(row.table_name, known);
  }
  return [...tables.values()];
}
