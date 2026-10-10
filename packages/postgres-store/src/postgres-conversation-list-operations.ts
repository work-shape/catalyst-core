import { and, desc, eq, sql as drizzleSql } from "drizzle-orm";
import { asAgentRunId, type ConversationListItem } from "@vivd-catalyst/core";
import {
  listedConversations,
  type ListConversationsInput
} from "./postgres-conversation-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapConversation } from "./rows";
import { agentRuns, conversations } from "./schema";

/**
 * The same page with the active run of each Conversation, in one statement. A Conversation
 * holds one active run at most (`agent_runs_active_conversation_idx`), so the join adds no row.
 */
export async function listConversationsWithActiveRun(
  db: PostgresConnection,
  input: ListConversationsInput
): Promise<ConversationListItem[]> {
  const rows = await db
    .select({
      conversation: conversations,
      activeRun: {
        id: agentRuns.id,
        agentName: agentRuns.agentName,
        status: agentRuns.status,
        startedAt: agentRuns.startedAt,
        updatedAt: agentRuns.updatedAt,
        lastSequence: agentRuns.lastSequence
      }
    })
    .from(conversations)
    .leftJoin(
      agentRuns,
      and(
        eq(agentRuns.clientInstanceId, conversations.clientInstanceId),
        eq(agentRuns.conversationId, conversations.id),
        drizzleSql`${agentRuns.status} in ('queued', 'running', 'waiting_for_permission', 'cancelling')`
      )
    )
    .where(listedConversations(db, input))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map(({ conversation: row, activeRun }): ConversationListItem => {
    const conversation = mapConversation(row);
    return activeRun
      ? {
          ...conversation,
          activeRun: {
            id: asAgentRunId(activeRun.id),
            conversationId: conversation.id,
            agentName: activeRun.agentName,
            status: activeRun.status,
            startedAt: activeRun.startedAt.toISOString(),
            updatedAt: activeRun.updatedAt.toISOString(),
            lastSequence: activeRun.lastSequence
          }
        }
      : conversation;
  });
}
