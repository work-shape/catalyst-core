import { and, asc, desc, eq, isNull, ne } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  AppError,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationAttachmentId,
  type ConversationId,
  type CreateConversationAttachmentInput,
  type CreateManagedFileInput,
  type DocumentAttachmentStore,
  type DraftAttachment,
  type ManagedFileId,
  type ManagedFileRecord,
  type MessageId,
  type UpdateConversationAttachmentInput,
  createPlatformId
} from "@vivd-catalyst/core";
import { mapConversationAttachment, mapManagedFile } from "./rows";
import { conversationAttachments, managedFiles, schema } from "./schema";

type PostgresDatabase = PostgresJsDatabase<typeof schema>;

export interface PostgresDocumentAttachmentStoreCallbacks {
  requireActiveConversation(clientInstanceId: ClientInstanceId, conversationId: ConversationId): Promise<void>;
  touchConversation(
    clientInstanceId: ClientInstanceId,
    conversationId: ConversationId,
    updatedAt: Date
  ): Promise<void>;
}

export function createPostgresDocumentAttachmentStore(
  db: PostgresDatabase,
  callbacks: PostgresDocumentAttachmentStoreCallbacks
): DocumentAttachmentStore {
  return new PostgresDocumentAttachmentStore(db, callbacks);
}

class PostgresDocumentAttachmentStore implements DocumentAttachmentStore {
  constructor(
    private readonly db: PostgresDatabase,
    private readonly callbacks: PostgresDocumentAttachmentStoreCallbacks
  ) {}

  async createManagedFile(input: CreateManagedFileInput): Promise<ManagedFileRecord> {
    const [row] = await this.db
      .insert(managedFiles)
      .values({
        id: createPlatformId<"ManagedFileId">("file"),
        clientInstanceId: input.clientInstanceId,
        ownerUserId: input.ownerUserId,
        filename: input.filename,
        mimeType: input.mimeType ?? null,
        byteSize: input.byteSize,
        checksum: input.checksum,
        objectKey: input.objectKey,
        status: "available",
        createdAt: new Date()
      })
      .returning();
    return mapManagedFile(row);
  }

  async getManagedFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<ManagedFileRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(managedFiles)
      .where(
        and(
          eq(managedFiles.clientInstanceId, input.clientInstanceId),
          eq(managedFiles.id, input.fileId),
          ne(managedFiles.status, "deleted")
        )
      )
      .limit(1);
    return row ? mapManagedFile(row) : undefined;
  }

  async createConversationAttachment(
    input: CreateConversationAttachmentInput
  ): Promise<ConversationAttachment> {
    await this.callbacks.requireActiveConversation(input.clientInstanceId, input.conversationId);

    const now = new Date();
    const [row] = await this.db
      .insert(conversationAttachments)
      .values({
        id: createPlatformId<"ConversationAttachmentId">("att"),
        clientInstanceId: input.clientInstanceId,
        conversationId: input.conversationId,
        fileId: input.fileId,
        filename: input.filename,
        mimeType: input.mimeType ?? null,
        byteSize: input.byteSize,
        checksum: input.checksum,
        status: input.status,
        format: input.format ?? null,
        warnings: input.warnings ?? [],
        error: input.error ?? null,
        createdAt: now,
        updatedAt: now
      })
      .returning();
    await this.callbacks.touchConversation(input.clientInstanceId, input.conversationId, now);
    return mapConversationAttachment(row);
  }

  async getConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
  }): Promise<ConversationAttachment | undefined> {
    const [row] = await this.db
      .select()
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.id, input.attachmentId),
          ne(conversationAttachments.status, "deleted")
        )
      )
      .limit(1);
    return row ? mapConversationAttachment(row) : undefined;
  }

  async listDraftAttachments(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<DraftAttachment[]> {
    const rows = await this.db
      .select()
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.conversationId, input.conversationId),
          isNull(conversationAttachments.messageId),
          ne(conversationAttachments.status, "deleted")
        )
      )
      .orderBy(asc(conversationAttachments.createdAt));
    return rows.map(mapConversationAttachment) as DraftAttachment[];
  }

  async updateConversationAttachment(
    input: UpdateConversationAttachmentInput
  ): Promise<ConversationAttachment> {
    const set: Partial<typeof conversationAttachments.$inferInsert> = {
      updatedAt: new Date()
    };
    if (input.status !== undefined) {
      set.status = input.status;
    }
    if (input.format !== undefined) {
      set.format = input.format;
    }
    if (input.preparedDocumentId !== undefined) {
      set.preparedDocumentId = input.preparedDocumentId;
    }
    if (input.preparedObjectKey !== undefined) {
      set.preparedObjectKey = input.preparedObjectKey;
    }
    if (input.characterCount !== undefined) {
      set.characterCount = input.characterCount;
    }
    if (input.wordCount !== undefined) {
      set.wordCount = input.wordCount;
    }
    if (input.pageCount !== undefined) {
      set.pageCount = input.pageCount;
    }
    if (input.warnings !== undefined) {
      set.warnings = input.warnings;
    }
    if (input.error !== undefined) {
      set.error = input.error;
    }
    if (input.preprocessingStartedAt !== undefined) {
      set.preprocessingStartedAt = new Date(input.preprocessingStartedAt);
    }
    if (input.preprocessingCompletedAt !== undefined) {
      set.preprocessingCompletedAt = new Date(input.preprocessingCompletedAt);
    }
    if (input.deletedAt !== undefined) {
      set.deletedAt = new Date(input.deletedAt);
    }

    const [row] = await this.db
      .update(conversationAttachments)
      .set(set)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.id, input.attachmentId)
        )
      )
      .returning();
    if (!row) {
      throw new AppError("NOT_FOUND", "Attachment is not available");
    }
    return mapConversationAttachment(row);
  }

  async deleteDraftAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    deletedAt: string;
  }): Promise<ConversationAttachment> {
    const deletedAt = new Date(input.deletedAt);
    const [row] = await this.db
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
          eq(conversationAttachments.id, input.attachmentId),
          isNull(conversationAttachments.messageId)
        )
      )
      .returning();
    if (!row) {
      throw new AppError("NOT_FOUND", "Draft attachment is not available");
    }
    await this.callbacks.touchConversation(input.clientInstanceId, input.conversationId, deletedAt);
    return mapConversationAttachment(row);
  }

  async claimReadyDraftAttachmentsForMessage(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    messageId: MessageId;
    claimedAt: string;
  }): Promise<ConversationAttachment[]> {
    const claimedAt = new Date(input.claimedAt);
    const rows = await this.db
      .update(conversationAttachments)
      .set({
        messageId: input.messageId,
        updatedAt: claimedAt
      })
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.conversationId, input.conversationId),
          eq(conversationAttachments.status, "ready"),
          isNull(conversationAttachments.messageId)
        )
      )
      .returning();
    return rows.map(mapConversationAttachment);
  }

  async findReadableDocumentAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined> {
    const [row] = await this.db
      .select()
      .from(conversationAttachments)
      .where(
        and(
          eq(conversationAttachments.clientInstanceId, input.clientInstanceId),
          eq(conversationAttachments.conversationId, input.conversationId),
          eq(conversationAttachments.fileId, input.fileId),
          eq(conversationAttachments.status, "ready"),
          ne(conversationAttachments.preparedObjectKey, "")
        )
      )
      .orderBy(desc(conversationAttachments.updatedAt))
      .limit(1);
    return row?.preparedObjectKey ? mapConversationAttachment(row) : undefined;
  }
}
