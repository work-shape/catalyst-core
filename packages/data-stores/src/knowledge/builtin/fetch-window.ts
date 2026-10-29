import { z } from "zod";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

const heldRow = z.object({ items: z.number().int(), bytes: z.coerce.number() });

/**
 * What the fetch window of the Knowledge Base holds (KB-ISO-3b): its fetched items whose
 * content has not yet left `pending`, and their listed bytes. Read from the few contents still
 * `pending`, by their partial index.
 */
export async function heldInFetchWindow(
  sql: PostgresChangeStatements
): Promise<{ items: number; bytes: number }> {
  const [row] = z.array(heldRow).parse(
    await sql.run(
      `select count(*)::int4 as items, coalesce(sum(si.size), 0)::int8::text as bytes
       from catalyst_kb.contents c
       join catalyst_kb.documents d on d.content_sha256 = c.sha256 and d.withdrawn_at is null
       join catalyst_kb.source_items si on si.id = d.source_item_id
       where c.state = 'pending'`
    )
  );
  return { items: row?.items ?? 0, bytes: row?.bytes ?? 0 };
}
