import { z } from "zod";
import {
  AppError,
  DATA_STORE_RECORD_OPERATIONS,
  KNOWLEDGE_BASE_ACTIONS,
  RECORD_FIELD_STATES,
  RECORD_FLAG_REASONS,
  asUserId,
  dataStoreRecordsFlaggedInputSchema,
  recordEvidenceResultSchema,
  type ActorAccess,
  type ConfigAssetRecord,
  type DataStoreRecord,
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

/**
 * Every candidate a person decides, as the CTEs `flagged` and `candidates` over the same
 * parameters: each candidate of a flagged field with its reason, and each field of a document
 * whose object is not known.
 */
const CANDIDATES = `flagged as (${FLAGGED_FIELDS}),
  candidates as (
    select r.*, f.reason from catalyst.record_fields r
      join flagged f on f.table_name = r.table_name and f.record_key = r.record_key
        and f.field_name = r.field_name
      where f.reason is not null
    union all
    select r.*, 'key_unresolved' as reason from catalyst.record_fields r
      where r.record_key is null and r.table_name = any($1::text[])
  )`;

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
  corrected_value: z.json(),
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

/**
 * How many fields wait for a person across the store, whoever reads them: flagged fields, and
 * each field of an unassigned document. Only to tell whether a notice is filed; a reader is
 * shown `countReadableFlaggedFields`.
 */
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
  return countOf(result.rows[0]);
}

function countOf(row: unknown): number {
  return Number(z.object({ flagged: z.union([z.number(), z.string()]) }).parse(row).flagged);
}

/** A Knowledge Base whose citations a reader may see, with the store that holds its documents. */
interface CitableKnowledgeBase {
  asset: ConfigAssetRecord;
  record: DataStoreRecord;
}

/**
 * The Knowledge Base of a candidate as the reader may cite it: published, active and one they
 * may use, whatever right they hold on the store. Nothing for any other.
 */
async function citableKnowledgeBase(
  runtime: DataStoreRuntime,
  access: ActorAccess,
  knowledgeBaseId: string
): Promise<CitableKnowledgeBase | undefined> {
  const record = await runtime.stores.dataStores.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: knowledgeBaseId
  });
  if (!record?.ownerKnowledgeBaseId) return undefined;
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
    return undefined;
  return { asset, record };
}

function knowledgeTarget(
  runtime: DataStoreRuntime,
  { record }: CitableKnowledgeBase,
  signal: AbortSignal | undefined
): PostgresTarget {
  return { ...runtime.server.asPlatform(record.location.database), ...(signal ? { signal } : {}) };
}

/** Of the documents, those still there to open: not withdrawn, inside their source, indexed. */
async function openableDocuments(
  runtime: DataStoreRuntime,
  knowledgeBase: CitableKnowledgeBase,
  documentIds: readonly string[],
  signal: AbortSignal | undefined
): Promise<Set<string>> {
  if (knowledgeBase.record.status !== "ready") return new Set();
  const target = knowledgeTarget(runtime, knowledgeBase, signal);
  return visibleSourceDocumentIds(
    runtime,
    knowledgeBase.asset.id,
    knowledgeBase.asset.name,
    documentIds,
    (work) => runtime.server.executor.change({ ...target, timeoutMs: 15_000 }, work)
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
    const knowledgeBase = await citableKnowledgeBase(runtime, access, knowledgeBaseId);
    if (!knowledgeBase) continue;
    const files = new Map<string, string>();
    const ids = [...documentIds];
    const visible = await openableDocuments(runtime, knowledgeBase, ids, signal);
    if (visible.size > 0) {
      const named = await runtime.server.executor.query({
        ...knowledgeTarget(runtime, knowledgeBase, signal),
        sql: "select id, coalesce(nullif(file_name, ''), nullif(title, ''), id) as file_name from catalyst_kb.documents where id = any($1::text[])",
        parameters: [ids.filter((id) => visible.has(id))]
      });
      for (const row of z
        .array(z.object({ id: z.string(), file_name: z.string() }))
        .parse(named.rows))
        files.set(row.id, row.file_name);
    }
    shown.set(knowledgeBaseId, { knowledgeBase: knowledgeBase.asset.name, files });
  }
  return shown;
}

/**
 * The names of the people who decided, by account id, as the instance shows them now: none for
 * an account that is gone or whose deletion was requested.
 */
