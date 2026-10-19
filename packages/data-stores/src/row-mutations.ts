import { AppError, type JsonObject } from "@work-shape/catalyst-core";
import {
  POSTGRES_STATEMENT_TIMEOUT_MS,
  PostgresExecutorError
} from "@work-shape/catalyst-postgres-connector";
import { z } from "zod";
import { readTables } from "./catalog";
import { readUniqueIndexes } from "./unique-indexes";
import { quoteIdentifier } from "./server";
import { storeSizeBytes } from "./size";
import { changeWhole, reclaim, storeFull, type StoreVerb } from "./verbs";
import {
  DATA_STORE_INSERT_MAX_ROWS,
  DATA_STORE_INSERT_MAX_BYTES,
  boundRowWrite,
  refuseRecordManagedTable,
  rowValuesSchema,
  rowWriteRefusal,
  tableNameSchema
} from "./row-write-input";

const updateInputSchema = z.strictObject({
  table: tableNameSchema,
  rows: z.array(z.strictObject({ key: rowValuesSchema, set: rowValuesSchema })).min(1)
});
const deleteInputSchema = z.strictObject({
  table: tableNameSchema,
  keys: z.array(rowValuesSchema).min(1)
});
const counted = z.object({ count: z.number().int().nonnegative() });

/** Both mutations use catalog types for bound JSON and the existing keyed writer transaction. */
function mutation(verb: "update" | "delete_rows"): StoreVerb {
  return {
    verb,
    effect: "changing",
    changeClass: "irreversible",
    inputSchema: verb === "update" ? updateInputSchema : deleteInputSchema,
    outputSchema:
      verb === "update"
        ? z.strictObject({ table: z.string(), updated: z.number().int().nonnegative() })
        : z.strictObject({ table: z.string(), deleted: z.number().int().nonnegative() }),
    use: `${verb === "update" ? "Changes existing rows" : "Removes existing rows"} of one table by every column of its primary key. ${verb === "update" ? "Send {table, rows: [{key: {primary_key: value}, set: {column: new_value}}]}; key columns cannot be changed." : "Send {table, keys: [{primary_key: value}]}. A removed row cannot be restored by this tool."} Use describe to learn the columns first. A missing or duplicate key refuses the whole call; no row changes. One call carries at most ${DATA_STORE_INSERT_MAX_ROWS} rows and ${DATA_STORE_INSERT_MAX_BYTES} bytes. Report a write only after its confirmed count. A records-managed table must be corrected through records review.`,
    async run({ runtime, store, target, keyed, context }, call) {
      const input =
        verb === "update" ? updateInputSchema.parse(call) : deleteInputSchema.parse(call);
      const changes = "rows" in input ? input.rows : input.keys.map((key) => ({ key, set: {} }));
      const locale = context?.runtime.locale ?? runtime.defaultLocale;
      boundRowWrite("rows" in input ? input.rows : input.keys, locale);
      refuseRecordManagedTable(store, input.table, locale);
      const refuse = (reason: string, en: string, de: string): never => {
        throw rowWriteRefusal(reason, en, de, locale);
      };
      const [table] = await readTables(runtime.server.executor, target, input.table);
      if (!table)
        return refuse(
          "table_unknown",
          "The store has no such table.",
          "Der Datenspeicher hat diese Tabelle nicht."
        );
      const primary = table.columns.filter((column) => column.primaryKey);
      if (primary.length === 0)
        return refuse(
          "primary_key_required",
          "This table has no primary key. Add one with a migration before changing rows.",
          "Diese Tabelle hat keinen Primärschlüssel. Füge ihn mit einer Migration hinzu, bevor du Datensätze änderst."
        );
      // Assigning a source column also changes a generated primary key. Reuse the catalog's
      // dependency list rather than parsing the generation expression.
      const keyColumns = new Set(primary.map((column) => column.name));
      if (verb === "update" && primary.some((column) => column.generated)) {
        for (const index of await readUniqueIndexes(runtime.server.executor, target, table.name)) {
          if (index.primary_key) for (const name of index.needs) keyColumns.add(name);
        }
      }
      const columns = new Map(table.columns.map((column) => [column.name, column]));
      for (const { key, set } of changes) {
        for (const name of [...Object.keys(key), ...Object.keys(set)]) {
          const column = columns.get(name);
          // A computed column can identify a row; only assigning to it is forbidden.
          if (!column || (column.generated && Object.hasOwn(set, name)))
            return refuse(
              "column_unknown",
              "The call names an unknown or generated column. Use describe to check writable columns.",
              "Der Aufruf nennt eine unbekannte oder berechnete Spalte. Prüfe die beschreibbaren Spalten mit describe."
            );
        }
        if (
          Object.keys(key).length !== primary.length ||
          primary.some((column) => !(column.name in key) || key[column.name] === null)
        )
          return refuse(
            "primary_key_incomplete",
            "Each key must give every primary-key column and no other column, with no null value.",
            "Jeder Schlüssel muss genau die Primärschlüsselspalten angeben, keine davon leer."
          );
        if (Object.keys(set).some((name) => keyColumns.has(name)))
          return refuse(
            "key_column_in_set",
            "A primary-key column cannot be changed in set.",
            "Eine Primärschlüsselspalte darf in set nicht geändert werden."
          );
        if (verb === "update" && Object.keys(set).length === 0)
          return refuse(
            "empty_set",
            "Give at least one column to change in set.",
            "Gib in set mindestens eine zu ändernde Spalte an."
          );
      }
      const relation = `public.${quoteIdentifier(table.name)}`;
      const keyTypes = primary
        .map((column) => `${quoteIdentifier(column.name)} ${column.nativeType}`)
        .join(", ");
      const keyNames = primary.map((column) => quoteIdentifier(column.name)).join(", ");
      const where = primary
        .map(
          (column) =>
            `stored.${quoteIdentifier(column.name)} = given.${quoteIdentifier(column.name)}`
        )
        .join(" and ");
      const size = () =>
        storeSizeBytes(runtime.server, store.record.location.database, target.signal);
      if (verb === "update") {
        const before = await size();
        if (before >= store.record.sizeLimitBytes) throw storeFull(store.record, before, locale);
      }
      // Executor failures sanitize database text. Preserve only our fixed refusal after rollback.
      let refusal: AppError | undefined;
      let wrote = false;
      try {
        return await changeWhole<JsonObject>(
          { runtime, keyed },
          { ...target, timeoutMs: POSTGRES_STATEMENT_TIMEOUT_MS },
          async (sql): Promise<JsonObject> => {
            const reject = (reason: string, en: string, de: string): never => {
              refusal = rowWriteRefusal(reason, en, de, locale);
              throw refusal;
            };
            // Compare typed keys in Postgres: e.g. integer 1 and string "1" name the same row.
            const duplicate = await sql.run(
              `select 1 as duplicate from pg_catalog.jsonb_to_recordset($1::pg_catalog.jsonb) as given(${keyTypes}) group by ${keyNames} having count(*) > 1 limit 1`,
              [JSON.stringify(changes.map(({ key }) => key))]
            );
            if (duplicate.length > 0)
              reject(
                "duplicate_key",
                "A primary key is named twice. Send each row once.",
                "Ein Primärschlüssel ist doppelt angegeben. Sende jeden Datensatz nur einmal."
              );
            // Lock and check every requested row before writing any. Concurrent writers cannot
            // remove a checked row before its change; any later refusal rolls the whole call back.
            for (const { key } of changes) {
              const matched = await sql.run(
                `select 1 as matched from ${relation} as stored, pg_catalog.jsonb_to_record($1::pg_catalog.jsonb) as given(${keyTypes}) where ${where} for update of stored`,
                [JSON.stringify(key)]
              );
              if (matched.length !== 1)
                reject(
                  "key_not_found",
                  "A primary key matches no row. Nothing was changed.",
                  "Ein Primärschlüssel findet keinen Datensatz. Es wurde nichts geändert."
                );
            }
            let total = 0;
            for (const { key, set } of changes) {
              const written = table.columns.filter((column) => Object.hasOwn(set, column.name));
              const setTypes = written
                .map((column) => `${quoteIdentifier(column.name)} ${column.nativeType}`)
                .join(", ");
              const assignment = written
                .map(
                  (column) =>
                    `${quoteIdentifier(column.name)} = changed.${quoteIdentifier(column.name)}`
                )
                .join(", ");
              const statement =
                verb === "update"
                  ? `update ${relation} as stored set ${assignment} from pg_catalog.jsonb_to_record($1::pg_catalog.jsonb) as given(${keyTypes}), pg_catalog.jsonb_to_record($2::pg_catalog.jsonb) as changed(${setTypes}) where ${where}`
                  : `delete from ${relation} as stored using pg_catalog.jsonb_to_record($1::pg_catalog.jsonb) as given(${keyTypes}) where ${where}`;
              wrote = true;
              const [result] = await sql.run(
                `with changed_rows as (${statement} returning 1) select count(*)::pg_catalog.int4 as count from changed_rows`,
                verb === "update"
                  ? [JSON.stringify(key), JSON.stringify(set)]
                  : [JSON.stringify(key)]
              );
              total += counted.parse(result).count;
            }
            await sql.script("set constraints all immediate");
            if (verb === "update") {
              const after = await size();
              if (after > store.record.sizeLimitBytes) {
                refusal = storeFull(store.record, after, locale);
                throw refusal;
              }
            }
            return verb === "update"
              ? { table: table.name, updated: total }
              : { table: table.name, deleted: total };
          }
        );
      } catch (error) {
        if (
          wrote &&
          (refusal?.code === "CONFLICT" ||
            (error instanceof PostgresExecutorError && error.kind === "timeout"))
        )
          await reclaim(runtime, store.record);
        throw refusal ?? error;
      }
    }
  };
}

export const update = mutation("update");
export const deleteRows = mutation("delete_rows");
