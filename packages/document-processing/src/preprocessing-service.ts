import {
  AppError,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationAttachmentId,
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
import { AsyncLimiter } from "./concurrency";
import type { DocumentPreprocessor } from "./converter";
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
import { PreparedDocumentArtifactPipeline } from "./prepared-document-artifacts";

export interface DocumentPreprocessingServiceOptions {
  clientInstanceId: ClientInstanceId;
  store: DocumentAttachmentStore;
  objectStore: ObjectStore;
  preprocessor: DocumentPreprocessor;
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
  private readonly preprocessor: DocumentPreprocessor;
  private readonly config: DocumentPreprocessingConfig;
  private readonly reader: DocumentReadService;
  private readonly artifactPipeline: PreparedDocumentArtifactPipeline;
  private readonly globalLimiter: AsyncLimiter;
  private readonly conversationLimiters = new Map<string, AsyncLimiter>();

  constructor(options: DocumentPreprocessingServiceOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.preprocessor = options.preprocessor;
    this.config = options.config;
    this.reader = new DocumentReadService({
      clientInstanceId: options.clientInstanceId,
      store: options.store,
      objectStore: options.objectStore,
      preprocessingVersion: options.config.preprocessingVersion
    });
    this.artifactPipeline = new PreparedDocumentArtifactPipeline({
      clientInstanceId: options.clientInstanceId,
      store: options.store,
      objectStore: options.objectStore,
      maxExtractedTextBytes: options.config.maxExtractedTextBytes,
      preprocessingVersion: options.config.preprocessingVersion
    });
    this.globalLimiter = new AsyncLimiter(options.config.globalConcurrency);
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

    if (!unsupportedReason && !isImageFileFormat(format)) {
      this.schedulePreprocessing(attachment);
    }
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
      error: null
    });
    this.schedulePreprocessing(updated);
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

  private schedulePreprocessing(
    attachment: Pick<ConversationAttachment, "id" | "conversationId">
  ): void {
    void this.globalLimiter
      .run(() =>
        this.conversationLimiterForConversation(attachment.conversationId).run(() =>
          this.preprocessAttachment(attachment.id)
        )
      )
      .catch((error) => {
        console.warn(
          JSON.stringify({
            type: "document_preprocessing.unhandled_failure",
            attachmentId: attachment.id,
            message: error instanceof Error ? error.message : "Unknown preprocessing failure"
          })
        );
      });
  }

  private conversationLimiterForConversation(conversationId: ConversationId): AsyncLimiter {
    const key = conversationId;
    const existing = this.conversationLimiters.get(key);
    if (existing) {
      return existing;
    }
    const limiter = new AsyncLimiter(this.config.perConversationConcurrency);
    this.conversationLimiters.set(key, limiter);
    return limiter;
  }

  private async preprocessAttachment(attachmentId: ConversationAttachmentId): Promise<void> {
    const attachment = await this.store.getConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      attachmentId
    });
    if (!attachment || attachment.status !== "queued") {
      return;
    }
    const startedAt = new Date().toISOString();
    await this.store.updateConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      attachmentId,
      status: "preprocessing",
      preprocessingStartedAt: startedAt,
      error: null
    });

    try {
      if (!attachment.format) {
        throw new AppError("VALIDATION_FAILED", "Document format is not supported");
      }
      if (!isDocumentFileFormat(attachment.format)) {
        throw new AppError("VALIDATION_FAILED", "Attachment is not a preprocessable document");
      }
      const file = await this.store.getManagedFile({
        clientInstanceId: this.clientInstanceId,
        fileId: attachment.fileId
      });
      if (!file) {
        throw new AppError("NOT_FOUND", "Managed file is not available");
      }
      const originalBytes = await this.objectStore.getObject(file.objectKey);
      const converted = await this.preprocessor.convert({
        bytes: originalBytes,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        format: attachment.format
      });
      const prepared = await this.artifactPipeline.writePreparedDocumentArtifacts({
        conversationId: attachment.conversationId,
        sourceFileId: attachment.fileId,
        filename: attachment.filename,
        format: attachment.format,
        converted
      });

      await this.store.updateConversationAttachment({
        clientInstanceId: this.clientInstanceId,
        attachmentId,
        status: "ready",
        preparedTextArtifactId: prepared.preparedTextArtifact.id,
        preparedPagesArtifactId: prepared.preparedPagesArtifact?.id ?? null,
        preprocessingEngine: converted.engine,
        characterCount: prepared.characterCount,
        wordCount: prepared.wordCount,
        pageCount: prepared.pageCount,
        warnings: prepared.warnings,
        preprocessingCompletedAt: new Date().toISOString(),
        error: null
      });
    } catch (error) {
      await this.store.updateConversationAttachment({
        clientInstanceId: this.clientInstanceId,
        attachmentId,
        status: "failed",
        error: toAttachmentError(error),
        preprocessingCompletedAt: new Date().toISOString()
      });
    }
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

function toAttachmentError(error: unknown) {
  if (error instanceof AppError) {
    return {
      code: error.code,
      message: error.message
    };
  }
  return {
    code: "preprocessing_failed",
    message: error instanceof Error ? error.message : "Document preprocessing failed"
  };
}
