import type { ClientInstanceId } from "@work-shape/catalyst-core";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { PostgresConnection } from "./postgres-database";
import { agentRuns, conversations } from "./schema";

/**
 * Every transaction that touches both rows locks conversation -> agent run -> operation run.
 * Observation foreign keys also lock the conversation, even without an explicit update.
 * Lock only conversations here, in ID order for batches; callers recheck the run after waiting.
 * Inactive conversations still admit terminal observations so deletion can end a run.
 */
export async function lockAgentRunConversations(
  tx: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  runIds: readonly string[]
): Promise<void> {
  if (!runIds.length) return;
  await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        inArray(
          conversations.id,
          tx
            .select({ id: agentRuns.conversationId })
            .from(agentRuns)
            .where(
              and(eq(agentRuns.clientInstanceId, clientInstanceId), inArray(agentRuns.id, runIds))
            )
        )
      )
    )
    .orderBy(asc(conversations.id))
    .for("update");
}
