import type { PostgresChangeStatements } from "@vivd-catalyst/postgres-connector";
import {
  AppError,
  DATA_STORE_LOAD_CHANGE_RIGHT,
  dataStoreLoadInputSchema,
  dataStoreLoadResultSchema,
  dataStoreOperationName,
  type DataStoreLoadResult,
  type JsonObject
} from "@vivd-catalyst/core";
import { z } from "zod";
import { catalogTarget, readTables } from "./catalog";
import { quoteIdentifier } from "./server";
import { storeSizeBytes } from "./size";
import { reclaim, storeFull, tableUnknown, type StoreVerb } from "./verbs";

// `load`: the rows of a dataset of a Workflow Run into one table of a store, all in one
// transaction as the app role. A reader of the table sees the rows as they were until the
// load is kept, and then all of it: also where it replaces rows. It holds to what an insert
// holds to, and to a bound of its own on one call.

/** How many rows one load takes at most. A larger dataset is loaded in several calls. */
const DATA_STORE_LOAD_MAX_ROWS = 100_000;
/** How large the rows of one load are at most, as JSON, in bytes. */
const DATA_STORE_LOAD_MAX_BYTES = 67_108_864;
/** How many rows one statement of a load writes at most. */
const DATA_STORE_LOAD_STATEMENT_ROWS = 1_000;
/** How large the rows of one statement of a load are at most, as JSON, in bytes: one row where a row is larger. */
const DATA_STORE_LOAD_STATEMENT_BYTES = 1_048_576;
/**
 * How long one load may take in all, in milliseconds. Each of its statements ends at the
 * statement timeout of the app role, and a reader that gives no rows for
 * `idleInTransactionTimeoutMs` of that role ends the load in the database.
 */
const DATA_STORE_LOAD_TIMEOUT_MS = 300_000;
/** How much longer than the load its run may stay `running` before it counts as interrupted, in milliseconds. */
const DATA_STORE_LOAD_RUN_GRACE_MS = 30_000;

function refused(message: string, details: JsonObject): AppError {
  return new AppError("VALIDATION_FAILED", message, details);
}

function tooLarge(cap: "ROWS" | "BYTES", actual: number): AppError {
  const [limit, unit] =
    cap === "ROWS" ? [DATA_STORE_LOAD_MAX_ROWS, "rows"] : [DATA_STORE_LOAD_MAX_BYTES, "bytes"];
  return refused(
    `The dataset has ${cap === "ROWS" ? "" : "rows of "}${actual} ${unit} or more. One load takes at most ${DATA_STORE_LOAD_MAX_ROWS} rows (DATA_STORE_LOAD_MAX_ROWS) and ${DATA_STORE_LOAD_MAX_BYTES} bytes of rows (DATA_STORE_LOAD_MAX_BYTES, as JSON); load it in several calls.`,
    { reason: "load_too_large", cap: `DATA_STORE_LOAD_MAX_${cap}`, limit, actual }
  );
}

/**
 * The unique indexes over exactly the columns of a key that hold for every row at once: not
 * over a part of the rows, not deferrable, and over no expression.
 */
const KEY_INDEXES = `
  select i.indnullsnotdistinct as nulls_not_distinct
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = $1
    and i.indisunique and i.indimmediate and i.indpred is null and i.indexprs is null
    and array(
      select a.attname::text
      from pg_catalog.pg_attribute a
      where a.attrelid = i.indrelid
        and a.attnum = any ((i.indkey::int2[])[0:i.indnkeyatts - 1])
      order by a.attname::text collate "C"
    ) = $2::text[]
`;

const keyIndexRow = z.object({ nulls_not_distinct: z.boolean() });
const checkedRow = z.object({ empty: z.number().nullable(), twice: z.number().nullable() });
const deletedRow = z.object({ count: z.number().int() });
const writtenRow = z.object({ inserted: z.number().int(), updated: z.number().int() });

/** The statements of one load, each over the rows of one part as one bound value. */
interface LoadStatements {
  /** The fields of a row that are loaded, each with the column it goes to. */
  fields: readonly (readonly [field: string, column: string])[];
  /** Answers the first row whose key is empty and the first whose key the load holds already. */
  check?: string;
  remove?: string;
  write: string;
}

