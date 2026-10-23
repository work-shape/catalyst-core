import { lockActiveConversation, deleteConversation } from "./postgres-conversation-lifecycle";
export {
  lockActiveConversation,
  markLockedConversationTreeDeleted
} from "./postgres-conversation-lifecycle";
import {
  AppError,
  personalConnectionContextError,
  personalConversationPrivateError,
  createApprovalDecisionMessage,
  createPlatformId,
  type AppendAssistantMessageInput,
  type ApprovalRequest,
  type ChatMessage,
  type ClientInstanceId,
  type Conversation,
  type ConversationCreatedAssetInput,
  type ConversationId,
  type ConversationListItem,
  type ConversationsStore,
  type ConversationStore,
  type CreateConversationInput,
  type CreateMessageInput,
  type FoundFile,
  type ModelProviderContinuationCheckpoint,
  type ModelProviderContinuationStore,
  type MoveConversationInput,
  type SetConversationSubjectInput,
  type UserId
} from "@work-shape/catalyst-core";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, notExists, or, sql } from "drizzle-orm";
import { type PostgresConnection, type PostgresTransaction } from "./postgres-database";
import { mapConversation, mapMessage, type MessageRow } from "./rows";
import {
  collaborationWorkspaces,
  configAssetRevisions,
  configAssets,
  conversationCreatedAssets,
  conversationAttachments,
  conversations,
  messages,
  modelProviderContinuations,
  productUsers
} from "./schema";

export async function createConversation(
  db: PostgresConnection,
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
      retainedUntil: new Date(input.retainedUntil),
      ...(input.subject
        ? { subjectKind: input.subject.kind, subjectName: input.subject.name }
        : {}),
      ...(input.creationTarget ? { creationTarget: input.creationTarget } : {})
    })
    .returning();
  return mapConversation(row);
}

async function getConversation(
  db: PostgresConnection,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId
): Promise<Conversation | undefined> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.id, conversationId),
        isNull(conversations.workflowRunId)
      )
    )
    .limit(1);
  return row ? mapConversation(row) : undefined;
}

/** The messages of the Conversation of the enclosing statement. */
export function conversationMessages(db: PostgresConnection) {
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

/** The unsent draft attachments of the Conversation of the enclosing statement. */
export function conversationDraftAttachments(db: PostgresConnection) {
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

async function listPrivateConversationsCreatedByUser(
  db: PostgresConnection,
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
        eq(conversations.createdByUserId, input.userId),
        // A thread goes with its root (CR-1).
        eq(conversations.kind, "chat")
      )
    );
  return rows.map(mapConversation);
}

/**
 * Moves a chat Conversation with its run threads; a thread moves only so. The root is locked
 * first, as a subagent's start locks it before it writes its thread (CR-1): a thread started
 * before is seen by the update, and one started after reads the new workspace.
 */
async function moveConversation(
  db: PostgresConnection,
  input: MoveConversationInput
): Promise<Conversation> {
  return db.transaction(async (tx) => {
    if (
      !(await lockActiveConversation(
        tx,
        input.clientInstanceId,
        input.conversationId,
        input.fromCollaborationWorkspaceId
      ))
    ) {
      throw new AppError("CONFLICT", "Conversation workspace changed during the move");
    }
    const conversation = await getConversation(tx, input.clientInstanceId, input.conversationId);
    const [destination] = await tx
      .select()
      .from(collaborationWorkspaces)
      .where(
        and(
          eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
          eq(collaborationWorkspaces.id, input.toCollaborationWorkspaceId)
        )
      );
    if (
      conversation?.personalDataAt &&
      (!destination ||
        (destination.kind === "personal"
          ? destination.personalUserId !== conversation.createdByUserId
          : input.visibility !== "private"))
    ) {
      throw personalConversationPrivateError();
    }
    return moveLockedConversation(tx, input);
  });
}

async function moveLockedConversation(db: PostgresConnection, input: MoveConversationInput) {
  const rows = await db
    .update(conversations)
    .set({
      collaborationWorkspaceId: input.toCollaborationWorkspaceId,
      visibility: input.visibility
    })
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.status, "active"),
        eq(conversations.collaborationWorkspaceId, input.fromCollaborationWorkspaceId),
        or(
          and(eq(conversations.id, input.conversationId), eq(conversations.kind, "chat")),
          and(
            eq(conversations.parentConversationId, input.conversationId),
            eq(conversations.kind, "run_thread")
          )
        )
      )
    )
    .returning();
  const row = rows.find((candidate) => candidate.id === input.conversationId);
  if (!row) {
    throw new AppError("CONFLICT", "Conversation workspace changed during the move");
  }
  return mapConversation(row);
}

