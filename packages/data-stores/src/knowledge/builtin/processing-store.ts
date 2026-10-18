import { z } from "zod";
import {
  KNOWLEDGE_DOCUMENT_FORMATS,
  type KnowledgeProcessingContent
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
const row = z.object({
  sha256: z.string(),
  processing_key: z.string().nullable(),
  processor_revision: z.string().nullable(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  document_id: z.string(),
  managed_file_id: z.string(),
  name: z.string(),
  path: z.string(),
  mime: z.string(),
  source_id: z.string().nullable(),
  tokens: z.number()
});
/** One canonical active document per shared content, the same order as readContent. */
export async function processingContents(
  sql: PostgresChangeStatements,
  input: { after: string; limit: number }
): Promise<KnowledgeProcessingContent[]> {
  const rows = z.array(row).parse(
    await sql.run(
      `select c.sha256,c.format,c.processing_key,c.processor_revision,d.id as document_id,d.managed_file_id,d.file_name as name,
    coalesce(i.path,d.file_name) as path,coalesce(i.mime,case c.format when 'pdf' then 'application/pdf' when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' when 'markdown' then 'text/markdown' else 'text/plain' end) as mime,i.source_id,
    coalesce((select sum(token_count) from catalyst_kb.chunks where content_sha256=c.sha256),0)::float8 as tokens
    from catalyst_kb.contents c join lateral (select id,managed_file_id,file_name,source_item_id from catalyst_kb.documents where content_sha256=c.sha256 and withdrawn_at is null order by added_at,id limit 1) d on true
    left join catalyst_kb.source_items i on i.id=d.source_item_id
    where c.sha256>$1::text order by c.sha256 limit $2::int`,
      [input.after, input.limit]
    )
  );
  return rows.map((row) => ({
    contentSha256: row.sha256,
    format: row.format,
    documentId: row.document_id,
    fileId: row.managed_file_id,
    name: row.name,
    path: row.path,
    mime: row.mime,
    tokens: row.tokens,
    ...(row.source_id ? { sourceId: row.source_id } : {}),
    ...(row.processing_key ? { processingKey: row.processing_key } : {}),
    ...(row.processor_revision ? { processorRevision: row.processor_revision } : {})
  }));
}
