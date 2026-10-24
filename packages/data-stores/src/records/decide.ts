import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { z } from "zod";
import {
  AppError,
  DATA_STORE_LOAD_DEFAULT_LIMITS,
  DATA_STORE_RECORD_OPERATIONS,
  KNOWLEDGE_BASE_ACTIONS,
  auditActorFromIdentity,
  dataStoreRecordsDecideInputSchema,
  isAuthenticatedServicePrincipal,
  recordColumnTakes,
  type DataStoreRecordsDecideInput,
  type DataStoreRecordsDecideOutput,
  type LocaleCode,
  type OperationExecutionContext
} from "@work-shape/catalyst-core";
import { readKeyIndexes, readTables } from "../catalog";
import { readRecordedCall } from "../calls";
import type { DataStoreRuntime } from "../runtime";
import { storeSizeBytes } from "../size";
import { assetResource } from "../store-audience";
import { AnsweredBefore, changeWhole, storeFull, type StoreVerb } from "../verbs";
import { coerceRecordKey } from "./merge";
import { projectRecords, recordLockName } from "./project";
import { requireRecordsUpgrade } from "./readiness";

// A person's decision in "Prüfen": confirm a candidate, correct it with the value the cited
// page holds, or assign a document whose object was not known to one. A confirmed or corrected
// candidate is pinned: it wins the field, and a later extraction of the same document leaves
// it as it is. A new decision on a field replaces the one before. The object is then computed
// again and written into the customer's table in the same transaction, as a proposal is. The
// audit names the table, the field and the action, never a value or a key.

const candidate = z.object({
  knowledge_base_id: z.string(),
  document_id: z.string(),
  value: z.json()
});

function refusal(
  locale: LocaleCode,
  reason: string,
  en: string,
  de: string,
  code: "VALIDATION_FAILED" | "NOT_FOUND" = "VALIDATION_FAILED"
): AppError {
  return new AppError(code, locale === "de" ? de : en, { reason });
}

/** The Knowledge Base a decision cites must be one the person may use, as its chip asks. */
async function requireCitationAccess(
  runtime: DataStoreRuntime,
  context: OperationExecutionContext,
  knowledgeBaseId: string
): Promise<void> {
  const record = await runtime.stores.dataStores.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: knowledgeBaseId
  });
  const asset = record?.ownerKnowledgeBaseId
    ? await runtime.stores.configAssets.getConfigAsset({
        clientInstanceId: runtime.clientInstanceId,
        kind: "knowledge_base",
        name: record.ownerKnowledgeBaseId
      })
    : undefined;
  if (asset?.id !== knowledgeBaseId)
    throw new AppError("NOT_FOUND", "The cited Knowledge Base is not available", {
      reason: "record_document_unavailable"
    });
  context.access.require(KNOWLEDGE_BASE_ACTIONS.use, assetResource(asset));
}

/**
 * A decision is a person's: from the page or from their own credential on the CLI. A Workflow
 * step, a schedule, an agent, an App or a service principal's key is refused, so the account
 * that proposes a field can never confirm it (`review.always`).
 */
function requirePerson(context: OperationExecutionContext, locale: LocaleCode): void {
  const { origin, actor } = context;
  if ((origin.kind === "user" || origin.kind === "cli") && !isAuthenticatedServicePrincipal(actor))
    return;
  throw new AppError(
    "FORBIDDEN",
    locale === "de"
      ? "Über ein Feld in „Prüfen“ entscheidet eine Person, auf der Seite des Data Stores oder mit ihrem eigenen Schlüssel in der CLI."
      : "A person decides a field in Review, on the Data Store's page or with their own key on the CLI.",
    { reason: "record_decision_person_required" }
  );
}