/**
 * The rule for every row that points to a stored object, and for every message: it is inserted
 * only under the Conversation row lock and only into an active Conversation. After a deletion or
 * expiry claimed the Conversation nothing new can appear, so cleanup sees every row.
 */
export async function requireActiveConversationLock(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId,
  /** The user whose run writes. Their deletion closes the Conversation for this write too. */
  runOwnerUserId?: UserId
): Promise<void> {
  if (!(await lockActiveConversation(tx, clientInstanceId, conversationId))) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  await requireNotInDeletion(tx, clientInstanceId, conversationId, runOwnerUserId);
}

/**
 * Refuses a write into a Conversation that a deletion is about to erase: its workspace is
 * marked, or the user it belongs to is. It belongs to its creator when it is private or in a
 * personal workspace, and for one write to the user whose run writes.
 *
 * The rows that carry the mark are read under a share lock, which the statement that sets the
 * mark waits for. So the mark is either visible here, or it commits after this transaction and
 * the deletion sees what was written. The workspace is locked before the users, the order of
 * the transaction that marks an account.
 */
async function requireNotInDeletion(
  tx: PostgresTransaction,
  clientInstanceId: ClientInstanceId,
  conversationId: ConversationId,
  runOwnerUserId: UserId | undefined
): Promise<void> {
  const [place] = await tx
    .select({
      deletionRequestedAt: collaborationWorkspaces.deletionRequestedAt,
      kind: collaborationWorkspaces.kind,
      visibility: conversations.visibility,
      createdByUserId: conversations.createdByUserId
    })
    .from(conversations)
    .innerJoin(
      collaborationWorkspaces,
      and(
        eq(collaborationWorkspaces.clientInstanceId, conversations.clientInstanceId),
        eq(collaborationWorkspaces.id, conversations.collaborationWorkspaceId)
      )
    )
    .where(
      and(
        eq(conversations.clientInstanceId, clientInstanceId),
        eq(conversations.id, conversationId),
        isNull(conversations.workflowRunId)
      )
    )
    .for("share", { of: collaborationWorkspaces });
  if (!place) {
    const [thread] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.clientInstanceId, clientInstanceId),
          eq(conversations.id, conversationId),
          eq(conversations.kind, "run_thread"),
          isNull(conversations.parentConversationId)
        )
      )
      .limit(1);
    if (thread) return;
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  const ownerUserId =
    place.visibility === "private" || place.kind === "personal" ? place.createdByUserId : undefined;
  const userIds = [
    ...new Set<string>([
      ...(ownerUserId ? [ownerUserId] : []),
      ...(runOwnerUserId ? [runOwnerUserId] : [])
    ])
  ].sort();
  const marked =
    place.deletionRequestedAt !== null ||
    (userIds.length > 0 &&
      (
        await tx
          .select({ deletionRequestedAt: productUsers.deletionRequestedAt })
          .from(productUsers)
          .where(
            and(
              eq(productUsers.clientInstanceId, clientInstanceId),
              inArray(productUsers.id, userIds)
            )
          )
          .orderBy(asc(productUsers.id))
          .for("share")
      ).some((user) => user.deletionRequestedAt !== null));
  if (marked) throw new AppError("CONFLICT", "Conversation no longer accepts messages");
}

async function replaceConversationTitle(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    expectedTitle: string;
    title: string;
    updatedAt: string;
  }
): Promise<boolean> {
  const rows = await db
    .update(conversations)
    .set({ title: input.title, updatedAt: new Date(input.updatedAt) })
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        eq(conversations.status, "active"),
        eq(conversations.title, input.expectedTitle)
      )
    )
    .returning({ id: conversations.id });
  return rows.length > 0;
}

