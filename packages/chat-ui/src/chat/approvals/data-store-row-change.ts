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
  return { verb, table, ...(targetTitle ? { title: targetTitle } : {}), rows };
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
 * The table of a write, then every row of it, a block each for the key that finds a row and the
 * values it gets, one `column: value` line per field, as `CallInputs` draws them. The operation
 * bounds the rows.
 */
export function rowChangeInputs(change: DataStoreRowChange, t: Translate) {
  const table = { key: t("operations.rowTable"), value: change.table, truncated: false };
  const rows = change.rows.flatMap(({ key, values }, index) => {
    const n = index + 1;
    const blocks = [];
    if (key)
      blocks.push({ key: t("operations.rowKey", { n }), value: lines(key), truncated: false });
    if (values) {
      const label = t(key ? "operations.rowNewValues" : "operations.rowValues", { n });
      blocks.push({ key: label, value: lines(values), truncated: false });
    }
    return blocks;
  });
  return [table, ...rows];
}

function lines(fields: Fields): string {
  return Object.entries(fields)
    .map(
      ([column, value]) => `${column}: ${typeof value === "string" ? value : JSON.stringify(value)}`
    )
    .join("\n");
}

function isFields(value: unknown): value is Fields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
