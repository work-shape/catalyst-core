import { z } from "zod";
import {
  AppError,
  KNOWLEDGE_DOCUMENT_FORMATS,
  type KnowledgeFieldStore
} from "@work-shape/catalyst-core";
import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";

const documentRow = z.object({
  contentHash: z.string(),
  fileId: z.string(),
  format: z.enum(KNOWLEDGE_DOCUMENT_FORMATS),
  path: z.string(),
  type: z.string()
});
type Change = <T>(
  work: (sql: PostgresChangeStatements) => Promise<T>,
  signal?: AbortSignal
) => Promise<T>;

export function createKnowledgeFieldStore(change: Change): KnowledgeFieldStore {
  return {
    document(id, signal) {
      return change(async (sql) => {
        const [row] = await sql.run(
          `select d.content_sha256 as "contentHash", d.managed_file_id as "fileId", c.format,
          coalesce(i.path,d.file_name) as path,coalesce(c.document_type,'default') as type
          from catalyst_kb.documents d join catalyst_kb.contents c on c.sha256=d.content_sha256
          left join catalyst_kb.source_items i on i.id=d.source_item_id
          where d.id=$1::text and d.withdrawn_at is null and c.state='extracted'`,
          [id]
        );
        return row ? documentRow.parse(row) : undefined;
      }, signal);
    },
    pause(documentId, reason, signal) {
      return change(async (sql) => {
        await sql.run(
          "update catalyst_kb.documents set fields_pending=true, fields_pending_reason=$2::jsonb where id=$1::text and withdrawn_at is null",
          [documentId, JSON.stringify(reason)]
        );
      }, signal);
    },
    reserve(input, signal) {
      return change(async (sql) => {
        // The single monthly row serializes admission only, never model calls.
        await sql.run(
          "insert into catalyst_kb.field_budgets (month,currency) values ($1::text,$2::text) on conflict do nothing",
          [input.month, input.currency]
        );
        const rows = await sql.run(
          `update catalyst_kb.field_budgets set spent=spent+$3::numeric
          where month=$1::text and currency=$2::text and ($4::numeric is null or spent+$3::numeric <= $4::numeric) returning month`,
          [input.month, input.currency, input.cost, input.limit ?? null]
        );
        if (!rows.length) {
          const [budget] = await sql.run(
            "select currency from catalyst_kb.field_budgets where month=$1::text",
            [input.month]
          );
          if (budget?.currency !== input.currency)
            throw new AppError(
              "CONFLICT",
              "Field extraction budget currency changed during the month"
            );
        }
        await sql.run(
          `update catalyst_kb.documents set fields_pending=fields_pending or $2::boolean,
          fields_pending_reason=case when $2::boolean then '{"reason":"monthly_budget"}'::jsonb else fields_pending_reason end where id=$1::text and withdrawn_at is null`,
          [input.documentId, rows.length === 0]
        );
        return rows.length > 0;
      }, signal);
    },
    settle(input, signal) {
      return change(async (sql) => {
        await sql.run(
          "update catalyst_kb.field_budgets set spent=greatest(0,spent-$3::numeric+$4::numeric) where month=$1::text and currency=$2::text",
          [input.month, input.currency, input.reserved, input.cost]
        );
        const active = await sql.run(
          "update catalyst_kb.documents set fields_pending=false, fields_pending_reason=null where id=$1::text and content_sha256=$2::text and withdrawn_at is null returning id",
          [input.documentId, input.contentHash]
        );
        return active.length > 0;
      }, signal);
    }
  };
}