async function updateConversationTitle(
  db: PostgresConnection,
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

async function setConversationSubject(
  db: PostgresConnection,
  input: SetConversationSubjectInput
): Promise<Conversation | undefined> {
  const [row] = await db
    .update(conversations)
    .set({ subjectKind: input.subject.kind, subjectName: input.subject.name })
    .where(
      and(
        eq(conversations.clientInstanceId, input.clientInstanceId),
        eq(conversations.id, input.conversationId),
        eq(conversations.status, "active")
      )
    )
    .returning();
  return row ? mapConversation(row) : undefined;
}

async function recordCreatedAsset(
  db: PostgresConnection,
  input: ConversationCreatedAssetInput
): Promise<void> {
  await db
    .insert(conversationCreatedAssets)
    .values({
      conversationId: input.conversationId,
      assetId: input.assetId,
      clientInstanceId: input.clientInstanceId,
      revision: input.revision,
      createdAt: new Date(input.createdAt)
    })
    .onConflictDoNothing();
}

async function createdAsset(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    kind: string;
    name: string;
  }
): Promise<boolean> {
  const [row] = await db
    .select({ assetId: conversationCreatedAssets.assetId })
    .from(conversationCreatedAssets)
    .innerJoin(configAssets, eq(configAssets.id, conversationCreatedAssets.assetId))
    .where(
      and(
        eq(conversationCreatedAssets.clientInstanceId, input.clientInstanceId),
        eq(conversationCreatedAssets.conversationId, input.conversationId),
        eq(configAssets.clientInstanceId, input.clientInstanceId),
        eq(configAssets.kind, input.kind),
        eq(configAssets.name, input.name),
        eq(configAssets.status, "active"),
        // A delete or a create since the one noted: the asset of the name is another one now.
        notExists(
          db
            .select({ revision: configAssetRevisions.revision })
            .from(configAssetRevisions)
            .where(
              and(
                eq(configAssetRevisions.assetId, conversationCreatedAssets.assetId),
                gt(configAssetRevisions.revision, conversationCreatedAssets.revision),
                inArray(configAssetRevisions.operation, ["create", "delete"])
              )
            )
        )
      )
    )
    .limit(1);
  return row !== undefined;
}

/** Called inside the approval transaction; the public hook reuses this idempotently. */
export async function appendApprovalDecision(
  db: PostgresConnection,
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

async function appendMessage(
  db: PostgresConnection,
  input: CreateMessageInput
): Promise<ChatMessage> {
  return db.transaction(async (tx) => mapMessage(await appendMessageRecord(tx, input)));
}

async function appendAssistantMessage(
  db: PostgresConnection,
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

async function listMessages(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }
): Promise<ChatMessage[]> {
  const [conversation] = await db
    .select({ status: conversations.status })
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

async function listRecentMessages(
  db: PostgresConnection,
  input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    limit: number;
  }
): Promise<ChatMessage[]> {
  const [conversation] = await db
    .select({ status: conversations.status })
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

export async function touchConversation(
  db: PostgresConnection,
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
        eq(conversations.id, conversationId),
        isNull(conversations.workflowRunId)
      )
    );
}

