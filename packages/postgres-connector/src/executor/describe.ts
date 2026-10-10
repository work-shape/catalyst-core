import { z } from "zod";
import { PostgresExecutorError } from "./errors";
import { textArrayParameter, textParameter } from "./parameters";
import type { PostgresSession } from "./pool";

export interface PostgresRelationSummary {
  schema: string;
  name: string;
  type: "table" | "view" | "materialized_view" | "foreign_table";
  description?: string;
}

export interface PostgresRelationDescription extends PostgresRelationSummary {
  columns: { name: string; dataType: string; nullable: boolean; description?: string }[];
  primaryKey: string[];
  foreignKeys: {
    columns: string[];
    referencedSchema: string;
    referencedRelation: string;
    referencedColumns: string[];
  }[];
}

export interface PostgresDescribeResult {
  relations: PostgresRelationSummary[];
  relation?: PostgresRelationDescription;
  /** The list of relations was cut at the row cap. */
  truncated: boolean;
}

const relationRow = z.object({
  schema: z.string(),
  name: z.string(),
  type: z.enum(["table", "view", "materialized_view", "foreign_table"]),
  description: z.string().nullable()
});
const columnRow = z.object({
  name: z.string(),
  data_type: z.string(),
  nullable: z.boolean(),
  description: z.string().nullable()
});
const nameRow = z.object({ name: z.string() });
const foreignKeyRow = z.object({
  columns: z.array(z.string()),
  referenced_schema: z.string(),
  referenced_relation: z.string(),
  referenced_columns: z.array(z.string())
});

/**
 * The relations the account can read. With no schema configured that is every schema outside
 * the system ones. `$1` is the configured schemas, `$2` a relation name or null, `$3` its
 * schema or null.
 */
const READABLE_RELATIONS = `
  select
    namespace.nspname as schema,
    relation.relname as name,
    case relation.relkind
      when 'r' then 'table'
      when 'p' then 'table'
      when 'v' then 'view'
      when 'm' then 'materialized_view'
      when 'f' then 'foreign_table'
    end as type,
    pg_catalog.obj_description(relation.oid, 'pg_class') as description
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  where relation.relkind in ('r', 'p', 'v', 'm', 'f')
    and namespace.nspname not in ('pg_catalog', 'information_schema')
    and namespace.nspname not like 'pg\\_toast%'
    and namespace.nspname not like 'pg\\_temp%'
    and (cardinality($1::text[]) = 0 or namespace.nspname = any($1::text[]))
    and ($2::text is null or relation.relname = $2::text)
    and ($3::text is null or namespace.nspname = $3::text)
    and pg_catalog.has_schema_privilege(namespace.oid, 'usage')
    and pg_catalog.has_table_privilege(relation.oid, 'select')
  order by namespace.nspname, relation.relname
  limit $4::int
`;

const COLUMNS = `
  select
    attribute.attname as name,
    pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) as data_type,
    not attribute.attnotnull as nullable,
    pg_catalog.col_description(relation.oid, attribute.attnum) as description
  from pg_catalog.pg_class relation
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_attribute attribute on attribute.attrelid = relation.oid
  where namespace.nspname = $1::text
    and relation.relname = $2::text
    and attribute.attnum > 0
    and not attribute.attisdropped
  order by attribute.attnum
`;

const PRIMARY_KEY = `
  select attribute.attname as name
  from pg_catalog.pg_constraint constraint_record
  join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  join unnest(constraint_record.conkey) with ordinality key_column(attnum, position) on true
  join pg_catalog.pg_attribute attribute
    on attribute.attrelid = relation.oid and attribute.attnum = key_column.attnum
  where constraint_record.contype = 'p'
    and namespace.nspname = $1::text
    and relation.relname = $2::text
  order by key_column.position
`;

