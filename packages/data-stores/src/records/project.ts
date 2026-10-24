import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { z } from "zod";
import {
  AppError,
  RECORD_FIELD_STATES,
  recordEvidenceResultSchema,
  type DataStoreRecord,
  type DataStoreRecordsRule,
  type JsonObject,
  type JsonValue
} from "@work-shape/catalyst-core";
import type { readTables } from "../catalog";
import { statementsOf } from "../load-statements";
import { storeFull } from "../verbs";
import { mergeField } from "./merge";
import { recordProjection } from "./projection";

const candidateRow = z.object({
  field_name: z.string(),
  value: z.json(),
  kind: z.string(),
  document_date: z.string().nullable(),
  state: z.enum(RECORD_FIELD_STATES),
  evidence: recordEvidenceResultSchema
});

type Table = Awaited<ReturnType<typeof readTables>>[number];

/** The lock every writer of one object takes, in the transaction that changes its candidates. */
export function recordLockName(table: string, encodedKey: string): string {
  return `records:${table}:${encodedKey}`;
}

/**
 * Computes each field of the objects again from their candidates and writes the winners into
 * the customer's table through `load`'s write path, in the caller's transaction. A field that
 * has no winner is written empty. Each candidate's state follows: `conflict` where equal
 * evidence disagrees, `extracted` otherwise; a person's decision stays as it is.
 */
export async function projectRecords(
  sql: PostgresChangeStatements,
  input: {
    table: Table;
    rule: DataStoreRecordsRule;
    /** The keys as JSON text, in the order their locks were taken. */
    keys: readonly string[];
    limits: { rows: number; bytes: number };
    record: DataStoreRecord;
    size: () => Promise<number>;
  }
): Promise<{ inserted: number; updated: number }> {
  const { table, rule, limits, record, size } = input;
  const counts = { inserted: 0, updated: 0, rows: 0, bytes: 0 };
  const projection = recordProjection(sql);
  for (const encodedKey of input.keys) {
    if (encodedKey === "null") continue;
    const key: unknown = JSON.parse(encodedKey);
    const candidates = z.array(candidateRow).parse(
      await sql.run(
        `select field_name,value,kind,document_date::text,state,evidence from catalyst.record_fields
              where table_name=$1::text and record_key=$2::jsonb`,
        [table.name, encodedKey]
      )
    );
    const fields: [string, JsonValue][] = [
      [rule.key.column, z.union([z.string(), z.number(), z.boolean()]).parse(key)]
    ];
    for (const name of new Set(candidates.map((candidate) => candidate.field_name))) {
      if (name === rule.key.column) continue;
      const merged = mergeField(
        rule,
        name,
        candidates
          .filter((candidate) => candidate.field_name === name)
          .map((candidate) => ({ ...candidate, documentDate: candidate.document_date }))
      );
      fields.push([name, merged.value]);
      await sql.run(
        `update catalyst.record_fields set state=$4::text where table_name=$1::text and record_key=$2::jsonb and field_name=$3::text and state not in ('confirmed','corrected')`,
        [table.name, encodedKey, name, merged.conflict ? "conflict" : "extracted"]
      );
    }
    const row: JsonObject = Object.fromEntries<JsonValue>(fields);
    const text = JSON.stringify(row);
    counts.rows++;
    counts.bytes += Buffer.byteLength(text);
    if (counts.rows > limits.rows || counts.bytes > limits.bytes)
      throw new AppError(
        "VALIDATION_FAILED",
        "The records projection exceeds dataStores.load.rows or dataStores.load.bytes; split the proposals or raise the operator ceilings",
        { reason: "load_too_large" }
      );
    const plan = statementsOf(
      {
        table: table.name,
        key: [rule.key.column],
        onConflict: "update",
        dataset: { $dataset: "records", rowCount: 1, bytes: Buffer.byteLength(text) }
      },
      table,
      new Map(
        table.columns
          .filter((column) => !column.generated)
          .map((column) => [column.name, column.nativeType])
      ),
      Object.keys(row),
      false
    );
    const written = await projection.write(plan.write, `[${text}]`);
    counts.inserted += written.inserted;
    counts.updated += written.updated;
    const after = await size();
    if (after > record.sizeLimitBytes) throw storeFull(record, after);
  }
  await projection.write(null, "[]");
  return { inserted: counts.inserted, updated: counts.updated };
}
