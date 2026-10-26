import { lt } from "drizzle-orm";
import type { AppendAssistantMessageInput } from "@work-shape/catalyst-core";
import type { PostgresTransaction } from "./postgres-database";
import { modelProviderContinuations, modelProviderTurnContinuations } from "./schema";

/**
 * Stores the continuations an assistant message is written with, in its transaction: the
 * checkpoint where the conversation's history starts and the continuation its run ended with.
 * Each is replaced only by one of a later message.
 */
export async function writeAssistantMessageContinuations(
  tx: PostgresTransaction,
  input: Pick<AppendAssistantMessageInput, "providerContinuation" | "turnContinuation">,
  row: {
    id: string;
    clientInstanceId: string;
    conversationId: string;
    storageOrdinal: number;
    createdAt: Date;
  }
): Promise<void> {
  const source = {
    sourceMessageId: row.id,
    sourceStorageOrdinal: row.storageOrdinal,
    updatedAt: row.createdAt
  };
  if (input.providerContinuation) {
    const { providerId, state } = input.providerContinuation;
    await tx
      .insert(modelProviderContinuations)
      .values({
        clientInstanceId: row.clientInstanceId,
        conversationId: row.conversationId,
        providerId,
        state,
        ...source
      })
      .onConflictDoUpdate({
        target: [
          modelProviderContinuations.clientInstanceId,
          modelProviderContinuations.conversationId,
          modelProviderContinuations.providerId
        ],
        set: { state, ...source },
        setWhere: lt(modelProviderContinuations.sourceStorageOrdinal, row.storageOrdinal)
      });
  }
  if (input.turnContinuation) {
    const { providerId, model, state } = input.turnContinuation;
    await tx
      .insert(modelProviderTurnContinuations)
      .values({
        clientInstanceId: row.clientInstanceId,
        conversationId: row.conversationId,
        providerId,
        model,
        state,
        ...source
      })
      .onConflictDoUpdate({
        target: [
          modelProviderTurnContinuations.clientInstanceId,
          modelProviderTurnContinuations.conversationId,
          modelProviderTurnContinuations.providerId
        ],
        set: { model, state, ...source },
        setWhere: lt(modelProviderTurnContinuations.sourceStorageOrdinal, row.storageOrdinal)
      });
  }
}