/** The statements of one decision, inside the transaction that also projects the object. */
async function decideField(
  sql: PostgresChangeStatements,
  input: DataStoreRecordsDecideInput,
  key: string | number | boolean,
  context: OperationExecutionContext,
  locale: LocaleCode,
  requireUse: (knowledgeBaseId: string) => Promise<void>
): Promise<void> {
  const encodedKey = JSON.stringify(key);
  const cited =
    input.documentId !== undefined && input.knowledgeBaseId !== undefined
      ? { knowledgeBaseId: input.knowledgeBaseId, documentId: input.documentId }
      : undefined;
  if (input.action === "assign") {
    // Each field of the document goes to the object. A field the document already cites for
    // that object keeps the candidate there, and the unassigned one goes.
    const waiting = z.array(z.object({ field_name: z.string() })).parse(
      await sql.run(
        `select field_name from catalyst.record_fields
         where table_name = $1::text and record_key is null
           and knowledge_base_id = $2::text and document_id = $3::text`,
        [input.table, input.knowledgeBaseId, input.documentId]
      )
    );
    if (!waiting.some((row) => row.field_name === input.field))
      throw refusal(
        locale,
        "record_field_unknown",
        "The document has no such field waiting for its object.",
        "Das Dokument hat kein solches Feld, das auf sein Objekt wartet.",
        "NOT_FOUND"
      );
    await sql.run(
      `delete from catalyst.record_fields r
       where r.table_name = $1::text and r.record_key is null
         and r.knowledge_base_id = $3::text and r.document_id = $4::text
         and exists (select 1 from catalyst.record_fields k
           where k.table_name = r.table_name and k.record_key = $2::jsonb
             and k.field_name = r.field_name and k.knowledge_base_id = r.knowledge_base_id
             and k.document_id = r.document_id)`,
      [input.table, encodedKey, input.knowledgeBaseId, input.documentId]
    );
    await sql.run(
      `update catalyst.record_fields set record_key = $2::jsonb
       where table_name = $1::text and record_key is null
         and knowledge_base_id = $3::text and document_id = $4::text`,
      [input.table, encodedKey, input.knowledgeBaseId, input.documentId]
    );
    return;
  }
  const candidates = z.array(candidate).parse(
    await sql.run(
      `select knowledge_base_id, document_id, value from catalyst.record_fields
       where table_name = $1::text and record_key = $2::jsonb and field_name = $3::text`,
      [input.table, encodedKey, input.field]
    )
  );
  const chosen = cited
    ? candidates.filter(
        (row) =>
          row.knowledge_base_id === cited.knowledgeBaseId && row.document_id === cited.documentId
      )
    : candidates;
  if (chosen.length === 0)
    throw refusal(
      locale,
      "record_field_unknown",
      "The object has no such field, or the document is no candidate for it.",
      "Das Objekt hat dieses Feld nicht, oder das Dokument ist kein Beleg dafür.",
      "NOT_FOUND"
    );
  // Without a citation the decision must be clear: one value to confirm, one candidate to correct.
  const values = new Set(chosen.map((row) => JSON.stringify(row.value)));
  if (!cited && (input.action === "confirm" ? values.size > 1 : chosen.length > 1))
    throw refusal(
      locale,
      "record_citation_required",
      "The candidates of this field disagree: name the document whose value you decide.",
      "Die Belege dieses Felds widersprechen sich: nenne das Dokument, über dessen Wert du entscheidest.",
      "VALIDATION_FAILED"
    );
  // Every candidate the decision pins comes from a Knowledge Base the person may use, cited or not.
  for (const knowledgeBaseId of new Set(chosen.map((row) => row.knowledge_base_id)))
    await requireUse(knowledgeBaseId);
  // A new decision replaces the one before. A correction wrote the person's value over the
  // candidate's, so the candidate no longer holds what its page says: it stays as evidence that
  // does not hold, never counted as read from the document, until the document is read again.
  await sql.run(
    `update catalyst.record_fields set state = 'extracted', decided_by = null, decided_at = null,
       evidence = case when state = 'corrected'
         then '{"status":"failed","reason":"value_not_parsed"}'::jsonb else evidence end
     where table_name = $1::text and record_key = $2::jsonb and field_name = $3::text
       and state in ('confirmed', 'corrected')`,
    [input.table, encodedKey, input.field]
  );
  for (const row of chosen)
    await sql.run(
      `update catalyst.record_fields
       set state = $6::text, value = coalesce($7::jsonb, value), decided_by = $8::text, decided_at = now()
       where table_name = $1::text and record_key = $2::jsonb and field_name = $3::text
         and knowledge_base_id = $4::text and document_id = $5::text`,
      [
        input.table,
        encodedKey,
        input.field,
        row.knowledge_base_id,
        row.document_id,
        input.action === "confirm" ? "confirmed" : "corrected",
        input.action === "correct" ? JSON.stringify(input.value) : null,
        context.actor.id
      ]
    );
}

