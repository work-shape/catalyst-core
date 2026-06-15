import {
  AppError,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationAttachmentId,
  type ConversationId,
  type DocumentAttachmentStore,
  type DocumentAttachmentWarning,
  type DocumentFileFormat,
  type DocumentPreprocessingConfig,
  type DraftAttachment,
  asConversationAttachmentId,
  createPlatformId
} from "@vivd-catalyst/core";
import { createChecksum, createObjectKey } from "./object-keys";
import { AsyncLimiter } from "./concurrency";
import type { DocumentTextConverter } from "./converter";
import {
  DocumentReadService,
  type ReadDocumentInput,
  type ReadDocumentResult
} from "./document-read-service";
import { detectDocumentFormat, extensionFromFilename } from "./document-format";
import type { ObjectStore } from "./object-store";
import { boundPreparedText, countWords } from "./prepared-text";

export interface DocumentPreprocessingServiceOptions {
  clientInstanceId: ClientInstanceId;
  store: DocumentAttachmentStore;
  objectStore: ObjectStore;
  converter: DocumentTextConverter;
  config: DocumentPreprocessingConfig;
}

export interface UploadDraftAttachmentInput {
  conversationId: ConversationId;
  ownerUserId: string;
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
}

export class DocumentPreprocessingService {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: DocumentAttachmentStore;
  private readonly objectStore: ObjectStore;
  private readonly converter: DocumentTextConverter;
  private readonly config: DocumentPreprocessingConfig;
  private readonly reader: DocumentReadService;
  private readonly globalLimiter: AsyncLimiter;
  private readonly conversationLimiters = new Map<string, AsyncLimiter>();

  constructor(options: DocumentPreprocessingServiceOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.converter = options.converter;
    this.config = options.config;
    this.reader = new DocumentReadService({
      clientInstanceId: options.clientInstanceId,
      store: options.store,
      objectStore: options.objectStore,
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
    const format = detectDocumentFormat(input.filename, input.mimeType);
    const objectKey = createObjectKey({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      segment: "original",
      extension: extensionFromFilename(input.filename) ?? "bin"
    });
    await this.objectStore.putObject({
      key: objectKey,
      body: input.bytes,
      contentType: input.mimeType
    });
    const file = await this.store.createManagedFile({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      objectKey
    });

    const unsupportedReason = this.unsupportedReason(format);
    const attachment = await this.store.createConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: file.id,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      status: unsupportedReason ? "unsupported" : "queued",
      format: format ?? undefined,
      warnings: [],
      error: unsupportedReason
        ? {
            code: "unsupported_document_format",
            message: unsupportedReason
          }
        : undefined
    });

    if (!unsupportedReason) {
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
      const file = await this.store.getManagedFile({
        clientInstanceId: this.clientInstanceId,
        fileId: attachment.fileId
      });
      if (!file) {
        throw new AppError("NOT_FOUND", "Managed file is not available");
      }
      const originalBytes = await this.objectStore.getObject(file.objectKey);
      const converted = await this.converter.convert({
        bytes: originalBytes,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        format: attachment.format
      });
      const bounded = boundPreparedText(converted.text, this.config.maxExtractedTextBytes);
      const warnings: DocumentAttachmentWarning[] = [...bounded.warnings];
      if (bounded.text.trim().length === 0) {
        warnings.push({
          code: "no_extractable_text",
          message: "The document was processed, but no extractable text was found."
        });
      }
      if (attachment.format === "pdf") {
        warnings.push({
          code: "page_count_unavailable",
          message: "Page count is not available from the v1 preprocessing converter."
        });
      }
      const preparedDocumentId = createPlatformId<"PreparedDocumentId">("doc");
      const preparedObjectKey = createObjectKey({
        clientInstanceId: this.clientInstanceId,
        conversationId: attachment.conversationId,
        segment: "prepared-text",
        extension: "txt"
      });
      await this.objectStore.putObject({
        key: preparedObjectKey,
        body: new TextEncoder().encode(bounded.text),
        contentType: "text/plain; charset=utf-8"
      });

      await this.store.updateConversationAttachment({
        clientInstanceId: this.clientInstanceId,
        attachmentId,
        status: "ready",
        preparedDocumentId,
        preparedObjectKey,
        characterCount: bounded.text.length,
        wordCount: countWords(bounded.text),
        warnings,
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

  private unsupportedReason(format: DocumentFileFormat | undefined): string | undefined {
    if (!format) {
      return "The file type is not supported for document text extraction.";
    }
    if (!this.config.supportedFormats.includes(format)) {
      return `The '${format}' file type is disabled for this client instance.`;
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
