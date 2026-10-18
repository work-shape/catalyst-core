import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { z } from "zod";
import {
  AppError,
  DATA_STORE_RECORD_OPERATIONS,
  RECORD_FIELD_STATES,
  DATA_STORE_LOAD_DEFAULT_LIMITS,
  dataStoreRecordsProposeInputSchema,
  workflowDatasetReferenceSchema,
  recordEvidenceResultSchema,
  type JsonObject,
  type JsonValue,
  type OperationBatchFailure,
  type DataStoreRecordProposalItem
} from "@work-shape/catalyst-core";
import { readTables, readKeyIndexes } from "../catalog";
import { statementsOf } from "../load-statements";
import { recordProjection } from "./projection";
import { storeSizeBytes } from "../size";
import { AnsweredBefore, changeWhole, reclaim, storeFull, type StoreVerb } from "../verbs";
import { RECORD_FIELDS_SCHEMA, RECORD_FIELDS_CONTENT_HASH } from "./schema";
import { recordKey, mergeField } from "./merge";
import { recordEvidence } from "@work-shape/catalyst-core";
import { proposalSource } from "./source";

const candidateRow = z.object({
  field_name: z.string(),
  value: z.json(),
  kind: z.string(),
  document_date: z.string().nullable(),
  state: z.enum(RECORD_FIELD_STATES),
  evidence: recordEvidenceResultSchema
});

