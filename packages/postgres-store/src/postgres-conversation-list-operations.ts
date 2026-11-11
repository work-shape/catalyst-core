import {
  and,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  notExists,
  or,
  sql,
  type SQL
} from "drizzle-orm";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  asAgentRunId,
  type ClientInstanceId,
  type Conversation,
  type ConversationListItem,
  type ConversationListScope,
  type SharedFromOutsideListItem,
  type StorePage
} from "@work-shape/catalyst-core";
import { containsPattern } from "./like-pattern";
import { keysetFilter } from "./paging";
import {
  conversationDraftAttachments,
  conversationMessages
} from "./postgres-conversation-operations";
import type { PostgresConnection } from "./postgres-database";
import { conversationFields, namesPerson, readsConversation } from "./postgres-conversation-people";
import { mapConversation } from "./rows";
import {
  agentRuns,
  agentTryConversations,
  collaborationWorkspaceMemberships,
  collaborationWorkspaces,
  conversations
} from "./schema";

export type ListConversationsInput = {
  clientInstanceId: ClientInstanceId;
  collaborationWorkspaceId: Conversation["collaborationWorkspaceId"];
  scope: ConversationListScope;
  titleQuery?: string;
  projectId?: string;
  page?: StorePage;
};

export async function listConversationsForWorkspace(
  db: PostgresConnection,
  input: ListConversationsInput
): Promise<Conversation[]> {
  const rows = await db
    .select(conversationFields)
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
    input.projectId === undefined ? undefined : eq(conversations.projectId, input.projectId),
    keysetFilter(input.page, [conversations.updatedAt, conversations.id], true),
    ...(scope.kind === "lifecycle"
      ? []
      : [
          scope.kind === "author"
            ? and(
                eq(conversations.visibility, "private"),
                eq(conversations.createdByUserId, scope.userId),
                // A project is reached through membership alone (PRJ-1).
                isNull(conversations.projectId)
              )
            : // A member reads what the workspace reads, their own, and what names them.
              readsConversation(scope.userId),
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
  return (await selectWithActiveRun(db, listedConversations(db, input), input.page)).map(
    ({ item }) => item
  );
}

/**
 * The chats that name the person from workspaces they hold no membership of (CHAT-SHARE-6b),
 * each with its workspace's name. The clause is that of `readsChatFromOutside`: named, not the
 * creator, no membership. A workspace whose deletion was requested is closed and lists nothing.
 */
export async function listConversationsSharedFromOutside(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    userId: string;
    titleQuery?: string;
    page?: StorePage;
  }
): Promise<SharedFromOutsideListItem[]> {
  const where = and(
    eq(conversations.clientInstanceId, input.clientInstanceId),
    eq(conversations.status, "active"),
    eq(conversations.kind, "chat"),
    // Only a private chat outside any project names people.
    eq(conversations.visibility, "private"),
    isNull(conversations.projectId),
    sql`"conversations"."created_by_user_id" <> ${input.userId}`,
    namesPerson(input.userId),
    notExists(
      db
        .select({ userId: collaborationWorkspaceMemberships.userId })
        .from(collaborationWorkspaceMemberships)
        .where(
          and(
            eq(collaborationWorkspaceMemberships.clientInstanceId, conversations.clientInstanceId),
            eq(
              collaborationWorkspaceMemberships.collaborationWorkspaceId,
              conversations.collaborationWorkspaceId
            ),
            eq(collaborationWorkspaceMemberships.userId, input.userId)
          )
        )
    ),
    sql`exists (select 1 from ${collaborationWorkspaces} w where w.client_instance_id = "conversations"."client_instance_id" and w.id = "conversations"."collaboration_workspace_id" and w.deletion_requested_at is null)`,
    exists(conversationMessages(db)),
    notExists(tryConversationLink(db)),
    input.titleQuery === undefined
      ? undefined
      : ilike(conversations.title, containsPattern(input.titleQuery)),
    keysetFilter(input.page, [conversations.updatedAt, conversations.id], true)
  );
  const rows = await selectWithActiveRun(db, where, input.page, true);
  // Every row has its workspace open (the clause above); the name is never missing.
  return rows.flatMap(({ item, workspaceName }) =>
    workspaceName === null ? [] : [{ ...item, workspaceName }]
  );
}

async function selectWithActiveRun(
  db: PostgresConnection,
  where: SQL | undefined,
  page: StorePage | undefined,
  withWorkspaceName = false
): Promise<{ item: ConversationListItem; workspaceName: string | null }[]> {
  const rows = await db
    .select({
      conversation: conversationFields,
      activeRun: {
        id: agentRuns.id,
        agentName: agentRuns.agentName,
        status: agentRuns.status,
        startedAt: agentRuns.startedAt,
        updatedAt: agentRuns.updatedAt,
        lastSequence: agentRuns.lastSequence
      },
      workspaceName: withWorkspaceName
        ? sql<
            string | null
          >`(select w.name from ${collaborationWorkspaces} w where w.client_instance_id = "conversations"."client_instance_id" and w.id = "conversations"."collaboration_workspace_id" and w.deletion_requested_at is null)`
        : sql<string | null>`null`
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
    .where(where)
    .orderBy(desc(conversations.updatedAt), desc(conversations.id))
    .limit(page?.limit ?? 2147483647);
  return rows.map(({ conversation: row, activeRun, workspaceName }) => {
    const conversation = mapConversation(row);
    const item: ConversationListItem = activeRun
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
    return { item, workspaceName };
  });
}
