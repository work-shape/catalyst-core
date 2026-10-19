import {
  AppError,
  type DataStoreColumn,
  type JsonObject,
  type LocaleCode
} from "@work-shape/catalyst-core";
import {
  PostgresExecutorError,
  type PostgresExecutor,
  type PostgresTarget
} from "@work-shape/catalyst-postgres-connector";
import { z } from "zod";
import { catalogTarget, readTables } from "./catalog";
import { quoteIdentifier } from "./server";
import { describeDatabaseFailure } from "./failures";

const input = z.object({
  table: z.string(),
  rows: z.array(z.record(z.string(), z.json())).optional(),
  keys: z.array(z.record(z.string(), z.json())).optional()
});
const mutationRow = z.object({
  key: z.record(z.string(), z.json()),
  set: z.record(z.string(), z.json())
});
const columnNames = z.array(z.object({ name: z.string() }));
const TYPE_LABELS: Readonly<Record<string, { en: string; de: string }>> = {
  text: { en: "Text", de: "Text" },
  integer: { en: "Integer", de: "Ganzzahl" },
  number: { en: "Number", de: "Zahl" },
  boolean: { en: "Yes/No", de: "Ja/Nein" },
  date: { en: "Date", de: "Datum" },
  timestamp: { en: "Date and time", de: "Datum und Uhrzeit" },
  other: { en: "Value", de: "Wert" }
};

/** Only verified catalog labels reach the person; never diagnostics or row values. */
function label(column: DataStoreColumn, locale: LocaleCode): string {
  const list = column.type.endsWith("[]");
  const scalar = column.type.replace(/\[\]$/u, "");
  const type = TYPE_LABELS[scalar]?.[locale] ?? TYPE_LABELS.other?.[locale];
  const title = column.name
    .replace(/[_-]+/gu, " ")
    .replace(/^./u, (letter) => letter.toLocaleUpperCase(locale));
  return `„${title}“ (${type}${list ? (locale === "de" ? ", Liste" : ", list") : ""})`;
}

type Outage = "timeout" | "busy" | "cancelled" | "unavailable" | "permission" | "schema_changed";

function outageReason(error: PostgresExecutorError): Outage | undefined {
  switch (error.kind) {
    case "timeout":
    case "busy":
    case "cancelled":
    case "unavailable":
      return error.kind;
    case "unauthorized":
    case "network_denied":
    case "tls_failed":
      return "unavailable";
  }
  const state = error.sqlState;
  if (state === "40001" || state === "40P01" || state === "55P03") return "busy";
  if (state === "42501") return "permission";
  if (state === "42P01" || state === "42703") return "schema_changed";
  return undefined;
}

const OUTAGE_COPY: Readonly<Record<Outage, { en: string; de: string }>> = {
  timeout: {
    en: "The database took too long to write these rows. Try again with fewer rows, or later.",
    de: "Die Datenbank hat zu lange gebraucht, um diese Datensätze zu schreiben. Versuche es mit weniger Datensätzen oder später erneut."
  },
  busy: {
    en: "The database is busy right now. Try again in a moment.",
    de: "Die Datenbank ist gerade ausgelastet. Versuche es gleich noch einmal."
  },
  cancelled: {
    en: "The write was cancelled before it finished. Start it again if the rows are still needed.",
    de: "Das Schreiben wurde abgebrochen, bevor es fertig war. Starte es erneut, wenn die Datensätze noch gebraucht werden."
  },
  unavailable: {
    en: "The database cannot be reached right now. Try again later; if it keeps failing, tell an administrator.",
    de: "Die Datenbank ist gerade nicht erreichbar. Versuche es später erneut; wenn es weiter fehlschlägt, wende dich an einen Administrator."
  },
  permission: {
    en: "The Data Store's database refused this write for lack of rights. Ask an administrator to check the Data Store.",
    de: "Die Datenbank des Datenspeichers hat das Schreiben mangels Rechten abgelehnt. Bitte einen Administrator, den Datenspeicher zu prüfen."
  },
  schema_changed: {
    en: "The table changed while these rows were being written. Look up its columns again and try again.",
    de: "Die Tabelle wurde geändert, während die Datensätze geschrieben wurden. Sieh dir ihre Spalten erneut an und versuche es noch einmal."
  }
};

/**
 * Row writes have no caller-authored SQL to diagnose. After rollback, explain a refusal in
 * the person's language. Other verbs retain their author-facing database diagnostics.
 */