export const recordsDecide: StoreVerb = {
  verb: "records.decide",
  effect: "changing",
  // A person can decide a field again; the evidence underneath stays.
  changeClass: "reversible",
  inputSchema: DATA_STORE_RECORD_OPERATIONS.decide.inputSchema,
  outputSchema: DATA_STORE_RECORD_OPERATIONS.decide.outputSchema,
  async run({ runtime, store, target, keyed, context }, call) {
    if (!context) throw new AppError("INTERNAL", "A decision needs the caller's context");
    const locale = context.runtime.locale ?? runtime.defaultLocale;
    requirePerson(context, locale);
    const input = dataStoreRecordsDecideInputSchema.parse(call);
    await requireRecordsUpgrade(
      {
        run: async (sql, parameters) =>
          (
            await runtime.server.executor.query({
              ...target,
              sql,
              ...(parameters ? { parameters } : {})
            })
          ).rows
      },
      store.record,
      locale
    );
    if (keyed) {
      const previous = await readRecordedCall(runtime, target, keyed);
      if (previous) throw new AnsweredBefore(previous);
    }
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
    const key = coerceRecordKey(keyColumn, input.key);
    if (key === null)
      throw refusal(
        locale,
        "record_key_invalid",
        `The key does not fit the column '${keyColumn.name}'.`,
        `Der Schlüssel passt nicht zur Spalte '${keyColumn.name}'.`
      );
    if (input.action === "correct") {
      const column = table.columns.find((candidate) => candidate.name === input.field);
      if (!column || !recordColumnTakes(column, input.value))
        throw refusal(
          locale,
          "record_field_unknown",
          `The column '${input.field}' does not take this value.`,
          `Die Spalte '${input.field}' nimmt diesen Wert nicht an.`
        );
    }
    const usable = new Set<string>();
    const requireUse = async (knowledgeBaseId: string) => {
      if (usable.has(knowledgeBaseId)) return;
      await requireCitationAccess(runtime, context, knowledgeBaseId);
      usable.add(knowledgeBaseId);
    };
    if (input.knowledgeBaseId !== undefined) await requireUse(input.knowledgeBaseId);
    const size = () =>
      storeSizeBytes(runtime.server, store.record.location.database, target.signal);
    const before = await size();
    if (before >= store.record.sizeLimitBytes) throw storeFull(store.record, before);
    const limits = runtime.limits.load ?? DATA_STORE_LOAD_DEFAULT_LIMITS;
    // The executor reports what a transaction throws as a failure of the database: a refusal
    // from inside it leaves as itself.
    let refused: AppError | undefined;
    const result = await changeWhole(
      { runtime, ...(keyed ? { keyed } : {}) },
      { ...target, timeoutMs: limits.timeoutMs },
      async (sql) => {
        try {
          await sql.run("select set_config('statement_timeout', $1, true)", [
            String(limits.timeoutMs)
          ]);
          const encodedKey = JSON.stringify(key);
          await sql.run(
            "select pg_advisory_xact_lock(hashtextextended($1::text,0))::text as held",
            [recordLockName(table.name, encodedKey)]
          );
          await decideField(sql, input, key, context, locale, requireUse);
          await projectRecords(sql, {
            table,
            rule,
            keys: [encodedKey],
            limits,
            record: store.record,
            size
          });
          return { decided: true } satisfies DataStoreRecordsDecideOutput;
        } catch (error) {
          if (error instanceof AppError) refused = error;
          throw error;
        }
      }
    ).catch((error: unknown) => {
      throw error instanceof AnsweredBefore ? error : (refused ?? error);
    });
    await context.audit
      .record({
        type: "data_store.record_decided",
        actor: auditActorFromIdentity(context.actor),
        status: "success",
        subject: store.record.id,
        correlationId: context.correlationId,
        metadata: {
          store: store.record.name,
          table: input.table,
          field: input.field,
          action: input.action,
          operationRunId: context.runId
        }
      })
      .catch(() => {
        // The decision committed already: an audit outage cannot be reported as a refusal.
        runtime.logger.error(
          { storeId: store.record.id },
          "A records decision completed but could not be audited"
        );
      });
    return result;
  }
};
