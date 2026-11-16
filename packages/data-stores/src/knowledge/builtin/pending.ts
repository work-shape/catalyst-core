import { z } from "zod";
import {
  AppError,
  KNOWLEDGE_DOCUMENT_FORMATS,
  knowledgePendingPageRowSchema,
  knowledgePendingRowSchema,
  type JsonObject,
  type KnowledgePendingRow
} from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../../runtime";
import type { KnowledgePendingCall, KnowledgePendingDocument } from "../source-port";
import { createSourceStore } from "./source-store";

// PROC-W, the reading half: `knowledge.<id>.pending` hands a Workflow step the indexed
// documents of a type whose pages changed after a time. Built-in processing has already run
// for each, so its pages are the stored extraction: an XLSX sheet per page with its tables as
// Markdown and hidden rows left out, a PDF page per page. No model is called.

/** The row bound of a dataset where release config names none (`workflows.datasets.rowBytes`). */
const DEFAULT_ROW_BYTES = 256 * 1024;

const documentRow = z.object({
  id: z.string(),
  content_sha256: z.string(),
  managed_file_id: z.string(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  type: z.string(),
  source_id: z.string().nullable(),
  path: z.string(),
  name: z.string(),
  changed_at: z.coerce.date()
});

/**
 * When a document's pages last changed: its current version fetched or added, or its content
 * extracted and indexed again, to the millisecond its ISO form carries, so a `since` taken from
 * one row compares exactly.
 */
const CHANGED_AT = `date_trunc('milliseconds', greatest(coalesce(i.fetched_at, d.added_at), c.updated_at))`;

const PENDING_QUERY = `select * from (
    select d.id, d.content_sha256, d.managed_file_id, c.format,
      coalesce(c.document_type, 'default') as type, i.source_id,
      case when left(coalesce(i.path, ''), 1) = '/' then i.path
        else '/' || coalesce(i.path, d.file_name) end as path,
      d.file_name as name, ${CHANGED_AT} as changed_at
    from catalyst_kb.documents d
    join catalyst_kb.contents c on c.sha256 = d.content_sha256
    left join catalyst_kb.source_items i on i.id = d.source_item_id
    where d.withdrawn_at is null and c.state = 'extracted'
      and ($1::text is null or coalesce(c.document_type, 'default') = $1::text)
  ) pending
  where $2::timestamptz is null or changed_at > $2::timestamptz
  order by changed_at, id
  limit $3::int`;

const rowSchema = z.record(z.string(), z.json()).parse(z.toJSONSchema(knowledgePendingRowSchema));
const pageRowSchema = z
  .record(z.string(), z.json())
  .parse(z.toJSONSchema(knowledgePendingPageRowSchema));

/**
 * The documents of one call, at most `limit`. Where more changed than fit, the documents of the
 * last row's moment go to the next call, which passes that moment as `since`: none is skipped,
 * unless more than `limit` documents changed in one millisecond.
 */
async function pendingDocuments(
  runtime: DataStoreRuntime,
  call: KnowledgePendingCall,
  signal: AbortSignal
): Promise<KnowledgePendingDocument[]> {
  const rows = await createSourceStore(runtime, call.knowledgeBaseId, signal).change(async (sql) =>
    z
      .array(documentRow)
      .parse(await sql.run(PENDING_QUERY, [call.type ?? null, call.since ?? null, call.limit + 1]))
  );
  let kept = rows.slice(0, call.limit);
  const next = rows[call.limit];
  if (next) {
    const cut = kept.filter((row) => row.changed_at.getTime() !== next.changed_at.getTime());
    if (cut.length > 0) kept = cut;
  }
  return kept.map((row) => ({
    id: row.id,
    contentSha256: row.content_sha256,
    fileId: row.managed_file_id,
    format: row.format,
    type: row.type,
    source: row.source_id,
    path: row.path,
    name: row.name,
    changedAt: row.changed_at.toISOString()
  }));
}

/**
 * The rows of a document's pages, each within a dataset row: a longer page goes on in the next
 * row of the same number, cut at a line break where one fits.
 */
export function* pageRows(
  pages: readonly { page: number; text: string }[],
  rowBytes: number
): Generator<JsonObject> {
  const fits = (page: number, text: string) =>
    Buffer.byteLength(JSON.stringify({ page, text })) + 1 <= rowBytes;
  for (const { page, text } of pages) {
    if (fits(page, text)) {
      yield { page, text };
      continue;
    }
    let row = "";
    for (const line of text.split("\n")) {
      const joined = row === "" ? line : `${row}\n${line}`;
      if (fits(page, joined)) {
        row = joined;
        continue;
      }
      if (row !== "") yield { page, text: row };
      row = "";
      // A line longer than a row is cut where it fills one.
      let rest = line;
      while (!fits(page, rest)) {
        let size = 1;
        const chars = Array.from(rest);
        let low = 1;
        let high = chars.length;
        while (low <= high) {
          const middle = Math.floor((low + high) / 2);
          if (fits(page, chars.slice(0, middle).join(""))) {
            size = middle;
            low = middle + 1;
          } else high = middle - 1;
        }
        yield { page, text: chars.slice(0, size).join("") };
        rest = chars.slice(size).join("");
      }
      row = rest;
    }
    if (row !== "") yield { page, text: row };
  }
}

/** Writes each document's pages and then the list as datasets of the calling step run. */
export async function pendingDataset(
  runtime: DataStoreRuntime,
  call: KnowledgePendingCall,
  signal: AbortSignal
) {
  const datasets = runtime.workflowDatasets;
  if (!datasets)
    throw new AppError(
      "CONFLICT",
      "Reading pending documents needs the instance's dataset storage",
      {
        reason: "dataset_storage_unavailable"
      }
    );
  const rowBytes = runtime.limits.streamRowBytes ?? DEFAULT_ROW_BYTES;
  const documents = await pendingDocuments(runtime, call, signal);
  const rows: KnowledgePendingRow[] = [];
  let unreadable = 0;
  for (const document of documents) {
    signal.throwIfAborted();
    const pages = await call.pages(document, signal);
    if (!pages?.length) {
      unreadable++;
      continue;
    }
    const reference = await datasets.write({
      workflowRunId: call.workflowRunId,
      stepRunId: call.stepRunId,
      field: `knowledge.pending.pages.${document.id}`,
      rowSchema: pageRowSchema,
      rows: (async function* () {
        yield* pageRows(pages, rowBytes);
      })(),
      signal
    });
    rows.push({
      id: document.id,
      type: document.type,
      contentHash: document.contentSha256,
      source: document.source,
      path: document.path,
      name: document.name,
      changedAt: document.changedAt,
      pages: reference
    });
  }
  const reference = await datasets.write({
    workflowRunId: call.workflowRunId,
    stepRunId: call.stepRunId,
    field: "knowledge.pending.documents",
    rowSchema,
    rows: (async function* () {
      yield* rows;
    })(),
    signal
  });
  return { documents: reference, unreadable };
}
