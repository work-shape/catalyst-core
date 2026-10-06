import { and, asc, desc, eq, exists, isNull, lt, lte, ne, notExists, or } from "drizzle-orm";
import {
  AppError,
  createApprovalDecisionMessage,
  type ApprovalRequest,
  type AppendAssistantMessageInput,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ConversationId,
  type ConversationListScope,
  type CreateConversationInput,
  type CreateMessageInput,
  type MoveConversationInput,
  createPlatformId
} from "@vivd-catalyst/core";
import type { PostgresDatabase, PostgresTransaction } from "./postgres-database";
import { mapConversation, mapMessage, type MessageRow } from "./rows";
import {
  conversationAttachments,
  conversations,
  modelProviderContinuations,
  messages,
  structuredDataResources
} from "./schema";

export async function createConversation(
  db: PostgresDatabase,
  input: CreateConversationInput
): Promise<Conversation> {
  const id = createPlatformId<"ConversationId">("conv");
  const now = new Date();
  const [row] = await db
    .insert(conversations)
    .values({
      id,
      clientInstanceId: input.clientInstanceId,
      collaborationWorkspaceId: input.collaborationWorkspaceId,
      createdByUserId: input.createdByUserId,
      createdByExternalUserId: input.createdByExternalUserId,
      visibility: input.visibility,
      title: input.title,
      status: "active",
      createdAt: now,
      updatedAt: now,
      retainedUntil: new Date(input.retainedUntil)
    })
    .returning();
  return mapConversation(row);
}

export async function getConversation(
  db: PostgresDatabase,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
): Promise<Conversation | undefined> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.id, conversationId)
      )
    )
    .limit(1);
  return row ? mapConversation(row) : undefined;
}

export async function listConversationsForWorkspace(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    collaborationWorkspaceId: Conversation["collaborationWorkspaceId"];
    scope: ConversationListScope;
  }
): Promise<Conversation[]> {
  const { scope } = input;
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.collaborationWorkspaceId, input.collaborationWorkspaceId),
        eq(conversations.status, "active"),
        ...(scope.kind === "lifecycle"
          ? []
          : [
              or(
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
              )
            ])
      )
    )
    .orderBy(desc(conversations.updatedAt));
  return rows.map(mapConversation);
}

function conversationMessages(db: PostgresDatabase) {
  return db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.clientInstanceId, conversations.clientInstanceId),
        eq(messages.conversationId, conversations.id)
      )
    );
}

function conversationDraftAttachments(db: PostgresDatabase) {
  return db
    .select({ id: conversationAttachments.id })
    .from(conversationAttachments)
    .where(
      and(
        eq(conversationAttachments.clientInstanceId, conversations.clientInstanceId),
        eq(conversationAttachments.conversationId, conversations.id),
        isNull(conversationAttachments.messageId),
        ne(conversationAttachments.status, "deleted")
      )
    );
}

export async function listPrivateConversationsCreatedByUser(
  db: PostgresDatabase,
  input: { clientInstanceId: ClientInstanceId; userId: string }
): Promise<Conversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.status, "active"),
        eq(conversations.visibility, "private"),
        eq(conversations.createdByUserId, input.userId)
      )
    );
  return rows.map(mapConversation);
}

export async function moveConversation(
  db: PostgresDatabase,
  input: MoveConversationInput
): Promise<Conversation> {
  const [row] = await db
    .update(conversations)
    .set({
      collaborationWorkspaceId: input.toCollaborationWorkspaceId,
      visibility: input.visibility
    })
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        eq(conversations.status, "active"),
        eq(conversations.collaborationWorkspaceId, input.fromCollaborationWorkspaceId)
      )
    )
    .returning();
  if (!row) {
    throw new AppError("CONFLICT", "Conversation workspace changed during the move");
  }
  return mapConversation(row);
}

export async function listExpiredConversations(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    now?: string;
    abandonedBefore?: string;
    limit: number;
  }
): Promise<Conversation[]> {
  if (!input.now && !input.abandonedBefore) {
    return [];
  }
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.status, "active"),
        or(
          input.now ? lte(conversations.retainedUntil, new Date(input.now)) : undefined,
          input.abandonedBefore
            ? and(
                lte(conversations.updatedAt, new Date(input.abandonedBefore)),
                notExists(conversationMessages(db)),
                notExists(conversationDraftAttachments(db))
              )
            : undefined
        )
      )
    )
    .orderBy(asc(conversations.retainedUntil), asc(conversations.id))
    .limit(input.limit);
  return rows.map(mapConversation);
}

