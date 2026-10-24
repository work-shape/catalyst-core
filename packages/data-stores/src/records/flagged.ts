import { z } from "zod";
import {
  AppError,
  DATA_STORE_RECORD_OPERATIONS,
  KNOWLEDGE_BASE_ACTIONS,
  RECORD_FIELD_STATES,
  RECORD_FLAG_REASONS,
  dataStoreRecordsFlaggedInputSchema,
  recordEvidenceResultSchema,
  type ActorAccess,
  type DataStoreRecordsFlaggedOutput,
  type DataStoreRecordsRule
} from "@work-shape/catalyst-core";
import type { PostgresTarget } from "@work-shape/catalyst-postgres-connector";
import type { DataStoreRuntime } from "../runtime";
import type { StoreVerb } from "../verbs";
import { knowledgeBaseDefinitionSchema } from "../knowledge/definition";
import { visibleSourceDocumentIds } from "../knowledge/builtin/source-visibility";
import { assetResource } from "../store-audience";
import { requireRecordsUpgrade } from "./readiness";

// "Prüfen": the fields a person decides, one row per candidate. A field is flagged where equal
// evidence disagrees, where its rule says a person confirms it, or where no candidate passed the
// evidence check; a document whose object key is unknown waits to be assigned. A person's
// decision ends the flag, unless evidence disagrees with it. The candidates of a field stand
// side by side, each with the page it cites.

type FlaggedItem = DataStoreRecordsFlaggedOutput["items"][number];

/**
 * The flagged fields as SQL over `catalyst.record_fields`: `$1` the tables with a published
 * rule, `$2` the fields each rule always has a person confirm, as `{ table: [field] }`. Each row
 * is a field with its reason; a document without a key counts each of its fields.
 */
const FLAGGED_FIELDS = `
  with fields as (
    select table_name, record_key, field_name,
      bool_or(state = 'conflict') as conflict,
      bool_or(state in ('confirmed', 'corrected')) as pinned,
      bool_or(evidence->>'status' = 'passed') as evidenced
    from catalyst.record_fields
    where record_key is not null and table_name = any($1::text[])
    group by table_name, record_key, field_name
  )
  select table_name, record_key, field_name,
    case
      when conflict then 'conflict'
      when pinned then null
      when coalesce(($2::jsonb -> table_name) ? field_name, false) then 'confirmation_required'
      when not evidenced then 'not_evidenced'
    end as reason
  from fields`;

/** The order of a page and of its cursor: by table, object, field and cited document. */
const ORDER = `table_name collate "C", coalesce(record_key::text, '') collate "C",
  field_name collate "C", knowledge_base_id collate "C", document_id collate "C"`;

const cursorSchema = z.tuple([z.string(), z.string(), z.string(), z.string(), z.string()]);

function encodeCursor(row: CandidateRow): string {
  return Buffer.from(
    JSON.stringify([
      row.table_name,
      row.record_key === null ? "" : JSON.stringify(row.record_key),
      row.field_name,
      row.knowledge_base_id,
      row.document_id
    ])
  ).toString("base64url");
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AppError("VALIDATION_FAILED", "The cursor is not one this list gave out", {
      fields: ["cursor"]
    });
  }
}

const candidateRow = z.object({
  table_name: z.string(),
  record_key: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  field_name: z.string(),
  knowledge_base_id: z.string(),
  document_id: z.string(),
  kind: z.string(),
  value: z.json(),
  page: z.number().int(),
  quote: z.string(),
  document_date: z.string().nullable(),
  extracted_at: z.string(),
  evidence: recordEvidenceResultSchema,
  state: z.enum(RECORD_FIELD_STATES),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  reason: z.enum(RECORD_FLAG_REASONS)
});
type CandidateRow = z.infer<typeof candidateRow>;

/** The parameters of the reading of flagged fields for a store's rules. */
function ruleParameters(rules: readonly DataStoreRecordsRule[], table?: string) {
  const shown = rules.filter((rule) => table === undefined || rule.table === table);
  return {
    tables: shown.map((rule) => rule.table),
    always: JSON.stringify(
      Object.fromEntries(shown.map((rule) => [rule.table, rule.review.always]))
    )
  };
}

/** How many fields wait for a person: flagged fields, and each field of an unassigned document. */
export async function countFlaggedFields(
  runtime: DataStoreRuntime,
  target: PostgresTarget,
  rules: readonly DataStoreRecordsRule[]
): Promise<number> {
  const { tables, always } = ruleParameters(rules);
  if (tables.length === 0) return 0;
  const result = await runtime.server.executor.query({
    ...target,
    sql: `select (select count(*) from (${FLAGGED_FIELDS}) f where reason is not null)
        + (select count(*) from catalyst.record_fields
           where record_key is null and table_name = any($1::text[])) as flagged`,
    parameters: [tables, always]
  });
  return Number(
    z.object({ flagged: z.union([z.number(), z.string()]) }).parse(result.rows[0]).flagged
  );
}

/**
 * The Knowledge Bases whose citations the reader may see, each with the documents still there
 * to open. A citation is shown only to a reader who may use its Knowledge Base, whatever right
 * they hold on the store, and only while its document is one search would find: the candidates
 * of any other Knowledge Base, and of a document withdrawn or outside its source, are left out.
 */
