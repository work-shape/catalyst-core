import type { PostgresChangeStatements } from "@work-shape/catalyst-postgres-connector";
import { z } from "zod";
import {
  AppError,
  KNOWLEDGE_BASE_ACTIONS,
  type DataStoreRecordProposalItem,
  type OperationExecutionContext
} from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../runtime";
import { knowledgeBaseDefinitionSchema } from "../knowledge/definition";
import { assetResource } from "../store-audience";

const sourceRow = z.object({
  content_sha256: z.string(),
  pages: z.array(z.object({ page: z.number(), text: z.string() }))
});

/** Only active, readable documents can contribute. Hash and text come from storage, never the caller. */
export async function proposalSource(
  runtime: DataStoreRuntime,
  item: DataStoreRecordProposalItem,
  context: OperationExecutionContext,
  transaction?: { database: string; sql: PostgresChangeStatements }
) {
  const record = await runtime.stores.dataStores.getDataStore({
    clientInstanceId: runtime.clientInstanceId,
    id: item.knowledgeBaseId
  });
  if (!record?.ownerKnowledgeBaseId || record.status !== "ready") return undefined;
  const asset = await runtime.stores.configAssets.getConfigAsset({
    clientInstanceId: runtime.clientInstanceId,
    kind: "knowledge_base",
    name: record.ownerKnowledgeBaseId
  });
  if (
    !asset ||
    asset.id !== item.knowledgeBaseId ||
    asset.status !== "active" ||
    !knowledgeBaseDefinitionSchema.safeParse(asset.publishedConfig).success
  )
    return undefined;
  context.access.require(KNOWLEDGE_BASE_ACTIONS.use, assetResource(asset));
  const query = {
    ...runtime.server.asPlatform(record.location.database),
    ...(context.runtime.signal ? { signal: context.runtime.signal } : {}),
    sql: `select d.content_sha256, coalesce((select jsonb_agg(p order by p.page) from (
      select coalesce(page,1) as page, string_agg(text, E'\\n' order by position) as text from catalyst_kb.chunks
      where content_sha256=d.content_sha256 group by coalesce(page,1)
    ) p),'[]'::jsonb) as pages from catalyst_kb.documents d
    where d.id=$1::text and d.withdrawn_at is null`,
    parameters: [item.documentId]
  };
  // Source and target can be one owned store. Reuse the held transaction rather than
  // waiting for a second connection from the same bounded pool.
  const result =
    transaction?.database === record.location.database
      ? { rows: await transaction.sql.run(query.sql, query.parameters), truncated: false }
      : await runtime.server.executor.query(query);
  if (result.truncated)
    throw new AppError("VALIDATION_FAILED", "The document evidence could not be read completely", {
      reason: "record_evidence_incomplete"
    });
  return result.rows[0] ? sourceRow.parse(result.rows[0]) : undefined;
}