const FOREIGN_KEYS = `
  select
    to_json(array(
      select attribute.attname::text
      from unnest(constraint_record.conkey) with ordinality key_column(attnum, position)
      join pg_catalog.pg_attribute attribute
        on attribute.attrelid = relation.oid and attribute.attnum = key_column.attnum
      order by key_column.position
    )) as columns,
    referenced_namespace.nspname as referenced_schema,
    referenced_relation.relname as referenced_relation,
    to_json(array(
      select attribute.attname::text
      from unnest(constraint_record.confkey) with ordinality key_column(attnum, position)
      join pg_catalog.pg_attribute attribute
        on attribute.attrelid = referenced_relation.oid and attribute.attnum = key_column.attnum
      order by key_column.position
    )) as referenced_columns
  from pg_catalog.pg_constraint constraint_record
  join pg_catalog.pg_class relation on relation.oid = constraint_record.conrelid
  join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
  join pg_catalog.pg_class referenced_relation on referenced_relation.oid = constraint_record.confrelid
  join pg_catalog.pg_namespace referenced_namespace
    on referenced_namespace.oid = referenced_relation.relnamespace
  where constraint_record.contype = 'f'
    and namespace.nspname = $1::text
    and relation.relname = $2::text
  order by constraint_record.conname
`;

export interface DescribePostgresInput {
  schemas: readonly string[];
  /** How many relations the list holds at most. */
  maxRelations: number;
  relation?: string;
}

/**
 * Lists the relations the account can read in the configured schemas and, for one of them, its
 * columns, primary key and foreign keys. Names and comments come from the customer's database:
 * they are data for the caller, never text for a system prompt.
 */
export async function describePostgres(
  session: PostgresSession,
  input: DescribePostgresInput
): Promise<PostgresDescribeResult> {
  const listed = await readableRelations(session, input.schemas, {}, input.maxRelations + 1);
  const result = {
    relations: listed.slice(0, input.maxRelations),
    truncated: listed.length > input.maxRelations
  };
  if (input.relation === undefined) return result;

  const selected = await selectRelation(session, input.schemas, input.relation);
  const place = [textParameter(selected.schema), textParameter(selected.name)];
  const columns = z.array(columnRow).parse(await session.run(COLUMNS, place));
  const primaryKey = z.array(nameRow).parse(await session.run(PRIMARY_KEY, place));
  const foreignKeys = z.array(foreignKeyRow).parse(await session.run(FOREIGN_KEYS, place));
  return {
    ...result,
    relation: {
      ...selected,
      columns: columns.map((column) => ({
        name: column.name,
        dataType: column.data_type,
        nullable: column.nullable,
        ...(column.description ? { description: column.description } : {})
      })),
      primaryKey: primaryKey.map((column) => column.name),
      foreignKeys: foreignKeys.map((key) => ({
        columns: key.columns,
        referencedSchema: key.referenced_schema,
        referencedRelation: key.referenced_relation,
        referencedColumns: key.referenced_columns
      }))
    }
  };
}

async function selectRelation(
  session: PostgresSession,
  schemas: readonly string[],
  requested: string
): Promise<PostgresRelationSummary> {
  const parts = requested.trim().split(".");
  const [first, second] = parts;
  if (parts.length > 2 || first === undefined || parts.some((part) => part.length === 0)) {
    throw rejected("Relation must be an unqualified name or a schema-qualified name");
  }
  const wanted = second === undefined ? { name: first } : { schema: first, name: second };
  const [match, other] = await readableRelations(session, schemas, wanted, 2);
  if (match === undefined) throw rejected(`Readable relation '${requested}' was not found`);
  if (other !== undefined) {
    throw rejected(
      `Relation '${requested}' exists in multiple schemas; use a schema-qualified name`
    );
  }
  return match;
}

async function readableRelations(
  session: PostgresSession,
  schemas: readonly string[],
  wanted: { schema?: string; name?: string },
  limit: number
): Promise<PostgresRelationSummary[]> {
  const rows = await session.run(READABLE_RELATIONS, [
    textArrayParameter(schemas),
    textParameter(wanted.name ?? null),
    textParameter(wanted.schema ?? null),
    textParameter(String(limit))
  ]);
  return z
    .array(relationRow)
    .parse(rows)
    .map(({ description, ...relation }) => (description ? { ...relation, description } : relation));
}

function rejected(message: string): PostgresExecutorError {
  return new PostgresExecutorError("query_rejected", message);
}