async function readCitations(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  wanted: ReadonlyMap<string, ReadonlySet<string>>,
  signal: AbortSignal | undefined
): Promise<Map<string, { knowledgeBase: string; files: Map<string, string> }>> {
  const shown = new Map<string, { knowledgeBase: string; files: Map<string, string> }>();
  for (const [knowledgeBaseId, documentIds] of wanted) {
    const record = await runtime.stores.dataStores.getDataStore({
      clientInstanceId: runtime.clientInstanceId,
      id: knowledgeBaseId
    });
    if (!record?.ownerKnowledgeBaseId) continue;
    const asset = await runtime.stores.configAssets.getConfigAsset({
      clientInstanceId: runtime.clientInstanceId,
      kind: "knowledge_base",
      name: record.ownerKnowledgeBaseId
    });
    if (
      !asset ||
      asset.id !== knowledgeBaseId ||
      asset.status !== "active" ||
      !knowledgeBaseDefinitionSchema.safeParse(asset.publishedConfig).success ||
      !access.authorize(KNOWLEDGE_BASE_ACTIONS.use, assetResource(asset)).allowed
    )
      continue;
    const files = new Map<string, string>();
    if (record.status === "ready") {
      const ids = [...documentIds];
      const target = {
        ...runtime.server.asPlatform(record.location.database),
        ...(signal ? { signal } : {})
      };
      const visible = await visibleSourceDocumentIds(runtime, asset.id, asset.name, ids, (work) =>
        runtime.server.executor.change({ ...target, timeoutMs: 15_000 }, work)
      );
      const named = await runtime.server.executor.query({
        ...target,
        sql: "select id, coalesce(nullif(file_name, ''), nullif(title, ''), id) as file_name from catalyst_kb.documents where id = any($1::text[])",
        parameters: [ids.filter((id) => visible.has(id))]
      });
      for (const row of z
        .array(z.object({ id: z.string(), file_name: z.string() }))
        .parse(named.rows))
        files.set(row.id, row.file_name);
    }
    shown.set(knowledgeBaseId, { knowledgeBase: asset.name, files });
  }
  return shown;
}

export const recordsFlagged: StoreVerb = {
  verb: "records.flagged",
  effect: "reading",
  inputSchema: DATA_STORE_RECORD_OPERATIONS.flagged.inputSchema,
  outputSchema: DATA_STORE_RECORD_OPERATIONS.flagged.outputSchema,
  async run({ runtime, store, target, context }, call) {
    const input = dataStoreRecordsFlaggedInputSchema.parse(call);
    const rules = store.definition.records ?? [];
    if (input.table !== undefined && !rules.some((rule) => rule.table === input.table))
      throw new AppError("VALIDATION_FAILED", "The table has no published records rule", {
        reason: "record_table_unknown"
      });
    const { tables, always } = ruleParameters(rules, input.table);
    // A store without records rules has nothing to review, upgraded or not.
    if (tables.length === 0) return { items: [] } satisfies DataStoreRecordsFlaggedOutput;
    const locale = context?.runtime.locale ?? runtime.defaultLocale;
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
    const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const result = await runtime.server.executor.query({
      ...target,
      limits: { ...target.limits, maxRows: input.limit + 1 },
      sql: `with flagged as (${FLAGGED_FIELDS}),
        candidates as (
          select r.*, f.reason from catalyst.record_fields r
            join flagged f on f.table_name = r.table_name and f.record_key = r.record_key
              and f.field_name = r.field_name
            where f.reason is not null
          union all
          select r.*, 'key_unresolved' as reason from catalyst.record_fields r
            where r.record_key is null and r.table_name = any($1::text[])
        )
        select table_name, record_key, field_name, knowledge_base_id, document_id, kind, value,
          page, quote, document_date::text as document_date,
          to_json(extracted_at) #>> '{}' as extracted_at, evidence, state, decided_by,
          to_json(decided_at) #>> '{}' as decided_at, reason
        from candidates
        where $3::text is null or (${ORDER}) > ($3::text, $4::text, $5::text, $6::text, $7::text)
        order by ${ORDER}
        limit $8::int`,
      parameters: [
        tables,
        always,
        after?.[0] ?? null,
        after?.[1] ?? null,
        after?.[2] ?? null,
        after?.[3] ?? null,
        after?.[4] ?? null,
        input.limit + 1
      ]
    });
    const rows = z.array(candidateRow).parse(result.rows);
    // A page cut short by the reading's byte cap goes on after its last row, as a full one does.
    const more = rows.length > input.limit || result.truncated;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    const wanted = new Map<string, Set<string>>();
    for (const row of page) {
      const documents = wanted.get(row.knowledge_base_id) ?? new Set<string>();
      documents.add(row.document_id);
      wanted.set(row.knowledge_base_id, documents);
    }
    const citations = context
      ? await readCitations(runtime, context.access, wanted, target.signal)
      : new Map<string, { knowledgeBase: string; files: Map<string, string> }>();
    const items = page.flatMap((row): FlaggedItem[] => {
      const citation = citations.get(row.knowledge_base_id);
      // A quote is the document's text: none of a document the reader could not open.
      const fileName = citation?.files.get(row.document_id);
      if (!citation || fileName === undefined) return [];
      return [
        {
          table: row.table_name,
          key: row.record_key,
          name: row.field_name,
          value: row.value,
          page: row.page,
          quote: row.quote,
          knowledgeBaseId: row.knowledge_base_id,
          documentId: row.document_id,
          kind: row.kind,
          documentDate: row.document_date,
          extractedAt: row.extracted_at,
          evidence: row.evidence,
          state: row.state,
          decidedBy: row.decided_by,
          decidedAt: row.decided_at,
          reason: row.reason,
          document: { knowledgeBase: citation.knowledgeBase, fileName }
        }
      ];
    });
    return {
      items,
      ...(more && last ? { nextCursor: encodeCursor(last) } : {})
    } satisfies DataStoreRecordsFlaggedOutput;
  }
};
