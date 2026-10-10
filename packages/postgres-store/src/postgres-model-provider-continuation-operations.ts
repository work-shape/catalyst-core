import { and, eq } from "drizzle-orm";
import {
  asConversationId,
  asMessageId,
  type ModelProviderContinuationCheckpoint,
  type ModelProviderContinuationStore
} from "@vivd-catalyst/core";
import { requireClaimedAgentRun } from "./postgres-agent-run-worker-operations";
import type { PostgresConnection } from "./postgres-database";
import { modelProviderContinuations } from "./schema";

export async function getModelProviderContinuation(
  db: PostgresConnection,
  input: Parameters<ModelProviderContinuationStore["getModelProviderContinuation"]>[0]
): Promise<ModelProviderContinuationCheckpoint | undefined> {
  const [row] = await db
    .select()
    .from(modelProviderContinuations)
    .where(
      and(
        eq(modelProviderContinuations.clientInstanceId, input.clientInstanceId),
        eq(modelProviderContinuations.conversationId, input.conversationId),
        eq(modelProviderContinuations.providerId, input.providerId)
      )
    )
    .limit(1);
  return row ? mapModelProviderContinuation(row) : undefined;
}

export async function deleteModelProviderContinuation(
  db: PostgresConnection,
  input: Parameters<ModelProviderContinuationStore["deleteModelProviderContinuation"]>[0]
): Promise<void> {
  const remove = (tx: PostgresConnection) =>
    tx
      .delete(modelProviderContinuations)
      .where(
        and(
          eq(modelProviderContinuations.clientInstanceId, input.clientInstanceId),
          eq(modelProviderContinuations.conversationId, input.conversationId),
          eq(modelProviderContinuations.providerId, input.providerId)
        )
      );
  const { runFence } = input;
  if (!runFence) {
    await remove(db);
    return;
  }
  await db.transaction(async (tx) => {
    await requireClaimedAgentRun(tx, input.clientInstanceId, runFence);
    await remove(tx);
  });
}

function mapModelProviderContinuation(
  row: typeof modelProviderContinuations.$inferSelect
): ModelProviderContinuationCheckpoint {
  return {
    clientInstanceId:
      row.clientInstanceId as ModelProviderContinuationCheckpoint["clientInstanceId"],
    conversationId: asConversationId(row.conversationId),
    providerId: row.providerId,
    state: row.state,
    sourceMessageId: asMessageId(row.sourceMessageId),
    updatedAt: row.updatedAt.toISOString()
  };
}
