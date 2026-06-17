import {
  AppError,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationId,
  type DocumentAttachmentStore,
  type FileAttachmentFormat,
  type ManagedFileId,
  type DocumentPreprocessingConfig,
  type DraftAttachment,
  asManagedFileId,
  asConversationAttachmentId
} from "@vivd-catalyst/core";
import { createChecksum, createObjectKey } from "./object-keys";
import {
  DocumentReadService,
  type ReadDocumentInput,
  type ReadDocumentResult
} from "./document-read-service";
import {
  detectAttachmentFormat,
  extensionFromFilename,
  imageMimeTypeForFormat,
  isDocumentFileFormat,
  isImageFileFormat,
  unsupportedDocumentUploadReason,
  unsupportedImageUploadReason
} from "./document-format";
import type { ObjectStore } from "./object-store";

export interface DocumentPreprocessingServiceOptions {
  clientInstanceId: ClientInstanceId;
  store: DocumentAttachmentStore;
  objectStore: ObjectStore;
  config: DocumentPreprocessingConfig;
}

export interface UploadDraftAttachmentInput {
  conversationId: ConversationId;
  ownerUserId: string;
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
}

export interface ReadConversationFileInput {
  conversationId: ConversationId;
  fileId: string;
}

export interface ReadConversationFileResult {
  fileId: ManagedFileId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  bytes: Uint8Array;
}

export class DocumentPreprocessingService {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: DocumentAttachmentStore;
  private readonly objectStore: ObjectStore;
  private readonly config: DocumentPreprocessingConfig;
  private readonly reader: DocumentReadService;

  constructor(options: DocumentPreprocessingServiceOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.config = options.config;
    this.reader = new DocumentReadService({
      clientInstanceId: options.clientInstanceId,
      store: options.store,
      objectStore: options.objectStore,
      preprocessingVersion: options.config.preprocessingVersion
    });
  }

  async uploadDraftAttachment(input: UploadDraftAttachmentInput): Promise<DraftAttachment> {
    if (!this.config.enabled) {
      throw new AppError("VALIDATION_FAILED", "Document preprocessing is disabled");
    }
    if (input.bytes.byteLength > this.config.maxFileBytes) {
      throw new AppError("VALIDATION_FAILED", "File exceeds the configured document upload size limit");
    }

    const checksum = createChecksum(input.bytes);
    const format = detectAttachmentFormat(input.filename, input.mimeType);
    const normalizedMimeType = isImageFileFormat(format)
      ? imageMimeTypeForFormat(format)
      : input.mimeType;
    const objectKey = createObjectKey({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      segment: "original",
      extension: extensionFromFilename(input.filename) ?? "bin"
    });
    await this.objectStore.putObject({
      key: objectKey,
      body: input.bytes,
      contentType: normalizedMimeType
    });
    const file = await this.store.createManagedFile({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mimeType: normalizedMimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      objectKey
    });

    const unsupportedReason = this.unsupportedReason({
      filename: input.filename,
      format,
      bytes: input.bytes
    });
    const attachment = await this.store.createConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: file.id,
      filename: input.filename,
      mimeType: normalizedMimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      status: unsupportedReason ? "unsupported" : isImageFileFormat(format) ? "ready" : "queued",
      format: format ?? undefined,
      warnings: [],
      error: unsupportedReason
        ? {
            code: "unsupported_document_format",
            message: unsupportedReason
          }
        : undefined
    });

    return attachment as DraftAttachment;
  }

  async listDraftAttachments(conversationId: ConversationId): Promise<DraftAttachment[]> {
    return this.store.listDraftAttachments({
      clientInstanceId: this.clientInstanceId,
      conversationId
    });
  }

  async deleteDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment> {
    return this.store.deleteDraftAttachment({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      attachmentId: asConversationAttachmentId(input.attachmentId),
      deletedAt: new Date().toISOString()
    });
  }

  async retryDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment> {
    const attachment = await this.store.getConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      attachmentId: asConversationAttachmentId(input.attachmentId)
    });
    if (!attachment || attachment.conversationId !== input.conversationId) {
      throw new AppError("NOT_FOUND", "Draft attachment is not available");
    }
    if (attachment.messageId !== undefined) {
      throw new AppError("CONFLICT", "Sent attachments cannot be retried");
    }
    if (attachment.status !== "failed") {
      throw new AppError("CONFLICT", "Only failed draft attachments can be retried");
    }
    const updated = await this.store.updateConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      attachmentId: attachment.id,
      status: "queued",
      warnings: [],
      error: null,
      processingOwnerId: null,
      processingLeaseToken: null,
      processingLeaseExpiresAt: null,
      preprocessingStartedAt: null,
      preprocessingCompletedAt: null
    });
    return updated;
  }

  async readDocument(input: ReadDocumentInput): Promise<ReadDocumentResult> {
    return this.reader.readDocument(input);
  }

  async readConversationFile(input: ReadConversationFileInput): Promise<ReadConversationFileResult> {
    const attachment = await this.store.findConversationAttachmentByFile({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: asManagedFileId(input.fileId)
    });
    if (!attachment || attachment.status !== "ready") {
      throw new AppError("NOT_FOUND", "Managed attachment file is not available in this conversation");
    }
    const file = await this.store.getManagedFile({
      clientInstanceId: this.clientInstanceId,
      fileId: attachment.fileId
    });
    if (!file) {
      throw new AppError("NOT_FOUND", "Managed file is not available");
    }
    return {
      fileId: file.id,
      filename: attachment.filename,
      mimeType: attachment.mimeType ?? file.mimeType,
      byteSize: attachment.byteSize,
      bytes: await this.objectStore.getObject(file.objectKey)
    };
  }

  private unsupportedReason(input: {
    filename: string;
    format: FileAttachmentFormat | undefined;
    bytes: Uint8Array;
  }): string | undefined {
    if (isImageFileFormat(input.format)) {
      return unsupportedImageUploadReason({
        format: input.format,
        bytes: input.bytes
      });
    }
    const uploadReason = unsupportedDocumentUploadReason(input);
    if (uploadReason) {
      return uploadReason;
    }
    if (!input.format) {
      return "The file type is not supported for document text extraction.";
    }
    if (!isDocumentFileFormat(input.format)) {
      return "The file type is not supported.";
    }
    if (!this.config.supportedFormats.includes(input.format)) {
      return `The '${input.format}' file type is disabled for this client instance.`;
    }
    return undefined;
  }
}
