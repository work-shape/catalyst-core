import {
  AppError,
  type ClientInstanceId,
  type ConversationAttachment,
  type DocumentAttachmentStore,
  type DocumentPreprocessingConfig,
  createPlatformId
} from "@vivd-catalyst/core";
import type { DocumentPreprocessor } from "./converter";
import { isDocumentFileFormat } from "./document-format";
import type { ObjectStore } from "./object-store";
import {
  PreparedDocumentArtifactPipeline,
  type PreparedDocumentArtifacts
} from "./prepared-document-artifacts";

export interface DocumentAttachmentProcessorOptions {
  clientInstanceId: ClientInstanceId;
  store: DocumentAttachmentStore;
  objectStore: ObjectStore;
  preprocessor: DocumentPreprocessor;
  config: DocumentPreprocessingConfig;
  leaseDurationMs?: number;
}

export interface ProcessNextDocumentAttachmentInput {
  workerId: string;
}

export type ProcessNextDocumentAttachmentResult =
  | {
      status: "idle";
    }
  | {
      status: "processed";
      attachment: ConversationAttachment;
    };

export class DocumentAttachmentProcessor {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: DocumentAttachmentStore;
  private readonly objectStore: ObjectStore;
  private readonly preprocessor: DocumentPreprocessor;
  private readonly config: DocumentPreprocessingConfig;
  private readonly artifactPipeline: PreparedDocumentArtifactPipeline;
  private readonly leaseDurationMs: number;

  constructor(options: DocumentAttachmentProcessorOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.preprocessor = options.preprocessor;
    this.config = options.config;
    this.leaseDurationMs = options.leaseDurationMs ?? Math.max(options.config.timeoutMs * 2, 60_000);
    this.artifactPipeline = new PreparedDocumentArtifactPipeline({
      clientInstanceId: options.clientInstanceId,
      store: options.store,
      objectStore: options.objectStore,
      maxExtractedTextBytes: options.config.maxExtractedTextBytes,
      preprocessingVersion: options.config.preprocessingVersion
    });
  }

  async processNext(
    input: ProcessNextDocumentAttachmentInput
  ): Promise<ProcessNextDocumentAttachmentResult> {
    const now = new Date();
    const leaseToken = createPlatformId("lease");
    const attachment = await this.store.claimNextQueuedDocumentAttachment({
      clientInstanceId: this.clientInstanceId,
      workerId: input.workerId,
      leaseToken,
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.leaseDurationMs).toISOString(),
      perConversationLimit: this.config.perConversationConcurrency,
      globalLimit: this.config.globalConcurrency
    });
    if (!attachment) {
      return { status: "idle" };
    }
    return {
      status: "processed",
      attachment: await this.processClaimedAttachment({
        attachment,
        leaseToken
      })
    };
  }

  async processClaimedAttachment(input: {
    attachment: ConversationAttachment;
    leaseToken: string;
  }): Promise<ConversationAttachment> {
    let prepared: PreparedDocumentArtifacts & {
      preprocessingEngine: string;
    };
    try {
      prepared = await this.prepareAttachment(input.attachment);
    } catch (error) {
      return this.store.failClaimedDocumentAttachment({
        clientInstanceId: this.clientInstanceId,
        attachmentId: input.attachment.id,
        leaseToken: input.leaseToken,
        error: toAttachmentError(error),
        completedAt: new Date().toISOString()
      });
    }
    return this.store.completeClaimedDocumentAttachment({
      clientInstanceId: this.clientInstanceId,
      attachmentId: input.attachment.id,
      leaseToken: input.leaseToken,
      preparedTextArtifactId: prepared.preparedTextArtifact.id,
      preparedPagesArtifactId: prepared.preparedPagesArtifact?.id ?? null,
      preprocessingEngine: prepared.preprocessingEngine,
      characterCount: prepared.characterCount,
      wordCount: prepared.wordCount,
      pageCount: prepared.pageCount,
      warnings: prepared.warnings,
      completedAt: new Date().toISOString()
    });
  }

  private async prepareAttachment(attachment: ConversationAttachment) {
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
    return {
      ...prepared,
      preprocessingEngine: converted.engine
    };
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
