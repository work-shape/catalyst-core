import { DATA_STORE_OPERATION_PREFIX } from "@work-shape/catalyst-core";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import type { TranslationContextValue } from "../../shared/i18n";

type Translate = TranslationContextValue["t"];
type Fields = Record<string, unknown>;

/** The row writes of a Data Store that a person confirms, by the word their question uses. */
const VERBS = { insert: "Insert", update: "Update", delete_rows: "Delete" } as const;

/**
 * A held row write of one Data Store, read from the input the call froze, with the store's
 * title as the server named the call's target. Without a title the question names the table;
 * the store's id is never shown. Each row has the key that finds it, the values it gets, or both.
 */
export interface DataStoreRowChange {
  verb: keyof typeof VERBS;
  /** The store the call writes into, as its operation names it. */
  store: string;
  table: string;
  title?: string;
  rows: { key?: Fields; values?: Fields }[];
}

/**
 * The row write a call holds: `insert({ table, rows: [values] })`,
 * `update({ table, rows: [{ key, set }] })` or `delete_rows({ table, keys: [key] })` on
 * `data_store.<id>.<verb>`. Any other call, or an input of another shape, is none, and the
 * confirmation shows the input field by field as for every call. All rows read, or none: a
 * confirmation never lists part of a call as all of it.
 */
export function dataStoreRowChange(
  operation: string,
  input: unknown,
  targetTitle: string | undefined
): DataStoreRowChange | undefined {
  if (!operation.startsWith(DATA_STORE_OPERATION_PREFIX) || !isFields(input)) return undefined;
  // The id of a store holds no dot, so the name is the prefix, the id and the verb.
  const [store, verb, ...rest] = operation.slice(DATA_STORE_OPERATION_PREFIX.length).split(".");
  const table = input.table;
  const list = verb === "delete_rows" ? input.keys : input.rows;
  if (
    !store ||
    rest.length > 0 ||
    (verb !== "insert" && verb !== "update" && verb !== "delete_rows") ||
    typeof table !== "string" ||
    !table ||
    !Array.isArray(list) ||
    list.length === 0
  ) {
    return undefined;
  }
  const rows: DataStoreRowChange["rows"] = [];
  for (const row of list) {
    if (!isFields(row)) return undefined;
    if (verb === "insert") rows.push({ values: row });
    else if (verb === "delete_rows") rows.push({ key: row });
    else if (isFields(row.key) && isFields(row.set)) {
      rows.push({ key: row.key, values: row.set });
    } else return undefined;
  }
  return { verb, store, table, ...(targetTitle ? { title: targetTitle } : {}), rows };
}

/** "Add 1 row to Holiday requests?", in the reader's language and with the count as it writes it. */
export function rowChangeSummary(
  change: DataStoreRowChange,
  t: Translate,
  locale: LocaleCode
): string {
  const count = change.rows.length;
  return t(`operations.rows${VERBS[change.verb]}${count === 1 ? "One" : "Many"}`, {
    count: new Intl.NumberFormat(locale).format(count),
    store: change.title ?? change.table
  });
}

/**
 * The rows a change finds by key, as they stand now: read through the store's ordinary query with
 * the reader's own rights, so a reader who may not read the rows sees none of them.
 */
export type CurrentRows =
  { status: "read"; rows: readonly Fields[] } | { status: "unavailable" } | undefined;

/**
 * The one read-only statement that finds exactly the rows a change names by key: identifiers
 * quoted, every key value bound. None where the change names no key, or a key holds a value no
 * statement can bind as a plain value.
 */
export function keyedRowsQuery(
  change: DataStoreRowChange
): { sql: string; parameters: (string | number | boolean)[] } | undefined {
  const keys = change.rows.map((row) => row.key);
  if (keys.length === 0 || keys.some((key) => key === undefined)) return undefined;
  const parameters: (string | number | boolean)[] = [];
  const matches: string[] = [];
  for (const key of keys) {
    const columns = Object.entries(key ?? {});
    if (columns.length === 0) return undefined;
    const terms: string[] = [];
    for (const [column, value] of columns) {
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        return undefined;
      }
      parameters.push(value);
      terms.push(`${quoted(column)} = $${parameters.length}`);
    }
    matches.push(`(${terms.join(" and ")})`);
  }
  return {
    sql: `select * from ${quoted(change.table)} where ${matches.join(" or ")}`,
    parameters
  };
}

/** The row of a read whose key columns hold the key's values, as the database answers them. */
export function currentRow(key: Fields, rows: readonly Fields[]): Fields | undefined {
  return rows.find((row) =>
    Object.entries(key).every(([column, value]) => String(row[column]) === String(value))
  );
}

function quoted(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * The table of a write, then every row of it, a block each for the key that finds a row and the
 * values it gets, one `column: value` line per field, as `CallInputs` draws them. The operation
 * bounds the rows.
 */
export function rowChangeInputs(
  change: DataStoreRowChange,
  t: Translate,
  current: CurrentRows = undefined
) {
  const table = { key: t("operations.rowTable"), value: change.table, truncated: false };
  const rows = change.rows.flatMap(({ key, values }, index) => {
    const n = index + 1;
    const blocks = [];
    if (key)
      blocks.push({ key: t("operations.rowKey", { n }), value: lines(key, t), truncated: false });
    // The row as it stands, so the reader knows which one the key finds.
    const now = key && current?.status === "read" ? currentRow(key, current.rows) : undefined;
    if (now)
      blocks.push({ key: t("operations.rowNow", { n }), value: lines(now, t), truncated: false });
    if (values) {
      const label = t(key ? "operations.rowNewValues" : "operations.rowValues", { n });
      blocks.push({ key: label, value: lines(values, t), truncated: false });
    }
    return blocks;
  });
  return [table, ...rows];
}

/** One `column: value` line per field; a yes-or-no value in the reader's words. */
function lines(fields: Fields, t: Translate): string {
  return Object.entries(fields)
    .map(([column, value]) => `${column}: ${fieldValue(value, t)}`)
    .join("\n");
}

function fieldValue(value: unknown, t: Translate): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return t(value ? "operations.rowYes" : "operations.rowNo");
  return JSON.stringify(value);
}

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
