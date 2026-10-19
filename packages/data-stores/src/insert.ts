import {
  POSTGRES_STATEMENT_TIMEOUT_MS,
  PostgresExecutorError
} from "@work-shape/catalyst-postgres-connector";
import {
  AppError,
  dataStoreInsertConflictSchema,
  dataStoreInsertResultSchema,
  type DataStoreInsertResult,
  type JsonObject
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { readTables } from "./catalog";
import { readUniqueIndexes, type UniqueIndex } from "./unique-indexes";
import { quoteIdentifier } from "./server";
import { storeSizeBytes } from "./size";
import { changeWhole, reclaim, storeFull, type StoreVerb } from "./verbs";
import {
  DATA_STORE_INSERT_MAX_ROWS,
  DATA_STORE_INSERT_MAX_BYTES,
  boundRowWrite,
  rowWriteRefusal,
  rowValuesSchema,
  tableNameSchema,
  refuseRecordManagedTable
} from "./row-write-input";

const insertInputSchema = z.strictObject({
  table: tableNameSchema,
  rows: z.array(rowValuesSchema).min(1),
  onConflict: dataStoreInsertConflictSchema
});

/** The columns the rows of one insert name: those of its first row, which every row shares. */
function sharedColumns(rows: readonly JsonObject[], locale: string): string[] {
  const columns = Object.keys(rows[0] ?? {});
  const differing = rows.findIndex((row) => {
    const keys = Object.keys(row);
    return keys.length !== columns.length || !columns.every((column) => column in row);
  });
  if (columns.length === 0 || differing !== -1) {
    throw rowWriteRefusal(
      "rows_differ",
      columns.length === 0
        ? "A row names at least one column"
        : `Row ${differing + 1} names other columns than row 1. All rows of one insert name the same columns; a column that is left out of all of them takes its default.`,
      columns.length === 0
        ? "Ein Datensatz muss mindestens eine Spalte angeben."
        : `Datensatz ${differing + 1} gibt andere Spalten als Datensatz 1 an. Alle Datensätze eines Aufrufs müssen dieselben Spalten angeben. Eine überall ausgelassene Spalte erhält ihren Standardwert.`,
      locale
    );
  }
  return columns;
}

const insertedRow = z.object({ count: z.number().int() });

type CatalogTable = Awaited<ReturnType<typeof readTables>>[number];

/**
 * The unique indexes `skip` may go by, or the refusal. The rule is one: a row is left out
 * only on a unique key that holds for all rows, is not deferrable, and whose columns every
 * row of the call gives. A key the call leaves to a default may be another one every time, an
 * index over a part of the rows binds no row for certain, and Postgres skips on no deferrable
 * constraint at all.
 */
function skipKeys(
  table: CatalogTable,
  given: readonly string[],
  indexes: readonly UniqueIndex[],
  locale: string
): UniqueIndex[] {
  if (indexes.some((index) => !index.immediate)) {
    throw rowWriteRefusal(
      "skip_deferrable_key",
      `The table '${table.name}' has a deferrable unique constraint, on which Postgres skips no row. Make the constraint not deferrable, or leave onConflict out.`,
      `Die Tabelle '${table.name}' hat eine aufschiebbare Eindeutigkeitsbedingung. PostgreSQL kann damit keine Datensätze überspringen. Mache die Bedingung nicht aufschiebbar oder lasse onConflict weg.`,
      locale
    );
  }
  const usable = indexes.filter(
    (index) =>
      !index.partial &&
      index.needs.length > 0 &&
      index.needs.every((column) => given.includes(column))
  );
  if (usable.length === 0) {
    throw rowWriteRefusal(
      "skip_without_key",
      `'skip' needs a unique constraint of the table '${table.name}' that holds for all rows, is not deferrable, and whose columns every row of the call gives. The table has none. Give the columns of such a key in every row, or leave onConflict out.`,
      `'skip' benötigt in Tabelle '${table.name}' eine nicht aufschiebbare Eindeutigkeitsbedingung für alle Datensätze, deren Spalten jeder gesendete Datensatz angibt. Gib die Spalten eines solchen Schlüssels in jedem Datensatz an oder lasse onConflict weg.`,
      locale
    );
  }
  return usable;
}

/**
 * The statement that answers the number of the first row whose key is empty in every index
 * `skip` goes by, or nothing: such a row never conflicts and would be added again. The
 * database itself works each key out for each row, so an expression that comes to nothing
 * counts as empty. The keys are the catalog's text and the rows one bound value.
 */
function emptyKeyStatement(
  table: CatalogTable,
  given: readonly string[],
  indexes: readonly UniqueIndex[]
): string {
  // Names of this statement's own that no column of the table has: a key names its columns
  // without their table.
  const free = (name: string): string =>
    table.columns.some((column) => column.name === name) ? free(`${name}_`) : name;
  const [value, row] = [free("sent_value"), free("sent_row")].map(quoteIdentifier);
  const sent = table.columns
    .filter((column) => given.includes(column.name))
    .map((column) => `${quoteIdentifier(column.name)} ${column.nativeType}`)
    .join(", ");
  const computed = table.columns
    .flatMap((column) =>
      column.generation === undefined
        ? []
        : [`(${column.generation}) as ${quoteIdentifier(column.name)}`]
    )
    .join(", ");
  const bound = indexes
    .map((index) =>
      index.nulls_not_distinct
        ? "true"
        : index.keys.map((key) => `(${key}) is not null`).join(" and ")
    )
    .map((condition) => `(${condition})`)
    .join(" or ");
  return `
    select pg_catalog.min(sent.${row})::pg_catalog.int4 as row
    from pg_catalog.jsonb_array_elements($1::pg_catalog.jsonb)
      with ordinality as sent(${value}, ${row}),
      lateral pg_catalog.jsonb_to_record(sent.${value}) as given(${sent})
      ${computed === "" ? "" : `, lateral (select ${computed}) as computed`}
    where not (${bound})`;
}

export const insert: StoreVerb = {
  verb: "insert",
  effect: "changing",
  // An added row is removed again with a statement, and nothing outside is told of it.
  changeClass: "reversible",
  inputSchema: insertInputSchema,
  outputSchema: dataStoreInsertResultSchema,
  use: `Adds rows to one table. Use it to record new rows; it changes and removes nothing that is stored. Name the table and send each row as an object of column name to value. All rows of one call name the same columns, and a column that is left out takes its default. "onConflict" says what happens to a row that a unique constraint of the table refuses: "fail", the default, adds no row of the call; "skip" leaves that row out and adds the others, which makes sending the same rows again safe. One call adds at most ${DATA_STORE_INSERT_MAX_ROWS} rows and ${DATA_STORE_INSERT_MAX_BYTES} bytes.`,
  async run({ runtime, store, target, keyed, context }, call) {
    const input = insertInputSchema.parse(call);
    const locale = context?.runtime.locale ?? runtime.defaultLocale;
    boundRowWrite(input.rows, locale);
    refuseRecordManagedTable(store, input.table, locale);
    const { record } = store;
    const columns = sharedColumns(input.rows, locale);
    const rows = JSON.stringify(input.rows);
    const [table] = await readTables(runtime.server.executor, target, input.table);
    if (!table)
      throw rowWriteRefusal(
        "table_unknown",
        `The store has no table '${input.table}'`,
        `Der Datenspeicher hat keine Tabelle '${input.table}'.`,
        locale
      );
    // The names and types that go into the statement are the catalog's, never a caller's text.
    const typeOf = new Map(
      table.columns.flatMap((column) =>
        column.generated ? [] : [[column.name, column.nativeType] as const]
      )
    );
    const unknown = columns.find((column) => !typeOf.has(column));
    if (unknown !== undefined) {
      throw rowWriteRefusal(
        "column_unknown",
        `The table '${table.name}' has no column '${unknown}' that an insert sets`,
        `Die Tabelle '${table.name}' hat keine beschreibbare Spalte '${unknown}'.`,
        locale
      );
    }
    const keys =
      input.onConflict === "skip"
        ? skipKeys(
            table,
            columns,
            await readUniqueIndexes(runtime.server.executor, target, table.name),
            locale
          )
        : [];
    const names = columns.map(quoteIdentifier).join(", ");
    // The rows are one bound value. Postgres reads each column of it by the column's type.
    const statement = `
      with inserted as (
        insert into public.${quoteIdentifier(table.name)} (${names})
        select ${names}
        from pg_catalog.jsonb_to_recordset($1::pg_catalog.jsonb)
          as rows(${columns.map((column) => `${quoteIdentifier(column)} ${typeOf.get(column)}`).join(", ")})
        ${input.onConflict === "skip" ? "on conflict do nothing" : ""}
        returning 1
      )
      select pg_catalog.count(*)::pg_catalog.int4 as count from inserted`;
    const full = (sizeBytes: number) => storeFull(record, sizeBytes, locale);
    // The size is the server's own word for the files of the store, read on a connection of
    // the platform's own, which nothing the store runs can have touched. It is read before
    // the rows are written and again once they are: whoever calls and from whichever
    // process, a store at its limit takes no further row.
    const size = () => storeSizeBytes(runtime.server, record.location.database, target.signal);
    const before = await size();
    if (before >= record.sizeLimitBytes) throw full(before);
    // Everything of one insert is one transaction as the app role, and a refusal rolls it
    // back. Whatever a change throws leaves it as a failure of the database, so the refusal
    // is kept here and raised once the change has rolled back.
    let refusal: AppError | undefined;
    const refuse = (error: AppError): never => {
      refusal = error;
      throw error;
    };
    let wrote = false;
    try {
      return await changeWhole(
        { runtime, keyed },
        { ...target, timeoutMs: POSTGRES_STATEMENT_TIMEOUT_MS },
        async (sql) => {
          if (keys.length > 0) {
            const [empty] = await sql.run(emptyKeyStatement(table, columns, keys), [rows]);
            const row = z.object({ row: z.number().nullable() }).parse(empty).row;
            if (row !== null) {
              refuse(
                new AppError(
                  "VALIDATION_FAILED",
                  locale === "de"
                    ? `Datensatz ${row} würde bei einem erneuten Aufruf nochmals hinzugefügt: Sein Schlüssel ist in jeder passenden Eindeutigkeitsbedingung der Tabelle '${table.name}' leer. Gib den Schlüssel in jedem Datensatz an oder verwende NULLS NOT DISTINCT für die Bedingung.`
                    : `Row ${row} would be added again by a repeated call: its key is empty in every unique constraint of the table '${table.name}' that the call gives the columns of. Set the key in every row, or make the constraint NULLS NOT DISTINCT.`,
                  { reason: "nullable_key", row }
                )
              );
            }
          }
          wrote = true;
          const [counted] = await sql.run(statement, [rows]);
          // What the store left to the end of the transaction, such as a deferred trigger,
          // happens now, before the size is read again: a default or a trigger may write far
          // more than the rows that were sent. An insert that took the store past its limit
          // is rolled back, so no row that is kept lies beyond it.
          await sql.script("set constraints all immediate");
          const after = await size();
          if (after > record.sizeLimitBytes) refuse(full(after));
          const inserted = insertedRow.parse(counted).count;
          return {
            table: table.name,
            inserted,
            skipped: input.rows.length - inserted
          } satisfies DataStoreInsertResult;
        }
      );
    } catch (error) {
      // Rows that were written and not kept still fill the files, which would keep the store
      // at its limit: the refusal for size and the statement that ran out of time give them back.
      const sizeRefusal = refusal !== undefined && refusal.code === "CONFLICT";
      const timedOut = error instanceof PostgresExecutorError && error.kind === "timeout";
      if (wrote && (sizeRefusal || timedOut)) await reclaim(runtime, record);
      throw refusal ?? error;
    }
  }
};
