import {
  type ClientInstanceId,
  type ConversationId,
  type DocumentAttachmentWarning,
  type DocumentFileFormat,
  type DocumentAttachmentStore,
  type JsonObject,
  type ManagedArtifactKind,
  type ManagedArtifactRecord,
  type ManagedFileId
} from "@vivd-catalyst/core";
import type { ConvertDocumentOutput, PreparedPdfPagesArtifact } from "./converter";
import { createArtifactObjectKey, createChecksum } from "./object-keys";
import type { ObjectStore } from "./object-store";
import { boundPreparedText, countWords } from "./prepared-text";

export interface PreparedDocumentArtifactPipelineOptions {
  clientInstanceId: ClientInstanceId;
  store: DocumentAttachmentStore;
  objectStore: ObjectStore;
  maxExtractedTextBytes: number;
  preprocessingVersion: string;
}

export interface WritePreparedDocumentArtifactsInput {
  conversationId: ConversationId;
  sourceFileId: ManagedFileId;
  filename: string;
  format: DocumentFileFormat;
  converted: ConvertDocumentOutput;
}

export interface PreparedDocumentArtifacts {
  preparedTextArtifact: ManagedArtifactRecord;
  preparedPagesArtifact?: ManagedArtifactRecord;
  characterCount: number;
  wordCount: number;
  pageCount?: number;
  warnings: DocumentAttachmentWarning[];
}

export class PreparedDocumentArtifactPipeline {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: DocumentAttachmentStore;
  private readonly objectStore: ObjectStore;
  private readonly maxExtractedTextBytes: number;
  private readonly preprocessingVersion: string;

  constructor(options: PreparedDocumentArtifactPipelineOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.maxExtractedTextBytes = options.maxExtractedTextBytes;
    this.preprocessingVersion = options.preprocessingVersion;
  }

  async writePreparedDocumentArtifacts(
    input: WritePreparedDocumentArtifactsInput
  ): Promise<PreparedDocumentArtifacts> {
    const bounded = boundPreparedText(input.converted.text, this.maxExtractedTextBytes);
    const warnings: DocumentAttachmentWarning[] = [
      ...input.converted.warnings,
      ...bounded.warnings
    ];
    if (bounded.text.trim().length === 0) {
      warnings.push({
        code: "no_extractable_text",
        message: "The document was processed, but no extractable text was found."
      });
    }
    if (input.format === "pdf" && input.converted.pageCount === undefined) {
      warnings.push({
        code: "page_count_unavailable",
        message: "Page count is not available from the PDF preprocessing converter."
      });
    }

    const preparedTextArtifact = await this.createArtifact({
      conversationId: input.conversationId,
      sourceFileId: input.sourceFileId,
      kind: "document.prepared_text",
      extension: input.converted.textMimeType === "text/markdown" ? "md" : "txt",
      filename: `${input.filename}.prepared.${input.converted.textMimeType === "text/markdown" ? "md" : "txt"}`,
      mimeType: `${input.converted.textMimeType}; charset=utf-8`,
      bytes: new TextEncoder().encode(bounded.text),
      metadata: {
        format: input.format,
        engine: input.converted.engine,
        preprocessingVersion: this.preprocessingVersion
      }
    });
    const preparedPagesArtifact = input.converted.pages
      ? await this.createPagesArtifact({
          conversationId: input.conversationId,
          sourceFileId: input.sourceFileId,
          filename: input.filename,
          pages: input.converted.pages,
          engine: input.converted.engine
        })
      : undefined;

    return {
      preparedTextArtifact,
      preparedPagesArtifact,
      characterCount: bounded.text.length,
      wordCount: countWords(bounded.text),
      pageCount: input.converted.pageCount,
      warnings
    };
  }

  private async createPagesArtifact(input: {
    conversationId: ConversationId;
    sourceFileId: ManagedFileId;
    filename: string;
    pages: PreparedPdfPagesArtifact;
    engine: string;
  }): Promise<ManagedArtifactRecord> {
    return this.createArtifact({
      conversationId: input.conversationId,
      sourceFileId: input.sourceFileId,
      kind: "document.pages_json",
      extension: "json",
      filename: `${input.filename}.pages.json`,
      mimeType: "application/json",
      bytes: new TextEncoder().encode(JSON.stringify(input.pages)),
      metadata: {
        format: "pdf",
        pageCount: input.pages.pageCount,
        engine: input.engine,
        preprocessingVersion: this.preprocessingVersion
      }
    });
  }

  private async createArtifact(input: {
    conversationId: ConversationId;
    sourceFileId: ManagedFileId;
    kind: ManagedArtifactKind;
    extension: string;
    filename: string;
    mimeType: string;
    bytes: Uint8Array;
    metadata: JsonObject;
  }): Promise<ManagedArtifactRecord> {
    const objectKey = createArtifactObjectKey({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      kind: input.kind,
      extension: input.extension
    });
    await this.objectStore.putObject({
      key: objectKey,
      body: input.bytes,
      contentType: input.mimeType
    });
    return this.store.createManagedArtifact({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      sourceFileId: input.sourceFileId,
      kind: input.kind,
      objectKey,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum: createChecksum(input.bytes),
      metadata: input.metadata
    });
  }
}
