import { and, eq, isNull, sql } from "drizzle-orm";
import {
  AppError,
  asConversationId,
  type AgentTryConversationStore,
  type ConversationId
} from "@work-shape/catalyst-core";
import { createConversation } from "./postgres-conversation-operations";
import { type PostgresConnection } from "./postgres-database";
import { mapConversation } from "./rows";
import { agentTryConversations, conversations, configAssets } from "./schema";

type Input<Method extends keyof AgentTryConversationStore> = Parameters<
  AgentTryConversationStore[Method]
>[0];

const notAvailable = () => new AppError("NOT_FOUND", "Conversation is not available");

async function openTryConversation(
  db: PostgresConnection,
  input: Input<"open">
): ReturnType<AgentTryConversationStore["open"]> {
  const { clientInstanceId, createdByUserId, agentId } = input;
  return db.transaction(async (tx) => {
    // Keep an asset deletion from passing an open that has already read the agent.
    const [agent] = await tx
      .select({ id: configAssets.id })
      .from(configAssets)
      .where(
        and(
          eq(configAssets.clientInstanceId, clientInstanceId),
          eq(configAssets.id, agentId),
          eq(configAssets.kind, "agent"),
          eq(configAssets.status, "active")
        )
      )
      .for("share")
      .limit(1);
    if (!agent) throw notAvailable();
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["agent-try", clientInstanceId, agentId, createdByUserId])}, 0))`
    );
    const current = and(
      eq(agentTryConversations.clientInstanceId, clientInstanceId),
      eq(agentTryConversations.createdByUserId, createdByUserId),
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
      collaborationWorkspaceId: input.collaborationWorkspaceId,
      createdByUserId: input.createdByUserId,
      createdByExternalUserId: input.createdByExternalUserId,
      visibility: "private",
      title: input.title,
      retainedUntil: input.retainedUntil
    });
    await tx.insert(agentTryConversations).values({
      conversationId: conversation.id,
      clientInstanceId,
      createdByUserId,
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
        eq(agentTryConversations.agentId, input.agentId)
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
    get: async (input) => {
      const [row] = await db
        .select({ agentId: agentTryConversations.agentId })
        .from(agentTryConversations)
        .where(
          and(
            eq(agentTryConversations.clientInstanceId, input.clientInstanceId),
            eq(agentTryConversations.conversationId, input.conversationId)
          )
        )
        .limit(1);
      return row;
    },
    open: (input) => openTryConversation(db, input),
    list: (input) => listTryConversations(db, input),
    remove: (input) => removeTryConversation(db, input)
  };
}
