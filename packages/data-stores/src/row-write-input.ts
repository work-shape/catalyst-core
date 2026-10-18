import { AppError, type JsonObject } from "@work-shape/catalyst-core";
import { z } from "zod";
import type { PublishedStore } from "./verbs";

/** Bounds one chat row write; larger work is refused and must be split into calls. */
export const DATA_STORE_INSERT_MAX_ROWS = 1_000;
/** Bounds the JSON rows of one chat row write; larger work is refused before SQL. */
export const DATA_STORE_INSERT_MAX_BYTES = 1_048_576;
/** Postgres keeps at most this many characters of a table or column name. */
const DATA_STORE_IDENTIFIER_MAX_CHARS = 63;
export const tableNameSchema = z.string().min(1).max(DATA_STORE_IDENTIFIER_MAX_CHARS);
export const rowValuesSchema = z.record(tableNameSchema, z.json());

/** Fixed messages never quote row keys or values, which also keeps refusals out of audit. */
export function rowWriteRefusal(reason: string, en: string, de: string, locale?: string): AppError {
  return new AppError("VALIDATION_FAILED", locale === "de" ? de : en, { reason });
}

export function boundRowWrite(rows: readonly JsonObject[], locale?: string): void {
  if (rows.length > DATA_STORE_INSERT_MAX_ROWS)
    throw rowWriteRefusal(
      "rows_too_many",
      `One call carries at most ${DATA_STORE_INSERT_MAX_ROWS} rows (DATA_STORE_INSERT_MAX_ROWS); send them in several calls.`,
      `Ein Aufruf umfasst höchstens ${DATA_STORE_INSERT_MAX_ROWS} Datensätze (DATA_STORE_INSERT_MAX_ROWS). Teile sie auf mehrere Aufrufe auf.`,
      locale
    );
  if (Buffer.byteLength(JSON.stringify(rows)) > DATA_STORE_INSERT_MAX_BYTES)
    throw rowWriteRefusal(
      "rows_too_large",
      `One call carries at most ${DATA_STORE_INSERT_MAX_BYTES} bytes (DATA_STORE_INSERT_MAX_BYTES); send them in several calls.`,
      `Ein Aufruf umfasst höchstens ${DATA_STORE_INSERT_MAX_BYTES} Bytes (DATA_STORE_INSERT_MAX_BYTES). Teile sie auf mehrere Aufrufe auf.`,
      locale
    );
}

/** Only the records projection may write a published rule's table, through the load path. */
export function refuseRecordManagedTable(
  store: PublishedStore,
  table: string,
  locale?: string
): void {
  if (store.definition.records?.some((rule) => rule.table === table))
    throw rowWriteRefusal(
      "record_managed_table",
      "This table is managed by records. Submit corrections through the records review.",
      "Diese Tabelle wird durch Records verwaltet. Reiche Korrekturen über die Records-Prüfung ein.",
      locale
    );
}
