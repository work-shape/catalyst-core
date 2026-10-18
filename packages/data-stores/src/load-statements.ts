import {
  AppError,
  dataStoreLoadInputSchema,
  type JsonValue,
  type JsonObject
} from "@work-shape/catalyst-core";
import type { z } from "zod";
import { replacementStatements } from "./load-replace";
import { quoteIdentifier } from "./server";
function refused(message: string, details: JsonObject): AppError {
  return new AppError("VALIDATION_FAILED", message, details);
}
/** The statements of one load, each over the rows of one part as one bound value. */
export interface LoadStatements {
  /** The fields of a row that are loaded, each with the column it goes to. */
  fields: readonly (readonly [field: string, column: string])[];
  /** Answers the first row whose key is empty and the first whose key the load holds already. */
  check?: string;
  /**
   * Takes, for the rest of the transaction, the lock of each value of `replace.by` the part
   * holds. It binds the rows and the name of the table.
   */
  lock?: string;
  remove?: string;
  write: string;
}

type LoadInput = z.infer<typeof dataStoreLoadInputSchema>;

export function statementsOf(
  input: LoadInput,
  table: { name: string; columns: readonly { name: string }[] },
  typeOf: ReadonlyMap<string, string>,
  firstFields: readonly string[],
  keyMayBeEmpty: boolean
): LoadStatements {
  const fields = input.columns
    ? Object.entries(input.columns)
    : firstFields.map((field) => [field, field] as const);
  const columns = fields.map(([, column]) => column);
  if (columns.length === 0) {
    throw refused("A row names at least one column", { reason: "rows_differ" });
  }
  const twice = columns.find((column, index) => columns.indexOf(column) !== index);
  if (twice !== undefined) {
    throw refused(`'columns' names the column '${twice}' for two fields of a row`, {
      reason: "column_twice"
    });
  }
  const unknown = columns.find((column) => !typeOf.has(column));
  if (unknown !== undefined) {
    throw refused(`The table '${table.name}' has no column '${unknown}' that a load sets`, {
      reason: "column_unknown"
    });
  }
  const missing = input.key?.find((column) => !columns.includes(column));
  if (missing !== undefined) {
    throw refused(
      `The key names the column '${missing}', which the load does not set. Every row gives every column of the key.`,
      { reason: "key_not_loaded" }
    );
  }
  const stored = `public.${quoteIdentifier(table.name)}`;
  const typed = (names: readonly string[]) =>
    names.map((column) => `${quoteIdentifier(column)} ${typeOf.get(column)}`).join(", ");
  const sentOf = (names: readonly string[]) =>
    `pg_catalog.jsonb_to_recordset($1::pg_catalog.jsonb) as sent(${typed(names)})`;
  const listed = (names: readonly string[], of?: string) =>
    names.map((column) => `${of ? `${of}.` : ""}${quoteIdentifier(column)}`).join(", ");
  // A row this transaction wrote, whichever statement of it: the load holds its key already.
  const own = `stored.xmin operator(pg_catalog.=) pg_catalog.pg_current_xact_id()::pg_catalog.xid`;
  const key = input.key ?? [];
  // A name of this statement's own that no column of the table has.
  const free = (name: string): string =>
    table.columns.some((column) => column.name === name) ? free(`${name}_`) : name;
  const row = quoteIdentifier(free("sent_row"));
  const check =
    key.length === 0
      ? undefined
      : `
    with sent as materialized (
      select ${listed(key, "sent")}, sent.${row}
      from rows from (pg_catalog.jsonb_to_recordset($1::pg_catalog.jsonb) as (${typed(key)}))
        with ordinality as sent(${listed(key)}, ${row})
    )
    select
      (select pg_catalog.min(sent.${row}) from sent
        where ${keyMayBeEmpty ? key.map((column) => `sent.${quoteIdentifier(column)} is null`).join(" or ") : "false"}
      )::pg_catalog.int4 as empty,
      (select pg_catalog.min(twice.${row}) from (
        select pg_catalog.max(sent.${row}) as ${row} from sent
        group by ${listed(key, "sent")} having pg_catalog.count(*) > 1
        union all
        select sent.${row} from sent
        join ${stored} as stored
          on ${key.map((column) => `stored.${quoteIdentifier(column)} = sent.${quoteIdentifier(column)}`).join(" and ")}
        where ${own}
      ) as twice)::pg_catalog.int4 as twice`;
  const replace =
    input.replace && input.replace.values === undefined
      ? replacementStatements(table.name, typeOf, input.replace.by)
      : undefined;
  // `update` writes every column of the row that is no key; a column the load does not set
  // keeps what is stored.
  const changed = columns.filter((column) => !key.includes(column));
  const conflict =
    input.onConflict === "fail"
      ? ""
      : `on conflict (${listed(key)}) ${
          input.onConflict === "skip"
            ? "do nothing"
            : `do update set ${(changed.length > 0 ? changed : key)
                .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
                .join(", ")}`
        }`;
  // A row an `update` changed carries the transaction that changed it; a row it added none.
  const added =
    input.onConflict === "update"
      ? `stored.xmax::pg_catalog.text operator(pg_catalog.=) '0'`
      : "true";
  const write = `
    with written as (
      insert into ${stored} as stored (${listed(columns)})
      select ${listed(columns, "sent")} from ${sentOf(columns)}
      ${conflict}
      returning (${added}) as added
    )
    select pg_catalog.count(*) filter (where added)::pg_catalog.int4 as inserted,
      pg_catalog.count(*) filter (where not added)::pg_catalog.int4 as updated
    from written`;
  return {
    fields,
    ...(check ? { check } : {}),
    ...(replace ? { lock: replace.lock, remove: replace.remove } : {}),
    write
  };
}

/** One row as its statement reads it: an object of column to value. */
export function rowOf(
  statements: LoadStatements,
  mapped: boolean,
  row: JsonObject,
  number: number
): string {
  // Entries preserve every catalog column name, including __proto__, as an own property.
  // A field 'columns' names and a row lacks is empty in that row.
  const shaped = statements.fields.map(([field, column]): readonly [string, JsonValue] => [
    column,
    row[field] ?? null
  ]);
  if (
    !mapped &&
    (Object.keys(row).length !== statements.fields.length ||
      !statements.fields.every(([field]) => field in row))
  ) {
    throw refused(
      `Row ${number} names other fields than row 1. Without 'columns' all rows of a dataset name the same fields, each the name of a column.`,
      { reason: "rows_differ", row: number }
    );
  }
  return JSON.stringify(Object.fromEntries<JsonValue>(shaped));
}
