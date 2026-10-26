import { and, eq } from "drizzle-orm";
import {
  asConversationId,
  asMessageId,
  type ModelProviderContinuationCheckpoint,
  type ModelProviderContinuationStore,
  type ModelProviderTurnContinuation
} from "@work-shape/catalyst-core";
import { requireClaimedAgentRun } from "./postgres-agent-run-worker-operations";
import type { PostgresConnection } from "./postgres-database";
import { modelProviderContinuations, modelProviderTurnContinuations } from "./schema";

type ContinuationKey = Parameters<
  ModelProviderContinuationStore["getModelProviderContinuation"]
>[0];

export async function getModelProviderContinuation(
  db: PostgresConnection,
  input: ContinuationKey
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

export async function getModelProviderTurnContinuation(
  db: PostgresConnection,
  input: ContinuationKey
): Promise<ModelProviderTurnContinuation | undefined> {
  const [row] = await db
    .select()
    .from(modelProviderTurnContinuations)
    .where(
      and(
        eq(modelProviderTurnContinuations.clientInstanceId, input.clientInstanceId),
        eq(modelProviderTurnContinuations.conversationId, input.conversationId),
        eq(modelProviderTurnContinuations.providerId, input.providerId)
      )
    )
    .limit(1);
  return row ? { ...mapModelProviderContinuation(row), model: row.model } : undefined;
}

export async function deleteModelProviderContinuation(
  db: PostgresConnection,
  input: Parameters<ModelProviderContinuationStore["deleteModelProviderContinuation"]>[0]
): Promise<void> {
  const remove = async (tx: PostgresConnection) => {
    await tx
      .delete(modelProviderContinuations)
      .where(
        and(
          eq(modelProviderContinuations.clientInstanceId, input.clientInstanceId),
          eq(modelProviderContinuations.conversationId, input.conversationId),
          eq(modelProviderContinuations.providerId, input.providerId)
        )
      );
    await tx
      .delete(modelProviderTurnContinuations)
      .where(
        and(
          eq(modelProviderTurnContinuations.clientInstanceId, input.clientInstanceId),
          eq(modelProviderTurnContinuations.conversationId, input.conversationId),
          eq(modelProviderTurnContinuations.providerId, input.providerId)
        )
      );
  };
  const { runFence } = input;
  await db.transaction(async (tx) => {
    if (runFence) await requireClaimedAgentRun(tx, input.clientInstanceId, runFence);
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
