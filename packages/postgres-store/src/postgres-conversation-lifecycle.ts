import {
  AppError,
  asConversationId,
  type ClientInstanceId,
  type ConversationId,
  type CollaborationWorkspaceId,
  type Conversation
} from "@work-shape/catalyst-core";
import { and, asc, eq, ne, notExists } from "drizzle-orm";
import { type PostgresConnection, type PostgresTransaction } from "./postgres-database";
import { mapConversation } from "./rows";
import {
  conversations,
  conversationAttachments,
  conversationFollowUps,
  conversationCreatedAssets,
  messages,
  structuredDataResources,
  managedArtifacts,
  executionWorkspaces,
  pages,
  pageBuilds,
  previewReports,
  previewViewerReports,
  agentRuns,
  agentTryConversations,
  assetCheckouts
} from "./schema";

/**
 * Takes the Conversation row lock. Every write that decides whether a Conversation may expire
 * holds it: run acceptance, attachment creation and restore, deletion and expiry. Returns false
 * when the Conversation is not active, or is not in the workspace the caller names. The
 * workspace is a column of the locked row, so it is read again after a wait for the lock: a
 * Conversation that was moved away meanwhile is not locked.
 */
export async function lockActiveConversation(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId,
  inCollaborationWorkspaceId?: CollaborationWorkspaceId
): Promise<boolean> {
  const [locked] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.id, conversationId),
        eq(conversations.status, "active"),
        inCollaborationWorkspaceId === undefined
          ? undefined
          : eq(conversations.collaborationWorkspaceId, inCollaborationWorkspaceId)
      )
    )
    .for("update")
    .limit(1);
  return locked !== undefined;
}

export async function deleteConversation(
  db: PostgresConnection,
  input: {
    discardEmptyByUserId?: string;
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
    inCollaborationWorkspaceId?: CollaborationWorkspaceId;
  }
): Promise<Conversation> {
  return db.transaction(async (tx) => {
    const locked = await lockActiveConversation(
      tx,
      input.clientInstanceId,
      input.conversationId,
      input.inCollaborationWorkspaceId
    );
    if (!locked) throw new AppError("NOT_FOUND", "Conversation is not available");
    if (input.discardEmptyByUserId !== undefined) {
      const [discarded] = await tx
        .delete(conversations)
        .where(
          and(
            eq(conversations.clientInstanceId, input.clientInstanceId),
            eq(conversations.id, input.conversationId),
            eq(conversations.kind, "chat"),
            eq(conversations.createdByUserId, input.discardEmptyByUserId),
            notExists(
              tx
                .select({ id: messages.id })
                .from(messages)
                .where(eq(messages.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: conversationAttachments.id })
                .from(conversationAttachments)
                .where(eq(conversationAttachments.conversationId, conversations.id))
            ),
            // A discard removes only a pristine draft. Keep every row whose cleanup still
            // needs object keys, a Try child, a run, or any other conversation content.
            notExists(
              tx
                .select({ id: managedArtifacts.conversationId })
                .from(managedArtifacts)
                .where(eq(managedArtifacts.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: executionWorkspaces.conversationId })
                .from(executionWorkspaces)
                .where(eq(executionWorkspaces.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: pages.conversationId })
                .from(pages)
                .where(eq(pages.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: pageBuilds.conversationId })
                .from(pageBuilds)
                .where(eq(pageBuilds.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: agentRuns.conversationId })
                .from(agentRuns)
                .where(eq(agentRuns.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: assetCheckouts.conversationId })
                .from(assetCheckouts)
                .where(eq(assetCheckouts.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: structuredDataResources.conversationId })
                .from(structuredDataResources)
                .where(eq(structuredDataResources.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: conversationFollowUps.conversationId })
                .from(conversationFollowUps)
                .where(eq(conversationFollowUps.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: conversationCreatedAssets.assetId })
                .from(conversationCreatedAssets)
                .where(eq(conversationCreatedAssets.conversationId, conversations.id))
            ),
            notExists(
              tx
                .select({ id: agentTryConversations.conversationId })
                .from(agentTryConversations)
                .where(eq(agentTryConversations.conversationId, conversations.id))
            )
          )
        )
        .returning();
      if (!discarded)
        throw new AppError("CONFLICT", "Only your empty conversation draft can be discarded");
      return { ...mapConversation(discarded), status: "deleted" };
    }
    return markLockedConversationTreeDeleted(tx, { ...input, status: "deleted" });
  });
}

/**
 * Claims a locked chat Conversation with its run threads (CR-1): the threads are locked in id
 * order after the root, then each is marked deleted as the root is. A thread is never claimed
 * alone: it goes with its root.
 */
export async function markLockedConversationTreeDeleted(
  tx: PostgresTransaction,
  input: Parameters<typeof markLockedConversationDeleted>[1]
): Promise<Conversation> {
  const [root] = await tx
    .select({ kind: conversations.kind })
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId)
      )
    );
  if (root?.kind !== "chat") {
    throw new AppError("CONFLICT", "A subagent's thread is deleted with its conversation");
  }
  const threads = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.parentConversationId, input.conversationId),
        eq(conversations.status, "active")
      )
    )
    .orderBy(asc(conversations.id))
    .for("update");
  for (const thread of threads) {
    await markLockedConversationDeleted(tx, {
      ...input,
      conversationId: asConversationId(thread.id)
    });
  }
  return markLockedConversationDeleted(tx, input);
}

/**
 * Deletes the Conversation's messages, structured data and preview reports and marks its attachments and the
 * Conversation itself deleted. The caller holds the row lock. Files, artifacts, preview state
 * and the execution workspace stay for the cleanup that follows.
 */
async function markLockedConversationDeleted(
  tx: PostgresTransaction,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
    status: Conversation["status"];
  }
): Promise<Conversation> {
  const deletedAt = new Date(input.deletedAt);
  await tx
    .update(conversationAttachments)
    .set({
      status: "deleted",
      deletedAt,
      updatedAt: deletedAt
    })
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
        eq(conversationAttachments.conversationId, input.conversationId),
        ne(conversationAttachments.status, "deleted")
      )
    );
  await tx
    .delete(conversationFollowUps)
    .where(
      and(
        eq(conversationFollowUps.clientInstanceId, input.clientInstanceId),
        eq(conversationFollowUps.conversationId, input.conversationId)
      )
    );
  await tx
    .delete(messages)
    .where(
      and(
        eq(messages.clientInstanceId, input.clientInstanceId),
        eq(messages.conversationId, input.conversationId)
      )
    );
  await tx
    .delete(structuredDataResources)
    .where(
      and(
        eq(structuredDataResources.clientInstanceId, input.clientInstanceId),
        eq(structuredDataResources.conversationId, input.conversationId)
      )
    );
  await tx
    .delete(conversationCreatedAssets)
    .where(
      and(
        eq(conversationCreatedAssets.clientInstanceId, input.clientInstanceId),
        eq(conversationCreatedAssets.conversationId, input.conversationId)
      )
    );
  // What its previews reported is diagnostics of the conversation and goes with it.
  for (const reports of [previewViewerReports, previewReports]) {
    await tx
      .delete(reports)
      .where(
        and(
          eq(reports.clientInstanceId, input.clientInstanceId),
          eq(reports.conversationId, input.conversationId)
        )
      );
  }
  const [row] = await tx
    .update(conversations)
    .set({
      status: input.status,
      deletedAt,
      updatedAt: deletedAt
    })
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        eq(conversations.status, "active")
      )
    )
    .returning();
  if (!row) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  return mapConversation(row);
}
