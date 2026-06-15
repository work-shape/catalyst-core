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
} from "./index";

export type InMemoryDocumentAttachmentStore = DocumentAttachmentStore & {
  deleteAttachmentsForConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
  }): void;
};

export interface InMemoryDocumentAttachmentCallbacks {
  requireActiveConversation(clientInstanceId: ClientInstanceId, conversationId: ConversationId): Promise<void>;
  touchConversation(conversationId: ConversationId, updatedAt: string): void;
}

export function createInMemoryDocumentAttachmentStore(
  callbacks: InMemoryDocumentAttachmentCallbacks
): InMemoryDocumentAttachmentStore {
  return new InMemoryDocumentAttachmentStoreImpl(callbacks);
}

class InMemoryDocumentAttachmentStoreImpl implements InMemoryDocumentAttachmentStore {
  private readonly managedFiles = new Map<string, ManagedFileRecord>();
  private readonly conversationAttachments = new Map<string, ConversationAttachment>();

  constructor(private readonly callbacks: InMemoryDocumentAttachmentCallbacks) {}

  async createManagedFile(input: CreateManagedFileInput): Promise<ManagedFileRecord> {
    const file: ManagedFileRecord = {
      id: createPlatformId("file"),
      clientInstanceId: input.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      checksum: input.checksum,
      objectKey: input.objectKey,
      status: "available",
      createdAt: new Date().toISOString()
    };
    this.managedFiles.set(file.id, file);
    return file;
  }

  async getManagedFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<ManagedFileRecord | undefined> {
    const file = this.managedFiles.get(input.fileId);
    if (!file || file.clientInstanceId !== input.clientInstanceId || file.status === "deleted") {
      return undefined;
    }
    return file;
  }

  async createConversationAttachment(
    input: CreateConversationAttachmentInput
  ): Promise<ConversationAttachment> {
    await this.callbacks.requireActiveConversation(input.clientInstanceId, input.conversationId);

    const now = new Date().toISOString();
    const attachment: ConversationAttachment = {
      id: createPlatformId("att"),
      clientInstanceId: input.clientInstanceId,
      conversationId: input.conversationId,
      fileId: input.fileId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      checksum: input.checksum,
      status: input.status,
      format: input.format,
      warnings: input.warnings ?? [],
      error: input.error,
      createdAt: now,
      updatedAt: now
    };
    this.conversationAttachments.set(attachment.id, attachment);
    this.callbacks.touchConversation(input.conversationId, now);
    return attachment;
  }

  async getConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
  }): Promise<ConversationAttachment | undefined> {
    const attachment = this.conversationAttachments.get(input.attachmentId);
    if (
      !attachment ||
      attachment.clientInstanceId !== input.clientInstanceId ||
      attachment.status === "deleted"
    ) {
      return undefined;
    }
    return attachment;
  }

  async listDraftAttachments(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<DraftAttachment[]> {
    return [...this.conversationAttachments.values()]
      .filter(
        (attachment) =>
          attachment.clientInstanceId === input.clientInstanceId &&
          attachment.conversationId === input.conversationId &&
          attachment.messageId === undefined &&
          attachment.status !== "deleted"
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)) as DraftAttachment[];
  }

  async updateConversationAttachment(
    input: UpdateConversationAttachmentInput
  ): Promise<ConversationAttachment> {
    const existing = this.conversationAttachments.get(input.attachmentId);
    if (!existing || existing.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "Attachment is not available");
    }

    const updated: ConversationAttachment = {
      ...existing,
      status: input.status ?? existing.status,
      format: input.format ?? existing.format,
      preparedDocumentId:
        input.preparedDocumentId === undefined
          ? existing.preparedDocumentId
          : (input.preparedDocumentId ?? undefined),
      preparedObjectKey:
        input.preparedObjectKey === undefined
          ? existing.preparedObjectKey
          : (input.preparedObjectKey ?? undefined),
      characterCount: input.characterCount ?? existing.characterCount,
      wordCount: input.wordCount ?? existing.wordCount,
      pageCount: input.pageCount ?? existing.pageCount,
      warnings: input.warnings ?? existing.warnings,
      error: input.error === undefined ? existing.error : (input.error ?? undefined),
      preprocessingStartedAt: input.preprocessingStartedAt ?? existing.preprocessingStartedAt,
      preprocessingCompletedAt: input.preprocessingCompletedAt ?? existing.preprocessingCompletedAt,
      deletedAt: input.deletedAt ?? existing.deletedAt,
      updatedAt: new Date().toISOString()
    };
    this.conversationAttachments.set(updated.id, updated);
    return updated;
  }

  async deleteDraftAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    deletedAt: string;
  }): Promise<ConversationAttachment> {
    const existing = this.conversationAttachments.get(input.attachmentId);
    if (
      !existing ||
      existing.clientInstanceId !== input.clientInstanceId ||
      existing.conversationId !== input.conversationId ||
      existing.messageId !== undefined
    ) {
      throw new AppError("NOT_FOUND", "Draft attachment is not available");
    }
    const deleted: ConversationAttachment = {
      ...existing,
      status: "deleted",
      deletedAt: input.deletedAt,
      updatedAt: input.deletedAt
    };
    this.conversationAttachments.set(deleted.id, deleted);
    this.callbacks.touchConversation(input.conversationId, input.deletedAt);
    return deleted;
  }

  async claimReadyDraftAttachmentsForMessage(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    messageId: MessageId;
    claimedAt: string;
  }): Promise<ConversationAttachment[]> {
    const attachments = await this.listDraftAttachments(input);
    const claimed = attachments
      .filter((attachment) => attachment.status === "ready")
      .map((attachment): ConversationAttachment => ({
        ...attachment,
        messageId: input.messageId,
        updatedAt: input.claimedAt
      }));
    for (const attachment of claimed) {
      this.conversationAttachments.set(attachment.id, attachment);
    }
    return claimed;
  }

  async findReadableDocumentAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined> {
    return [...this.conversationAttachments.values()]
      .filter(
        (attachment) =>
          attachment.clientInstanceId === input.clientInstanceId &&
          attachment.conversationId === input.conversationId &&
          attachment.fileId === input.fileId &&
          attachment.status === "ready" &&
          Boolean(attachment.preparedObjectKey)
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  }

  deleteAttachmentsForConversation(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: string;
  }): void {
    for (const attachment of this.conversationAttachments.values()) {
      if (
        attachment.clientInstanceId === input.clientInstanceId &&
        attachment.conversationId === input.conversationId
      ) {
        this.conversationAttachments.set(attachment.id, {
          ...attachment,
          status: "deleted",
          deletedAt: input.deletedAt,
          updatedAt: input.deletedAt
        });
      }
    }
  }
}