export async function rowWriteDatabaseFailure(
  executor: PostgresExecutor,
  target: PostgresTarget,
  error: unknown,
  raw: unknown,
  verb: string,
  locale?: string
): Promise<AppError | undefined> {
  if (!(error instanceof PostgresExecutorError)) return undefined;
  const parsed = input.safeParse(raw);
  if (!parsed.success) return undefined;
  const language = locale === "de" ? "de" : "en";
  const code = describeDatabaseFailure(error, "The write").code;
  // The database did not judge the rows: say what to do next, and ask the catalog nothing.
  const outage = outageReason(error);
  if (outage) {
    const message = OUTAGE_COPY[outage][language];
    return new AppError(code, message, { reason: outage }, { exposeMessage: true });
  }
  const state = error.sqlState;
  const reason =
    state === "23502"
      ? "required"
      : state === "23505"
        ? "unique"
        : state === "23503"
          ? "reference"
          : state === "22001"
            ? "too_long"
            : state === "22003"
              ? "out_of_range"
              : state?.startsWith("22")
                ? "invalid_value"
                : "database_refusal";
  let columns: DataStoreColumn[] = [];
  // Only a refused value or constraint (classes 22 and 23) names a column worth looking up.
  const judged = state?.startsWith("22") === true || state?.startsWith("23") === true;
  try {
    const [table] = judged
      ? await readTables(executor, target, error.constraint?.table ?? parsed.data.table)
      : [];
    if (table) {
      const constraint = error.constraint;
      if (constraint?.table === table.name) {
        if (constraint.column)
          columns = table.columns.filter((column) => column.name === constraint.column);
        else if (constraint.name) {
          const found = await executor.query({
            ...catalogTarget(target),
            sql: `select distinct a.attname::text as name
              from pg_catalog.pg_class t
              join pg_catalog.pg_namespace n on n.oid = t.relnamespace
              join pg_catalog.pg_attribute a on a.attrelid = t.oid and a.attnum > 0 and not a.attisdropped
              where n.nspname = 'public' and t.relname = $1 and (
                exists (select 1 from pg_catalog.pg_constraint c where c.conrelid = t.oid and c.conname = $2 and a.attnum = any(c.conkey))
                or exists (select 1 from pg_catalog.pg_index i join pg_catalog.pg_class x on x.oid = i.indexrelid where i.indrelid = t.oid and i.indisunique and x.relname = $2 and a.attnum = any((i.indkey::int2[])[0:i.indnkeyatts - 1])))`,
            parameters: [table.name, constraint.name]
          });
          const names = new Set(columnNames.parse(found.rows).map((column) => column.name));
          columns = table.columns.filter((column) => names.has(column.name));
        }
      }
      if (state?.startsWith("22")) {
        const rows: JsonObject[] = (parsed.data.rows ?? parsed.data.keys ?? []).flatMap((row) => {
          if (verb !== "update") return [row];
          const mutation = mutationRow.parse(row);
          return [mutation.key, mutation.set];
        });
        // The original JSON conversion reports no column. Recheck only the supplied columns,
        // read-only, using exactly that conversion. Count forces every row to be converted.
        // This is a bounded failure path, never extra work on a successful write.
        for (const column of table.columns) {
          if (!rows.some((row) => Object.hasOwn(row, column.name))) continue;
          try {
            await executor.query({
              ...catalogTarget(target),
              sql: `select count(${quoteIdentifier(column.name)})::int as count from pg_catalog.jsonb_to_recordset($1::pg_catalog.jsonb) as given(${quoteIdentifier(column.name)} ${column.nativeType})`,
              parameters: [
                JSON.stringify(rows.map((row) => ({ [column.name]: row[column.name] ?? null })))
              ]
            });
          } catch (cause) {
            if (cause instanceof PostgresExecutorError && cause.sqlState?.startsWith("22")) {
              columns = [column];
              break;
            }
          }
        }
      }
    }
  } catch {
    // A catalog/probe outage must neither replace the original refusal nor expose raw text.
  }
  // A changed value another table still points at: the verified constraint is on that table.
  const referenced =
    verb === "update" &&
    error.constraint?.table !== undefined &&
    error.constraint.table !== parsed.data.table;
  const field =
    columns.length > 0
      ? columns.map((column) => label(column, language)).join(", ")
      : language === "de"
        ? "einer Spalte"
        : "a column";
  const en: Record<string, string> = {
    required: `A value is required in ${field}. Fill it in and try again.`,
    unique: `A value in ${field} already exists. Use a different value.`,
    reference:
      verb === "delete_rows"
        ? `A row is still referenced in ${field}. Remove those references first, or keep the row.`
        : referenced
          ? `A value of this row is still referenced in ${field}. Change those references first, or keep the value.`
          : `A value in ${field} refers to a row that does not exist. Choose an existing row.`,
    too_long: `A value in ${field} is too long. Shorten it and try again.`,
    out_of_range: `A value in ${field} is outside the allowed range. Check it and try again.`,
    invalid_value: `A value does not fit ${field}. Check its type and try again.`,
    database_refusal:
      "The database could not accept these rows. Check the table's requirements and try again."
  };
  const de: Record<string, string> = {
    required: `In ${field} ist ein Wert erforderlich. Fülle ihn aus und versuche es erneut.`,
    unique: `Ein Wert in ${field} ist bereits vorhanden. Verwende einen anderen Wert.`,
    reference:
      verb === "delete_rows"
        ? `Ein Datensatz wird in ${field} noch verwendet. Entferne zuerst die Verweise oder behalte den Datensatz.`
        : referenced
          ? `Ein Wert dieses Datensatzes wird in ${field} noch verwendet. Ändere zuerst die Verweise oder behalte den Wert.`
          : `Ein Wert in ${field} verweist auf einen Datensatz, den es nicht gibt. Wähle einen vorhandenen Datensatz.`,
    too_long: `Ein Wert in ${field} ist zu lang. Kürze ihn und versuche es erneut.`,
    out_of_range: `Ein Wert in ${field} liegt außerhalb des erlaubten Bereichs. Prüfe ihn und versuche es erneut.`,
    invalid_value: `Ein Wert passt nicht zu ${field}. Prüfe den Typ und versuche es erneut.`,
    database_refusal:
      "Die Datenbank konnte diese Datensätze nicht annehmen. Prüfe die Vorgaben der Tabelle und versuche es erneut."
  };
  return new AppError(
    code,
    (language === "de" ? de : en)[reason] ?? "",
    { reason },
    { exposeMessage: true }
  );
}
