import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  type SQL
} from "drizzle-orm";
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
  type ExpireConversationResult,
  type MoveConversationInput,
  createPlatformId
} from "@vivd-catalyst/core";
import type { PostgresDatabase, PostgresTransaction } from "./postgres-database";
import { mapConversation, mapMessage, type MessageRow } from "./rows";
import {
  agentRuns,
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

/**
 * Takes the Conversation row lock. Every write that decides whether a Conversation may expire
 * holds it: run acceptance, attachment creation and restore, deletion and expiry. Returns false
 * when the Conversation is not active.
 */
export async function lockActiveConversation(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
): Promise<boolean> {
  const [locked] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.id, conversationId),
        eq(conversations.status, "active")
      )
    )
    .for("update")
    .limit(1);
  return locked !== undefined;
}

/**
 * The rule for every row that points to a stored object, and for every message: it is inserted
 * only under the Conversation row lock and only into an active Conversation. After a deletion or
 * expiry claimed the Conversation nothing new can appear, so cleanup sees every row.
 */
export async function requireActiveConversationLock(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
): Promise<void> {
  if (!(await lockActiveConversation(tx, clientInstanceId, conversationId))) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
}

function conversationRunsInProgress(db: PostgresDatabase | PostgresTransaction) {
  return db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.clientInstanceId, conversations.clientInstanceId),
        eq(agentRuns.conversationId, conversations.id),
        inArray(agentRuns.status, ["queued", "running", "waiting_for_permission", "cancelling"])
      )
    );
}

/**
 * The expiry criteria as conditions on a `conversations` row. The list and the claim both use
 * them, so they cannot drift. A Conversation with an agent run in progress meets neither.
 */
function conversationExpiryCriteria(
  db: PostgresDatabase | PostgresTransaction,
  input: { now?: string; abandonedBefore?: string }
): { due: SQL | undefined; abandoned: SQL | undefined } {
  const idle = notExists(conversationRunsInProgress(db));
  return {
    due: input.now ? and(lte(conversations.retainedUntil, new Date(input.now)), idle) : undefined,
    abandoned: input.abandonedBefore
      ? and(
          lte(conversations.updatedAt, new Date(input.abandonedBefore)),
          notExists(conversationMessages(db)),
          notExists(conversationDraftAttachments(db)),
          idle
        )
      : undefined
  };
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
  const criteria = conversationExpiryCriteria(db, input);
  if (!criteria.due && !criteria.abandoned) {
    return [];
  }
  const rows = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.status, "active"),
        or(criteria.due, criteria.abandoned)
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
  return db.transaction(async (tx) => mapMessage(await appendMessageRecord(tx, input)));
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
  tx: PostgresTransaction,
  input: CreateMessageInput
): Promise<MessageRow> {
  await requireActiveConversationLock(tx, input.clientInstanceId, input.conversationId);

  const id = input.id ?? createPlatformId<"MessageId">("msg");
  const createdAt = new Date();
  const [row] = await tx
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
  await tx
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
  return db.transaction(async (tx) => {
    if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId))) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    return markLockedConversationDeleted(tx, { ...input, status: "deleted" });
  });
}

export async function expireConversation(
  db: PostgresDatabase,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    expiredAt: string;
    now?: string;
    abandonedBefore?: string;
  }
): Promise<ExpireConversationResult> {
  return db.transaction(async (tx) => {
    if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId))) {
      return { status: "not_expired" };
    }
    // Evaluated in statements of their own, after the lock is held. A condition inside the
    // locking statement is answered from the snapshot taken before the wait and would miss the
    // message or upload the lock holder just committed.
    const criteria = conversationExpiryCriteria(tx, input);
    const due = await lockedConversationMeets(tx, input, criteria.due);
    if (!due && !(await lockedConversationMeets(tx, input, criteria.abandoned))) {
      return { status: "not_expired" };
    }
    const conversation = await markLockedConversationDeleted(tx, {
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      deletedAt: input.expiredAt,
      status: "retention_expired"
    });
    return {
      status: "expired",
      conversation,
      reason: due ? "retention_due" : "abandoned_draft"
    };
  });
}

async function lockedConversationMeets(
  tx: PostgresTransaction,
  input: { clientInstanceId: ClientInstanceId; conversationId: ConversationId },
  criterion: SQL | undefined
): Promise<boolean> {
  if (!criterion) {
    return false;
  }
  const [row] = await tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        criterion
      )
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Deletes the Conversation's messages and structured data and marks its attachments and the
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
}

export async function touchConversation(
  db: PostgresDatabase | PostgresTransaction,
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