// The composition root supplies operations whose query modules depend on this module.
export function createPostgresConversationsStore(
  db: PostgresConnection,
  deps: Pick<
    ConversationsStore,
    | "listConversationsForWorkspace"
    | "listConversationsWithActiveRun"
    | "searchWorkspaceFiles"
    | "deleteModelProviderContinuation"
    | "getModelProviderContinuation"
    | "listExpiredConversations"
    | "expireConversation"
  >
): ConversationsStore {
  return {
    async createConversation(input: CreateConversationInput): Promise<Conversation> {
      return createConversation(db, input);
    },
    async getConversation(
      clientInstanceId: ClientInstanceId,
      conversationId: ConversationId
    ): Promise<Conversation | undefined> {
      return getConversation(db, clientInstanceId, conversationId);
    },
    async listConversationsForWorkspace(
      input: Parameters<ConversationStore["listConversationsForWorkspace"]>[0]
    ): Promise<Conversation[]> {
      return deps.listConversationsForWorkspace(input);
    },
    async listConversationsWithActiveRun(
      input: Parameters<ConversationStore["listConversationsWithActiveRun"]>[0]
    ): Promise<ConversationListItem[]> {
      return deps.listConversationsWithActiveRun(input);
    },
    async searchWorkspaceFiles(
      input: Parameters<ConversationsStore["searchWorkspaceFiles"]>[0]
    ): Promise<FoundFile[]> {
      return deps.searchWorkspaceFiles(input);
    },
    async listPrivateConversationsCreatedByUser(
      input: Parameters<ConversationStore["listPrivateConversationsCreatedByUser"]>[0]
    ): Promise<Conversation[]> {
      return listPrivateConversationsCreatedByUser(db, input);
    },
    async markPersonalData(input): Promise<void> {
      await db.transaction(async (tx) => {
        if (!(await lockActiveConversation(tx, input.clientInstanceId, input.conversationId))) {
          throw personalConnectionContextError("the conversation is no longer active");
        }
        const conversation = await getConversation(
          tx,
          input.clientInstanceId,
          input.conversationId
        );
        const [workspace] = conversation
          ? await tx
              .select()
              .from(collaborationWorkspaces)
              .where(
                and(
                  eq(collaborationWorkspaces.clientInstanceId, input.clientInstanceId),
                  eq(collaborationWorkspaces.id, conversation.collaborationWorkspaceId)
                )
              )
          : [];
        if (
          !conversation ||
          conversation.kind !== "chat" ||
          conversation.createdByUserId !== input.userId ||
          !workspace ||
          (workspace.kind === "personal"
            ? workspace.personalUserId !== input.userId
            : conversation.visibility !== "private")
        ) {
          throw personalConnectionContextError(
            "only the acting person may read the root conversation"
          );
        }
        await tx
          .update(conversations)
          .set({
            personalDataAt: sql`coalesce(${conversations.personalDataAt}, ${input.at}::timestamptz)`
          })
          .where(
            and(
              eq(conversations.clientInstanceId, input.clientInstanceId),
              eq(conversations.id, input.conversationId)
            )
          );
      });
    },
    async moveConversation(
      input: Parameters<ConversationStore["moveConversation"]>[0]
    ): Promise<Conversation> {
      return moveConversation(db, input);
    },
    async listExpiredConversations(input) {
      return deps.listExpiredConversations(input);
    },
    async updateConversationTitle(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      title: string;
      updatedAt: string;
    }): Promise<Conversation> {
      return updateConversationTitle(db, input);
    },
    async replaceConversationTitle(input): Promise<boolean> {
      return replaceConversationTitle(db, input);
    },
    async setConversationSubject(input): Promise<Conversation | undefined> {
      return setConversationSubject(db, input);
    },
    async recordCreatedAsset(input): Promise<void> {
      return recordCreatedAsset(db, input);
    },
    async createdAsset(input): Promise<boolean> {
      return createdAsset(db, input);
    },
    async appendMessage(input: CreateMessageInput): Promise<ChatMessage> {
      return appendMessage(db, input);
    },
    async appendAssistantMessage(input: AppendAssistantMessageInput): Promise<ChatMessage> {
      return appendAssistantMessage(db, input);
    },
    async listMessages(input): Promise<ChatMessage[]> {
      if (!input.forSharing) return listMessages(db, input);
      return db.transaction(async (tx) => {
        // Sharing and the first personal call serialize on the root, as moves do.
        const thread = await getConversation(tx, input.clientInstanceId, input.conversationId);
        const rootId = thread?.parentConversationId ?? input.conversationId;
        if (!(await lockActiveConversation(tx, input.clientInstanceId, rootId)))
          throw new AppError("NOT_FOUND", "Conversation is not available");
        const root = await getConversation(tx, input.clientInstanceId, rootId);
        if (root?.personalDataAt) throw personalConversationPrivateError();
        return listMessages(tx, input);
      });
    },
    async listRecentMessages(input: {
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      limit: number;
    }): Promise<ChatMessage[]> {
      return listRecentMessages(db, input);
    },
    async getModelProviderContinuation(
      input: Parameters<ModelProviderContinuationStore["getModelProviderContinuation"]>[0]
    ): Promise<ModelProviderContinuationCheckpoint | undefined> {
      return deps.getModelProviderContinuation(input);
    },
    async deleteModelProviderContinuation(
      input: Parameters<ModelProviderContinuationStore["deleteModelProviderContinuation"]>[0]
    ): Promise<void> {
      return deps.deleteModelProviderContinuation(input);
    },
    async deleteConversation(
      input: Parameters<ConversationStore["deleteConversation"]>[0]
    ): Promise<Conversation> {
      return deleteConversation(db, input);
    },
    async expireConversation(input) {
      return deps.expireConversation(input);
    }
  };
}