async function deciderNames(
  runtime: DataStoreRuntime,
  ids: ReadonlySet<string>
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of ids) {
    const user = await runtime.stores.users.getUser({
      clientInstanceId: runtime.clientInstanceId,
      userId: asUserId(id)
    });
    if (user && user.status !== "deleting" && user.displayLabel) names.set(id, user.displayLabel);
  }
  return names;
}

/** How many cited documents one reading of a Knowledge Base's candidates takes at most. */
const COUNT_DOCUMENT_PAGE = 500;

/**
 * How many fields wait for this reader: the fields "Prüfen" lists to them, by the rule the list
 * reads (`readCitations`). A flagged field counts where one of its candidates comes from a
 * Knowledge Base the reader may use and from a document still there to open; a document whose
 * object is not known counts each of its fields by the same rule. The candidates of any other
 * Knowledge Base are not counted, so the count says nothing of what the reader cannot open.
 */
export async function countReadableFlaggedFields(
  runtime: DataStoreRuntime,
  target: PostgresTarget,
  rules: readonly DataStoreRecordsRule[],
  access: ActorAccess
): Promise<number> {
  const { tables, always } = ruleParameters(rules);
  if (tables.length === 0) return 0;
  const cited = z.array(z.object({ knowledge_base_id: z.string() })).parse(
    (
      await runtime.server.executor.query({
        ...target,
        sql: `with ${CANDIDATES} select distinct knowledge_base_id from candidates`,
        parameters: [tables, always]
      })
    ).rows
  );
  const usable: string[] = [];
  const hidden: { knowledgeBaseId: string; documentId: string }[] = [];
  for (const { knowledge_base_id: knowledgeBaseId } of cited) {
    const knowledgeBase = await citableKnowledgeBase(runtime, access, knowledgeBaseId);
    // One not ready opens no document: none of its candidates counts.
    if (!knowledgeBase || knowledgeBase.record.status !== "ready") continue;
    usable.push(knowledgeBaseId);
    // The documents the reader cannot open, page by page: few, beside the many still there.
    let after: string | null = null;
    for (;;) {
      const page = await runtime.server.executor.query({
        ...target,
        limits: { ...target.limits, maxRows: COUNT_DOCUMENT_PAGE },
        sql: `with ${CANDIDATES}
          select distinct document_id collate "C" as document_id from candidates
          where knowledge_base_id = $3::text
            and ($4::text is null or document_id collate "C" > $4::text collate "C")
          order by 1 limit $5::int`,
        parameters: [tables, always, knowledgeBaseId, after, COUNT_DOCUMENT_PAGE]
      });
      const ids = z
        .array(z.object({ document_id: z.string() }))
        .parse(page.rows)
        .map((row) => row.document_id);
      const open = await openableDocuments(runtime, knowledgeBase, ids, undefined);
      for (const documentId of ids)
        if (!open.has(documentId)) hidden.push({ knowledgeBaseId, documentId });
      const last = ids.at(-1);
      if (last === undefined || (ids.length < COUNT_DOCUMENT_PAGE && !page.truncated)) break;
      after = last;
    }
  }
  if (usable.length === 0) return 0;
  const result = await runtime.server.executor.query({
    ...target,
    sql: `with ${CANDIDATES},
      readable as (
        select * from candidates c
        where c.knowledge_base_id = any($3::text[])
          and not exists (select 1 from unnest($4::text[], $5::text[]) h(kb, doc)
            where h.kb = c.knowledge_base_id and h.doc = c.document_id)
      )
      select (select count(*) from (select distinct table_name, record_key, field_name
                from readable where record_key is not null) f)
        + (select count(*) from readable where record_key is null) as flagged`,
    parameters: [
      tables,
      always,
      usable,
      hidden.map((row) => row.knowledgeBaseId),
      hidden.map((row) => row.documentId)
    ]
  });
  return countOf(result.rows[0]);
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
      sql: `with ${CANDIDATES}
        select table_name, record_key, field_name, knowledge_base_id, document_id, kind, value,
          corrected_value, page, quote, document_date::text as document_date,
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
    const names = await deciderNames(
      runtime,
      new Set(page.flatMap((row) => (row.decided_by === null ? [] : [row.decided_by])))
    );
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
          correctedValue: row.corrected_value,
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
          document: { knowledgeBase: citation.knowledgeBase, fileName },
          ...(row.decided_by !== null && names.has(row.decided_by)
            ? { decidedByName: names.get(row.decided_by) }
            : {})
        }
      ];
    });
    return {
      items,
      ...(more && last ? { nextCursor: encodeCursor(last) } : {})
    } satisfies DataStoreRecordsFlaggedOutput;
  }
};
