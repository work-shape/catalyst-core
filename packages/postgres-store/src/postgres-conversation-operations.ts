import { and, asc, desc, eq, lte, ne } from "drizzle-orm";
import {
  AppError,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ConversationId,
  type CreateConversationInput,
  type CreateMessageInput,
  createPlatformId
} from "@vivd-catalyst/core";
import type { PostgresDatabase } from "./postgres-database";
import { mapConversation, mapMessage } from "./rows";
import { conversationAttachments, conversations, messages } from "./schema";

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
      ownerUserId: input.ownerUserId,
      ownerExternalUserId: input.ownerExternalUserId,
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
    .where(and(eq(conversations.clientInstanceId, clientInstanceId), eq(conversations.id, conversationId)))
    .limit(1);
  return row ? mapConversation(row) : undefined;
}

export async function listConversationsForUser(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    ownerUserId: string;
  }
): Promise<Conversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.ownerUserId, input.ownerUserId),
        eq(conversations.status, "active")
      )
    )
    .orderBy(desc(conversations.updatedAt));
  return rows.map(mapConversation);
}

export async function listExpiredConversations(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    now: string;
    limit: number;
  }
): Promise<Conversation[]> {
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.status, "active"),
        lte(conversations.retainedUntil, new Date(input.now))
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

export async function appendMessage(
  db: PostgresDatabase,
  input: CreateMessageInput
): Promise<ChatMessage> {
  const conversation = await getConversation(db, input.clientInstanceId, input.conversationId);
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
  return mapMessage(row);
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
    .orderBy(asc(messages.createdAt));
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
    .orderBy(desc(messages.createdAt))
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
    .where(and(eq(conversations.clientInstanceId, clientInstanceId), eq(conversations.id, conversationId)));
}