export const recordsPropose: StoreVerb = {
  verb: "records.propose",
  effect: "changing",
  changeClass: "irreversible",
  batch: true,
  inputSchema: DATA_STORE_RECORD_OPERATIONS.propose.inputSchema,
  outputSchema: DATA_STORE_RECORD_OPERATIONS.propose.outputSchema,
  timeoutMs: DATA_STORE_LOAD_DEFAULT_LIMITS.timeoutMs + 30_000,
  async run({ runtime, store, target, keyed, context }, call) {
    if (context?.origin.kind !== "workflow")
      throw new AppError(
        "VALIDATION_FAILED",
        context?.runtime.locale === "de"
          ? "`records.propose` läuft nur als Schritt eines Workflow Runs."
          : "`records.propose` runs only as a step of a Workflow Run.",
        { reason: "workflow_dataset_owner_required" }
      );
    if (!runtime.recordFailures)
      throw new AppError("CONFLICT", "Records proposals need failures dataset storage", {
        reason: "dataset_storage_unavailable"
      });
    const input = dataStoreRecordsProposeInputSchema.parse(call);
    const stepId = context.origin.kind === "workflow" ? context.origin.stepRunId : undefined;
    const replay = async (sql: Pick<PostgresChangeStatements, "run">) => {
      if (!stepId) return undefined;
      const [row] = await sql.run("select catalyst.recorded_load($1::text) as outcome", [stepId]);
      const stored = z
        .object({ records: DATA_STORE_RECORD_OPERATIONS.propose.outputSchema })
        .safeParse(row?.outcome);
      return stored.success ? stored.data.records : undefined;
    };
    const beforeReplay = await replay({
      run: async (sql, parameters) =>
        (
          await runtime.server.executor.query({
            ...target,
            sql,
            ...(parameters ? { parameters } : {})
          })
        ).rows
    });
    if (beforeReplay) return beforeReplay;

    const rule = store.definition.records?.find((candidate) => candidate.table === input.table);
    if (!rule)
      throw new AppError("VALIDATION_FAILED", "The table has no published records rule", {
        reason: "record_table_unknown"
      });
    const [table] = await readTables(runtime.server.executor, target, input.table);
    const keyColumn = table?.columns.find((column) => column.name === rule.key.column);
    if (
      !table ||
      !keyColumn ||
      !(await readKeyIndexes(runtime.server.executor, target, table.name, [rule.key.column])).length
    )
      throw new AppError("VALIDATION_FAILED", "The published records key is no longer unique", {
        reason: "record_key_invalid"
      });
    const size = () =>
      storeSizeBytes(runtime.server, store.record.location.database, target.signal);
    const before = await size();
    if (before >= store.record.sizeLimitBytes) throw storeFull(store.record, before);
    const failures: OperationBatchFailure[] = [];
    const valid: {
      item: DataStoreRecordProposalItem;
      source: NonNullable<Awaited<ReturnType<typeof proposalSource>>>;
      key: string | number | boolean | null;
    }[] = [];
    for (const item of input.items) {
      if (
        !DATA_STORE_RECORD_OPERATIONS.propose.itemSchemaFor(table.columns).safeParse(item).success
      ) {
        failures.push({
          item,
          code: "record_field_unknown",
          message: "A field has no writable column of a compatible type, or occurs twice"
        });
        continue;
      }
      const source = await proposalSource(runtime, item, context);
      if (!source) {
        failures.push({
          item,
          code: "record_document_unavailable",
          message: "The source document is not available"
        });
        continue;
      }
      valid.push({ item, source, key: recordKey(rule, item, keyColumn) });
    }
    // The additive setup reaches older customer stores as well as owned-store migration 8.
    const platformTarget = {
      ...runtime.server.asPlatform(store.record.location.database),
      ...(target.signal ? { signal: target.signal } : {})
    };
    await runtime.server.executor.change({ ...platformTarget, timeoutMs: 30_000 }, (sql) =>
      sql.script(RECORD_FIELDS_SCHEMA + RECORD_FIELDS_CONTENT_HASH)
    );
    const failureDataset = workflowDatasetReferenceSchema.parse(
      await runtime.recordFailures.write(failures, context)
    );
    if (failureDataset.rowCount !== failures.length)
      throw new AppError("INTERNAL", "The failures dataset does not match the proposal batch");
    const limits = runtime.limits.load ?? DATA_STORE_LOAD_DEFAULT_LIMITS;
    let refusal: AppError | undefined;
    let wrote = false;
    let replayed: Awaited<ReturnType<typeof replay>>;
    try {
      return await changeWhole(
        { runtime, keyed },
        { ...platformTarget, timeoutMs: limits.timeoutMs },
        async (sql) => {
          try {
            if (stepId) {
              await sql.run(
                "select pg_advisory_xact_lock(hashtextextended('catalyst load ' || $1::text,0))::text as held",
                [stepId]
              );
              replayed = await replay(sql);
              if (replayed) throw new AnsweredBefore({ ...replayed });
            }
            await sql.run("select set_config('statement_timeout', $1, true)", [
              String(limits.timeoutMs)
            ]);
            // Acquire object locks in one order so overlapping batches cannot deadlock.
            const keys = [...new Set(valid.map(({ key }) => JSON.stringify(key)))].sort();
            for (const key of keys)
              await sql.run(
                "select pg_advisory_xact_lock(hashtextextended($1::text,0))::text as held",
                [`records:${table.name}:${key}`]
              );
            for (const { item, source, key } of valid) {
              const live = await proposalSource(runtime, item, context);
              if (!live || live.content_sha256 !== source.content_sha256)
                throw new AppError(
                  "CONFLICT",
                  "A source document changed before the proposal was written; propose its current content again",
                  { reason: "record_document_changed" }
                );

              for (const field of item.fields) {
                const evidence = recordEvidence(
                  field.value,
                  field.quote,
                  source.pages.find((page) => page.page === field.page)?.text,
                  runtime.defaultLocale
                );
                wrote = true;
                await sql.run(
                  `insert into catalyst.record_fields
                (table_name,record_key,field_name,knowledge_base_id,document_id,kind,value,page,quote,document_date,extracted_at,evidence,state,content_sha256)
                values ($1::text,$2::jsonb,$3::text,$4::text,$5::text,$6::text,$7::jsonb,$8::int,$9::text,$10::date,now(),$11::jsonb,'extracted',$12::text)
                on conflict (table_name,record_key,field_name,knowledge_base_id,document_id) do update set
                  kind=excluded.kind,value=excluded.value,page=excluded.page,quote=excluded.quote,
                  document_date=excluded.document_date,extracted_at=excluded.extracted_at,evidence=excluded.evidence,state='extracted',content_sha256=excluded.content_sha256
                where catalyst.record_fields.state not in ('confirmed','corrected')`,
                  [
                    table.name,
                    key === null ? null : JSON.stringify(key),
                    field.name,
                    item.knowledgeBaseId,
                    item.documentId,
                    item.kind,
                    JSON.stringify(field.value),
                    field.page,
                    field.quote,
                    item.documentDate,
                    JSON.stringify(evidence),
                    source.content_sha256
                  ]
                );
              }
            }
            const counts = { inserted: 0, updated: 0, rows: 0, bytes: 0 };
            const projection = await recordProjection(sql, store.record.roles.app);
            for (const encodedKey of keys) {
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
              if (after > store.record.sizeLimitBytes) throw storeFull(store.record, after);
            }
            await projection.write(null, "[]");
            await projection.close();
            const result = {
              done: valid.length,
              failed: failures.length,
              failures: { ...failureDataset }
            };
            await sql.run("select catalyst.record_load($1::text,$2::jsonb)::text as recorded", [
              stepId ?? context.runId,
              JSON.stringify({
                table: table.name,
                inserted: counts.inserted,
                updated: counts.updated,
                skipped: 0,
                deleted: 0,
                records: result
              })
            ]);
            const after = await size();
            if (after > store.record.sizeLimitBytes) throw storeFull(store.record, after);
            return result;
          } catch (error) {
            if (error instanceof AppError) refusal = error;
            throw error;
          }
        }
      );
    } catch (error) {
      if (replayed) throw new AnsweredBefore({ ...replayed });
      if (wrote) await reclaim(runtime, store.record);
      throw refusal ?? error;
    }
  }
};
