import { z } from "zod";
import type { PostgresExecutor, PostgresTarget } from "@work-shape/catalyst-postgres-connector";
import { catalogTarget } from "./catalog";

/**
 * The unique indexes of a table, each with its keys as the database writes them (a column or
 * an expression) and the columns a row must hold for the key to be worked out: those the key
 * names, and for a column the database computes, the columns it computes it from. A column an
 * index only carries (`include`) is no key.
 */
const UNIQUE_INDEXES = `
  select i.indisprimary as primary_key, i.indnullsnotdistinct as nulls_not_distinct,
    i.indimmediate as immediate,
    i.indpred is not null as partial,
    array(
      select pg_catalog.pg_get_indexdef(i.indexrelid, key, true)
      from pg_catalog.generate_series(1, i.indnkeyatts) key order by key
    ) as keys,
    array(
      select distinct base.attname::text
      from pg_catalog.pg_attribute used
      left join pg_catalog.pg_attrdef def
        on def.adrelid = used.attrelid and def.adnum = used.attnum and used.attgenerated <> ''
      left join pg_catalog.pg_depend derived
        on derived.refclassid = 'pg_catalog.pg_class'::regclass
        and derived.refobjid = used.attrelid and derived.refobjsubid > 0
        and ((derived.classid = 'pg_catalog.pg_attrdef'::regclass and derived.objid = def.oid)
          or (derived.classid = 'pg_catalog.pg_class'::regclass
            and derived.objid = used.attrelid and derived.objsubid = used.attnum
            and used.attgenerated <> ''))
        and derived.refobjsubid <> used.attnum
      join pg_catalog.pg_attribute base
        on base.attrelid = used.attrelid
        and base.attnum = coalesce(derived.refobjsubid, used.attnum)
      where used.attrelid = i.indrelid and used.attnum > 0 and (
        used.attnum = any ((i.indkey::int2[])[0:i.indnkeyatts - 1])
        or (0 = any (i.indkey::int2[]) and exists (
          select 1 from pg_catalog.pg_depend expression
          where expression.classid = 'pg_catalog.pg_class'::regclass
            and expression.objid = i.indexrelid and expression.refobjid = i.indrelid
            and expression.refobjsubid = used.attnum)))
    ) as needs
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = $1 and i.indisunique
`;

const uniqueIndexRow = z.object({
  primary_key: z.boolean(),
  nulls_not_distinct: z.boolean(),
  immediate: z.boolean(),
  partial: z.boolean(),
  keys: z.array(z.string()),
  needs: z.array(z.string())
});

export type UniqueIndex = z.infer<typeof uniqueIndexRow>;

/** The unique keys and their dependencies, as the database computes them. */
export async function readUniqueIndexes(
  executor: PostgresExecutor,
  target: PostgresTarget,
  table: string
): Promise<UniqueIndex[]> {
  return z
    .array(uniqueIndexRow)
    .parse(
      (await executor.query({ ...catalogTarget(target), sql: UNIQUE_INDEXES, parameters: [table] }))
        .rows
    );
}
