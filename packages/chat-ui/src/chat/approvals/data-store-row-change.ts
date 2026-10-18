import { DATA_STORE_OPERATION_PREFIX } from "@work-shape/catalyst-core";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";

type Translate = TranslationContextValue["t"];

/** The row writes of a Data Store that a person confirms before they change rows. */
type RowChangeVerb = "insert" | "update" | "delete_rows";

type Fields = Record<string, unknown>;

/** One row of a held write: the key that finds it, the values it gets, or both. */
interface RowChangeEntry {
  key?: Fields;
  values?: Fields;
}

/**
 * A held row write of one Data Store, read from the input the call froze, with the store's
 * title as the server named the call's target. Without a title the question names the table;
 * the store's id is never shown.
 */
export interface DataStoreRowChange {
  verb: RowChangeVerb;
  table: string;
  title?: string;
  rows: RowChangeEntry[];
}

/** One block of the call's input as `CallInputs` draws it. */
interface RowChangeInput {
  key: string;
  value: string;
  truncated: boolean;
}

const SUMMARY: Record<RowChangeVerb, { one: TranslationKey; many: TranslationKey }> = {
  insert: { one: "operations.rowsInsertOne", many: "operations.rowsInsertMany" },
  update: { one: "operations.rowsUpdateOne", many: "operations.rowsUpdateMany" },
  delete_rows: { one: "operations.rowsDeleteOne", many: "operations.rowsDeleteMany" }
};

/**
 * The row write a call holds: `insert({ table, rows: [values] })`,
 * `update({ table, rows: [{ key, set }] })` or `delete_rows({ table, keys: [key] })` on
 * `data_store.<id>.<verb>`. Any other call, or an input of another shape, is none, and the
 * confirmation shows the input field by field as for every call.
 */
export function dataStoreRowChange(
  operation: string,
  input: unknown,
  targetTitle: string | undefined
): DataStoreRowChange | undefined {
  if (!operation.startsWith(DATA_STORE_OPERATION_PREFIX) || !isFields(input)) return undefined;
  // The id of a store holds no dot, so the name is the prefix, the id and the verb.
  const [store, verb, ...rest] = operation.slice(DATA_STORE_OPERATION_PREFIX.length).split(".");
  const table = typeof input.table === "string" ? input.table.trim() : "";
  if (!store || rest.length > 0 || !table) return undefined;
  const rows = rowsOf(verb, input);
  const title = targetTitle?.trim();
  return rows && rows.length > 0 && isRowChangeVerb(verb)
    ? { verb, table, ...(title ? { title } : {}), rows }
    : undefined;
}

function rowsOf(verb: string | undefined, input: Fields): RowChangeEntry[] | undefined {
  switch (verb) {
    case "insert":
      return everyRow(input.rows, (row) => (isFields(row) ? { values: row } : undefined));
    case "update":
      return everyRow(input.rows, (row) =>
        isFields(row) && isFields(row.key) && isFields(row.set)
          ? { key: row.key, values: row.set }
          : undefined
      );
    case "delete_rows":
      return everyRow(input.keys, (key) => (isFields(key) ? { key } : undefined));
    default:
      return undefined;
  }
}

/** All rows read, or none: a confirmation never lists part of a call as all of it. */
function everyRow(
  list: unknown,
  read: (row: unknown) => RowChangeEntry | undefined
): RowChangeEntry[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const rows = list.map(read);
  return rows.every((row) => row !== undefined) ? rows : undefined;
}

/** "Add 1 row to Holiday requests?", in the reader's language and with the count as it writes it. */
export function rowChangeSummary(
  change: DataStoreRowChange,
  t: Translate,
  locale: LocaleCode
): string {
  const count = change.rows.length;
  const keys = SUMMARY[change.verb];
  return t(count === 1 ? keys.one : keys.many, {
    count: new Intl.NumberFormat(locale).format(count),
    store: change.title ?? change.table
  });
}

/**
 * Every row of a write, a block each for the key that finds a row and the values it gets, one
 * `column: value` line per field. The operation bounds how many rows one call holds.
 */
export function rowChangeInputs(change: DataStoreRowChange, t: Translate): RowChangeInput[] {
  return change.rows.flatMap((row, index) => {
    const n = index + 1;
    const blocks: RowChangeInput[] = [];
    if (row.key) {
      blocks.push({ key: t("operations.rowKey", { n }), value: lines(row.key), truncated: false });
    }
    if (row.values) {
      blocks.push({
        key: t(row.key ? "operations.rowNewValues" : "operations.rowValues", { n }),
        value: lines(row.values),
        truncated: false
      });
    }
    return blocks;
  });
}

function lines(fields: Fields): string {
  return Object.entries(fields)
    .map(
      ([column, value]) => `${column}: ${typeof value === "string" ? value : JSON.stringify(value)}`
    )
    .join("\n");
}

function isRowChangeVerb(verb: string | undefined): verb is RowChangeVerb {
  return verb === "insert" || verb === "update" || verb === "delete_rows";
}

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
