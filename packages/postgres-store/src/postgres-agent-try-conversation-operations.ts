import { and, eq, isNull } from "drizzle-orm";
import {
  AppError,
  asCollaborationWorkspaceId,
  asConversationId,
  type AgentTryConversationStore,
  type ConversationId
} from "@work-shape/catalyst-core";
import {
  createConversation,
  requireActiveConversationLock
} from "./postgres-conversation-operations";
import { type PostgresConnection } from "./postgres-database";
import { mapConversation } from "./rows";
import { agentTryConversations, conversations } from "./schema";

type Input<Method extends keyof AgentTryConversationStore> = Parameters<
  AgentTryConversationStore[Method]
>[0];

const notAvailable = () => new AppError("NOT_FOUND", "Conversation is not available");

async function openTryConversation(
  db: PostgresConnection,
  input: Input<"open">
): ReturnType<AgentTryConversationStore["open"]> {
  const { clientInstanceId, buildConversationId, agentId } = input;
  return db.transaction(async (tx) => {
    // The lock a deletion of the Build conversation takes too: it either comes first and the
    // Build conversation is gone here, or it comes after and its cleanup finds the link.
    await requireActiveConversationLock(tx, clientInstanceId, buildConversationId);
    const [build] = await tx
      .select({
        workspaceId: conversations.collaborationWorkspaceId,
        subjectKind: conversations.subjectKind,
        subjectName: conversations.subjectName,
        tryOf: agentTryConversations.buildConversationId
      })
      .from(conversations)
      .leftJoin(agentTryConversations, eq(agentTryConversations.conversationId, conversations.id))
      .where(eq(conversations.id, buildConversationId))
      .limit(1);
    // Only a conversation about the agent is its Build conversation, and a Try conversation is
    // tried in, never built in. Any other is answered as a missing one.
    if (
      !build ||
      build.workspaceId === null ||
      build.tryOf !== null ||
      build.subjectKind !== input.agent.kind ||
      build.subjectName !== input.agent.name
    ) {
      throw notAvailable();
    }

    const current = and(
      eq(agentTryConversations.buildConversationId, buildConversationId),
      eq(agentTryConversations.agentId, agentId),
      isNull(agentTryConversations.replacedAt)
    );
    const [found] = await tx
      .select({ conversation: conversations })
      .from(agentTryConversations)
      .innerJoin(conversations, eq(conversations.id, agentTryConversations.conversationId))
      .where(current)
      .limit(1);
    if (found?.conversation.status === "active") {
      return { conversation: mapConversation(found.conversation), created: false };
    }
    // A deleted one gives way, and its row stays until its cleanup is through: the row is what
    // leads the retry to what it left, such as its Operation Runs.
    if (found)
      await tx.update(agentTryConversations).set({ replacedAt: new Date() }).where(current);

    const conversation = await createConversation(tx, {
      clientInstanceId,
      collaborationWorkspaceId: asCollaborationWorkspaceId(build.workspaceId),
      createdByUserId: input.createdByUserId,
      createdByExternalUserId: input.createdByExternalUserId,
      visibility: "private",
      title: input.title,
      retainedUntil: input.retainedUntil
    });
    await tx.insert(agentTryConversations).values({
      conversationId: conversation.id,
      clientInstanceId,
      buildConversationId,
      agentId,
      createdAt: new Date(conversation.createdAt)
    });
    return { conversation, created: true };
  });
}

async function listTryConversations(
  db: PostgresConnection,
  input: Input<"list">
): Promise<ConversationId[]> {
  const rows = await db
    .select({ id: agentTryConversations.conversationId })
    .from(agentTryConversations)
    .where(
      and(
        eq(agentTryConversations.clientInstanceId, input.clientInstanceId),
        eq(agentTryConversations.buildConversationId, input.buildConversationId),
        input.agentId === undefined ? undefined : eq(agentTryConversations.agentId, input.agentId)
      )
    );
  return rows.map((row) => asConversationId(row.id));
}

async function removeTryConversation(
  db: PostgresConnection,
  input: Input<"remove">
): Promise<void> {
  await db
    .delete(agentTryConversations)
    .where(
      and(
        eq(agentTryConversations.clientInstanceId, input.clientInstanceId),
        eq(agentTryConversations.conversationId, input.conversationId)
      )
    );
}

export function createPostgresAgentTryConversationStore(
  db: PostgresConnection
): AgentTryConversationStore {
  return {
    open: (input) => openTryConversation(db, input),
    list: (input) => listTryConversations(db, input),
    remove: (input) => removeTryConversation(db, input)
  };
}