export async function updateConversationTitle(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    title: string;
    updatedAt: string;
  }
): Promise<Conversation> {
  const [row] = await db
    .update(conversations)
    .set({
      title: input.title,
      updatedAt: new Date(input.updatedAt)
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

/** Called inside the approval transaction; the public hook reuses this idempotently. */
export async function appendApprovalDecision(
  db: PostgresDatabase | PostgresTransaction,
  request: ApprovalRequest
): Promise<void> {
  const input = createApprovalDecisionMessage(request);
  if (!input) {
    return;
  }
  const identity = and(
    eq(conversations.clientInstanceId, input.clientInstanceId),
    eq(conversations.id, input.conversationId),
    eq(conversations.status, "active")
  );
  // Serialize with deletion/retention; a decision must never resurrect erased history.
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(identity)
    .for("update")
    .limit(1);
  if (!conversation) {
    return;
  }
  const createdAt = new Date();
  const [inserted] = await db
    .insert(messages)
    .values({
      ...input,
      createdAt,
      metadata: input.metadata ?? {}
    })
    .onConflictDoNothing({ target: messages.id })
    .returning({ id: messages.id });
  if (inserted) {
    await db.update(conversations).set({ updatedAt: createdAt }).where(identity);
  }
}

export async function appendMessage(
  db: PostgresDatabase,
  input: CreateMessageInput
): Promise<ChatMessage> {
  return mapMessage(await appendMessageRecord(db, input));
}

export async function appendAssistantMessage(
  db: PostgresDatabase,
  input: AppendAssistantMessageInput
): Promise<ChatMessage> {
  return db.transaction(async (tx) => {
    const row = await appendMessageRecord(tx, { ...input, role: "assistant" });
    if (input.providerContinuation) {
      await tx
        .insert(modelProviderContinuations)
        .values({
          clientInstanceId: row.clientInstanceId,
          conversationId: row.conversationId,
          providerId: input.providerContinuation.providerId,
          state: input.providerContinuation.state,
          sourceMessageId: row.id,
          sourceStorageOrdinal: row.storageOrdinal,
          updatedAt: row.createdAt
        })
        .onConflictDoUpdate({
          target: [
            modelProviderContinuations.clientInstanceId,
            modelProviderContinuations.conversationId,
            modelProviderContinuations.providerId
          ],
          set: {
            state: input.providerContinuation.state,
            sourceMessageId: row.id,
            sourceStorageOrdinal: row.storageOrdinal,
            updatedAt: row.createdAt
          },
          setWhere: lt(modelProviderContinuations.sourceStorageOrdinal, row.storageOrdinal)
        });
    }
    return mapMessage(row);
  });
}

async function appendMessageRecord(
  db: PostgresDatabase | PostgresTransaction,
  input: CreateMessageInput
): Promise<MessageRow> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId)
      )
    )
    .limit(1);
  if (!conversation || conversation.status !== "active") {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }

  const id = input.id ?? createPlatformId<"MessageId">("msg");
  const createdAt = new Date();
  const [row] = await db
    .insert(messages)
    .values({
      id,
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      role: input.role,
      text: input.text,
      createdAt,
      metadata: input.metadata ?? {}
    })
    .returning();
  await db
    .update(conversations)
    .set({ updatedAt: createdAt })
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId)
      )
    );
  if (!row) {
    throw new AppError("INTERNAL", "Expected inserted message row");
  }
  return row;
}

export async function listMessages(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<ChatMessage[]> {
  const conversation = await getConversation(db, input.clientInstanceId, input.conversationId);
  if (!conversation || conversation.status !== "active") {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }

  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.clientInstanceId, input.clientInstanceId),
        eq(messages.conversationId, input.conversationId)
      )
    )
    .orderBy(asc(messages.createdAt), asc(messages.storageOrdinal));
  return rows.map(mapMessage);
}

export async function listRecentMessages(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    limit: number;
  }
): Promise<ChatMessage[]> {
  const conversation = await getConversation(db, input.clientInstanceId, input.conversationId);
  if (!conversation || conversation.status !== "active") {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }

  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.clientInstanceId, input.clientInstanceId),
        eq(messages.conversationId, input.conversationId)
      )
    )
    .orderBy(desc(messages.createdAt), desc(messages.storageOrdinal))
    .limit(input.limit);
  return rows.map(mapMessage).reverse();
}

export async function deleteConversation(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
  }
): Promise<Conversation> {
  return markConversationDeleted(db, {
    ...input,
    status: "deleted"
  });
}

export async function expireConversation(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    expiredAt: string;
  }
): Promise<Conversation> {
  return markConversationDeleted(db, {
    clientInstanceId: input.clientInstanceId,
    conversationId: input.conversationId,
    deletedAt: input.expiredAt,
    status: "retention_expired"
  });
}

async function markConversationDeleted(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
    status: Conversation["status"];
  }
): Promise<Conversation> {
  const deletedAt = new Date(input.deletedAt);
  return db.transaction(async (tx) => {
    // Use the same lock as asynchronous decision insertion before deleting messages.
    await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, input.clientInstanceId),
          eq(conversations.id, input.conversationId)
        )
      )
      .for("update");
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
  });
}

export async function requireActiveConversation(
  db: PostgresDatabase,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
): Promise<void> {
  const conversation = await getConversation(db, clientInstanceId, conversationId);
  if (!conversation || conversation.status !== "active") {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
}

export async function touchConversation(
  db: PostgresDatabase,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId,
  updatedAt: Date
): Promise<void> {
  await db
    .update(conversations)
    .set({ updatedAt })
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.id, conversationId)
      )
    );
}
