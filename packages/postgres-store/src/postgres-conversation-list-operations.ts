import { and, desc, eq, exists, ilike, inArray, notExists, or } from "drizzle-orm";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  asAgentRunId,
  type ClientInstanceId,
  type Conversation,
  type ConversationListItem,
  type ConversationListScope,
  type StorePage
} from "@work-shape/catalyst-core";
import { containsPattern } from "./like-pattern";
import { keysetFilter } from "./paging";
import {
  conversationDraftAttachments,
  conversationMessages
} from "./postgres-conversation-operations";
import type { PostgresConnection } from "./postgres-database";
import { mapConversation } from "./rows";
import { agentRuns, agentTryConversations, conversations } from "./schema";

export type ListConversationsInput = {
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId: Conversation["collaborationWorkspaceId"];
  scope: ConversationListScope;
  titleQuery?: string;
  page?: StorePage;
};

export async function listConversationsForWorkspace(
  db: PostgresConnection,
  input: ListConversationsInput
): Promise<Conversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(listedConversations(db, input))
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(input.page?.limit ?? 2147483647);
  return rows.map(mapConversation);
}

/** What a list of a workspace holds for its reader, as one condition. */
export function listedConversations(db: PostgresConnection, input: ListConversationsInput) {
  const { scope } = input;
  return and(
    eq(conversations.clientInstanceId, input.clientInstanceId),
    eq(conversations.collaborationWorkspaceId, input.collaborationWorkspaceId),
    eq(conversations.status, "active"),
    // A subagent's run thread is read through its root, never listed (CR-1).
    eq(conversations.kind, "chat"),
    input.titleQuery === undefined
      ? undefined
      : ilike(conversations.title, containsPattern(input.titleQuery)),
    keysetFilter(input.page, [conversations.updatedAt, conversations.id], true),
    ...(scope.kind === "lifecycle"
      ? []
      : [
          scope.kind === "author"
            ? and(
                eq(conversations.visibility, "private"),
                eq(conversations.createdByUserId, scope.userId)
              )
            : or(
                eq(conversations.visibility, "workspace"),
                eq(conversations.createdByUserId, scope.userId)
              ),
          // A Conversation without messages is an unsent draft: only its creator sees it,
          // and only while it still holds draft attachments.
          or(
            exists(conversationMessages(db)),
            and(
              eq(conversations.createdByUserId, scope.userId),
              exists(conversationDraftAttachments(db))
            )
          ),
          // A Try conversation is shown on its agent's page only, never in a list.
          notExists(tryConversationLink(db))
        ])
  );
}

function tryConversationLink(db: PostgresConnection) {
  return db
    .select({ id: agentTryConversations.conversationId })
    .from(agentTryConversations)
    .where(eq(agentTryConversations.conversationId, conversations.id));
}

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
        inArray(agentRuns.status, ACTIVE_AGENT_RUN_STATUSES)
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
