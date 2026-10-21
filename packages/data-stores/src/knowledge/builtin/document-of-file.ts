import { z } from "zod";
import { KNOWLEDGE_DOCUMENT_FORMATS, type KnowledgeFileDocument } from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

const documentRow = z.object({
  documentId: z.string(),
  contentSha256: z.string(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  fileName: z.string(),
  pageCount: z.number().int().nullable(),
  synced: z.boolean()
});

/** The document not withdrawn that names the file, where its content was indexed (KB-7c). */
export async function documentOfFile(
  sql: PostgresChangeStatements,
  fileId: string
): Promise<KnowledgeFileDocument | undefined> {
  const [row] = z.array(documentRow).parse(
    await sql.run(
      `select d.id as "documentId", d.content_sha256 as "contentSha256", c.format,
         d.file_name as "fileName", c.page_count as "pageCount",
         d.source_item_id is not null as synced
       from catalyst_kb.documents d join catalyst_kb.contents c on c.sha256 = d.content_sha256
       where d.managed_file_id = $1::pg_catalog.text and d.withdrawn_at is null
         and c.state = 'extracted'
       order by d.added_at, d.id limit 1`,
      [fileId]
    )
  );
  if (!row) return undefined;
  const { pageCount, ...document } = row;
  return pageCount === null ? document : { ...document, pageCount };
}