type LoadInput = z.infer<typeof dataStoreLoadInputSchema>;

function statementsOf(
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
  const by = input.replace?.by;
  const remove = by
    ? `
    with gone as (
      delete from ${stored} as stored
      where (${listed(by, "stored")}) in (select ${listed(by, "sent")} from ${sentOf(by)})
        and not (${own})
      returning 1
    )
    select pg_catalog.count(*)::pg_catalog.int4 as count from gone`
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
  return { fields, ...(check ? { check } : {}), ...(remove ? { remove } : {}), write };
}

/** One row as its statement reads it: an object of column to value. */
function rowOf(
  statements: LoadStatements,
  mapped: boolean,
  row: JsonObject,
  number: number
): string {
  const shaped: Record<string, unknown> = {};
  // A field 'columns' names and a row lacks is empty in that row.
  for (const [field, column] of statements.fields) shaped[column] = row[field] ?? null;
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
  return JSON.stringify(shaped);
}

export const load: StoreVerb = {
  verb: "load",
  effect: "changing",
  // A load that replaces or updates leaves nothing of the rows that were there.
  changeClass: "irreversible",
  // Its caller is a step of a Workflow Run, with nobody there to confirm: as for an insert,
  // the rights on this one store are what lets it, and a setting of the instance tightens it.
  defaultPolicy: "allow",
  inputSchema: dataStoreLoadInputSchema,
  outputSchema: dataStoreLoadResultSchema,
  timeoutMs: DATA_STORE_LOAD_TIMEOUT_MS + DATA_STORE_LOAD_RUN_GRACE_MS,
  // Adding rows is `data_store.insert`. Changing or removing rows that are stored is more.
  furtherRights(call) {
    const input = dataStoreLoadInputSchema.safeParse(call);
    return !input.success || input.data.onConflict === "update" || input.data.replace
      ? [DATA_STORE_LOAD_CHANGE_RIGHT]
      : [];
  },
  async run({ runtime, store, target }, call) {
    const input = dataStoreLoadInputSchema.parse(call);
    const { record } = store;
    const reader = runtime.datasets;
    if (!reader) {
      throw refused(
        `${dataStoreOperationName(record.name, "load")} is not supported yet: a dataset of a Workflow Run cannot be loaded into a Data Store by this release. Add rows with ${dataStoreOperationName(record.name, "insert")}.`,
        { reason: "not_supported_yet" }
      );
    }
    // What the reference says is refused before a row is read. What the dataset holds is
    // counted as it is read, since a reference is a caller's word.
    if (input.dataset.rowCount > DATA_STORE_LOAD_MAX_ROWS) {
      throw tooLarge("ROWS", input.dataset.rowCount);
    }
    if (input.dataset.bytes > DATA_STORE_LOAD_MAX_BYTES) {
      throw tooLarge("BYTES", input.dataset.bytes);
    }
    const [table] = await readTables(runtime.server.executor, target, input.table);
    if (!table) throw tableUnknown(input.table);
    // The names and types that go into the statements are the catalog's, never a caller's text.
    const typeOf = new Map(
      table.columns.flatMap((column) =>
        column.generated ? [] : [[column.name, column.nativeType] as const]
      )
    );
    let keyMayBeEmpty = false;
    if (input.key) {
      const indexes = z.array(keyIndexRow).parse(
        (
          await runtime.server.executor.query({
            ...catalogTarget(target),
            sql: KEY_INDEXES,
            parameters: [table.name, { type: "text[]", value: [...input.key].sort() }]
          })
        ).rows
      );
      if (indexes.length === 0) {
        throw refused(
          `The table '${table.name}' has no unique constraint over exactly the columns of the key (${input.key.join(", ")}) that holds for all rows and is not deferrable. Name as key the columns of such a constraint.`,
          { reason: "key_without_constraint" }
        );
      }
      keyMayBeEmpty = !indexes.some((index) => index.nulls_not_distinct);
    }
    const size = () => storeSizeBytes(runtime.server, record.location.database, target.signal);
    const before = await size();
    if (before >= record.sizeLimitBytes) throw storeFull(record, before);

    const counts = { rows: 0, bytes: 0, inserted: 0, updated: 0, deleted: 0 };
    let statements: LoadStatements | undefined;
    // Whatever a change throws leaves it as a failure of the database, so a refusal is kept
    // here and raised once the change has rolled back.
    let refusal: AppError | undefined;
    let wrote = false;

    /** Checks and writes the rows of one statement, the first of which is row `first` of the dataset. */
    async function writePart(
      sql: PostgresChangeStatements,
      { check, remove, write }: LoadStatements,
      rows: readonly string[],
      first: number
    ): Promise<void> {
      const part = `[${rows.join(",")}]`;
      if (check) {
        const { empty, twice } = checkedRow.parse((await sql.run(check, [part]))[0]);
        if (empty !== null) {
          throw refused(
            `Row ${first + empty - 1} has an empty key. A row without a key is never found again, so a later load would add it once more. Set every column of the key in every row.`,
            { reason: "nullable_key", row: first + empty - 1 }
          );
        }
        if (twice !== null) {
          throw refused(
            `Row ${first + twice - 1} has the key of a row before it. A dataset holds each key once.`,
            { reason: "duplicate_key", row: first + twice - 1 }
          );
        }
      }
      wrote = true;
      if (remove) counts.deleted += deletedRow.parse((await sql.run(remove, [part]))[0]).count;
      const written = writtenRow.parse((await sql.run(write, [part]))[0]);
      counts.inserted += written.inserted;
      counts.updated += written.updated;
      // The size is read as for an insert, after every statement: a load that takes the store
      // past its limit ends there and not at its last row.
      const after = await size();
      if (after > record.sizeLimitBytes) throw storeFull(record, after);
    }

    try {
      await runtime.server.executor.change(
        { ...target, timeoutMs: DATA_STORE_LOAD_TIMEOUT_MS },
        async (sql) => {
          try {
            let pending: string[] = [];
            let pendingBytes = 0;
            let written = 0;
            const flush = async (plan: LoadStatements) => {
              if (pending.length === 0) return;
              await writePart(sql, plan, pending, written + 1);
              written += pending.length;
              pending = [];
              pendingBytes = 0;
            };
            for await (const rows of reader.read(input.dataset, target.signal)) {
              for (const row of rows) {
                statements ??= statementsOf(input, table, typeOf, Object.keys(row), keyMayBeEmpty);
                counts.rows += 1;
                if (counts.rows > DATA_STORE_LOAD_MAX_ROWS) throw tooLarge("ROWS", counts.rows);
                const text = rowOf(statements, input.columns !== undefined, row, counts.rows);
                const bytes = Buffer.byteLength(text);
                counts.bytes += bytes;
                if (counts.bytes > DATA_STORE_LOAD_MAX_BYTES) throw tooLarge("BYTES", counts.bytes);
                if (
                  pending.length === DATA_STORE_LOAD_STATEMENT_ROWS ||
                  pendingBytes + bytes > DATA_STORE_LOAD_STATEMENT_BYTES
                ) {
                  await flush(statements);
                }
                pending.push(text);
                pendingBytes += bytes;
              }
            }
            if (statements) await flush(statements);
            // What the store left to the end of the transaction happens now, before the size
            // is read for the last time.
            await sql.script("set constraints all immediate");
            const after = await size();
            if (after > record.sizeLimitBytes) throw storeFull(record, after);
          } catch (error) {
            if (error instanceof AppError) refusal = error;
            throw error;
          }
        }
      );
    } catch (error) {
      // Rows that were written and not kept still fill the files of the store.
      if (wrote) await reclaim(runtime, record);
      throw refusal ?? error;
    }
    return {
      table: table.name,
      inserted: counts.inserted,
      updated: counts.updated,
      skipped: counts.rows - counts.inserted - counts.updated,
      deleted: counts.deleted
    } satisfies DataStoreLoadResult;
  }
};
