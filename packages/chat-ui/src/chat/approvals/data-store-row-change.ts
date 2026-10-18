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
  const table = typeof input.table === "string" ? input.table.trim() : "";
  if (verb !== "insert" && verb !== "update" && verb !== "delete_rows") return undefined;
  const list = verb === "delete_rows" ? input.keys : input.rows;
  if (!store || rest.length > 0 || !table || !Array.isArray(list) || list.length === 0) {
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
  const title = targetTitle?.trim();
  return { verb, table, ...(title ? { title } : {}), rows };
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
 * Every row of a write, a block each for the key that finds a row and the values it gets, one
 * `column: value` line per field, as `CallInputs` draws them. The operation bounds the rows.
 */
export function rowChangeInputs(change: DataStoreRowChange, t: Translate) {
  return change.rows.flatMap(({ key, values }, index) => {
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
