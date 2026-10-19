import { z } from "zod";
import {
  AppError,
  KNOWLEDGE_CONTENT_STATES,
  KNOWLEDGE_DOCUMENT_FORMATS,
  KNOWLEDGE_DOCUMENT_WAIT_CODES,
  knowledgeDocumentFailureCodeSchema,
  knowledgeDocumentStateOf,
  type KnowledgeDocumentEntry,
  type KnowledgeDocumentStore
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

const documentRow = z.object({
  fields_pending: z.boolean(),
  fields_pending_reason: z
    .discriminatedUnion("reason", [
      z.object({ reason: z.literal("monthly_budget") }),
      z.object({
        reason: z.literal("token_budget"),
        estimatedTokens: z.number(),
        reservedOutputTokens: z.number(),
        maxTokensPerDocument: z.number()
      })
    ])
    .nullable(),
  id: z.string(),
  managed_file_id: z.string(),
  file_name: z.string(),
  title: z.string(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  state: z.enum(KNOWLEDGE_CONTENT_STATES),
  failure_code: z.string().nullable(),
  page_count: z.number().int().nullable(),
  source_id: z.string().nullable(),
  added_at: z.string(),
  updated_at: z.string(),
  cursor_at: z.string()
});

const cursorSchema = z.tuple([z.string().min(1).max(64), z.string().min(1).max(200)]);

function encodeCursor(at: string, id: string): string {
  return Buffer.from(JSON.stringify([at, id])).toString("base64url");
}

function decodeCursor(cursor: string): [string, string] {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch {
    throw new AppError(
      "VALIDATION_FAILED",
      "The cursor is not one this list answered.",
      { reason: "knowledge_cursor_invalid" },
      { exposeMessage: true }
    );
  }
}

/** An ISO time in UTC, as the API answers times. */
const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const summaryRow = z.object({
  count: z.number().int(),
  pending: z.boolean(),
  failed: z.boolean(),
  last_ingested_at: z.string().nullable()
});

/** One page and, on the first page, the state of all retained documents, aggregated in SQL. */
export async function listKnowledgeDocuments(
  sql: PostgresChangeStatements,
  input: Parameters<KnowledgeDocumentStore["listDocuments"]>[0]
) {
  const after = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  const [totals] =
    input.cursor === undefined
      ? z.array(summaryRow).parse(
          await sql.run(`
    select count(*)::int as count,
      coalesce(bool_or(c.state = 'pending'), false) as pending,
      coalesce(bool_or(c.state = 'failed'), false) as failed,
      to_char(max(c.updated_at) filter (where c.state = 'extracted') at time zone 'UTC', ${ISO_UTC}) as last_ingested_at
    from catalyst_kb.documents d
    join catalyst_kb.contents c on c.sha256 = d.content_sha256
    where d.withdrawn_at is null
  `)
        )
      : [];
  const summary = totals
    ? {
        count: totals.count,
        state: totals.failed
          ? ("failed" as const)
          : totals.pending
            ? ("pending" as const)
            : ("indexed" as const),
        ...(totals.last_ingested_at ? { lastIngestedAt: totals.last_ingested_at } : {})
      }
    : undefined;
  const rows = z.array(documentRow).parse(
    await sql.run(
      `select d.id, d.managed_file_id, d.file_name, d.title, c.format, c.state,
               c.failure_code, c.page_count, s.source_id, d.fields_pending, d.fields_pending_reason,
               to_char(d.added_at at time zone 'UTC', ${ISO_UTC}) as added_at,
               to_char(c.updated_at at time zone 'UTC', ${ISO_UTC}) as updated_at,
               d.added_at::pg_catalog.text as cursor_at
             from catalyst_kb.documents d
             join catalyst_kb.contents c on c.sha256 = d.content_sha256
             left join catalyst_kb.source_items s on s.id = d.source_item_id
             where d.withdrawn_at is null
               and ($1::pg_catalog.text is null
                 or (d.added_at, d.id) < ($1::pg_catalog.timestamptz, $2::pg_catalog.text))
             order by d.added_at desc, d.id desc
             limit $3::pg_catalog.int4`,
      [after?.[0] ?? null, after?.[1] ?? null, input.limit + 1]
    )
  );
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    ...(summary ? { summary } : {}),
    documents: page.map(entryOf),
    ...(rows.length > input.limit && last
      ? { nextCursor: encodeCursor(last.cursor_at, last.id) }
      : {})
  };
}

const waitCodeSchema = z.enum(KNOWLEDGE_DOCUMENT_WAIT_CODES);

function entryOf(row: z.infer<typeof documentRow>): KnowledgeDocumentEntry {
  const code = knowledgeDocumentFailureCodeSchema.safeParse(row.failure_code);
  const waitCode = waitCodeSchema.safeParse(row.failure_code);
  return {
    id: row.id,
    fieldsPending: row.fields_pending,
    ...(row.fields_pending_reason ? { fieldsPendingReason: row.fields_pending_reason } : {}),
    fileId: row.managed_file_id,
    fileName: row.file_name,
    title: row.title,
    format: row.format,
    state: knowledgeDocumentStateOf(row.state),
    ...(row.state === "failed" && code.success ? { failureCode: code.data } : {}),
    ...(row.state === "failed" &&
    code.data === "knowledge_conversion_timeout" &&
    row.page_count !== null
      ? { failurePageCount: row.page_count }
      : {}),
    ...(row.state === "pending" && waitCode.success ? { waitCode: waitCode.data } : {}),
    ...(row.source_id === null ? {} : { sourceId: row.source_id }),
    addedAt: row.added_at,
    updatedAt: row.updated_at
  };
}
