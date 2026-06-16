import {
  AppError,
  type AttachmentManifestEntry,
  type ClientInstanceId,
  type ConversationId,
  type DocumentAttachmentStore,
  type ManagedArtifactId,
  type ManagedFileId,
  asManagedFileId
} from "@vivd-catalyst/core";
import type { PreparedPdfPage, PreparedPdfPagesArtifact } from "./converter";
import type { ObjectStore } from "./object-store";
import { toPreparedDocumentMetadata } from "./attachment-manifest";

export type ReadDocumentInput = {
  conversationId: ConversationId;
  fileId: string;
} & (
  | {
      mode: "full";
    }
  | {
      mode: "pages";
      pages: {
        from: number;
        to: number;
      };
    }
);

export type ReadDocumentResult =
  | {
      fileId: ManagedFileId;
      mode: "full";
      artifactId: ManagedArtifactId;
      text: string;
      metadata: AttachmentManifestEntry["metadata"];
    }
  | {
      fileId: ManagedFileId;
      mode: "pages";
      artifactId: ManagedArtifactId;
      pages: PreparedPdfPage[];
      text: string;
      metadata: AttachmentManifestEntry["metadata"];
    };

export interface DocumentReader {
  readDocument(input: ReadDocumentInput): Promise<ReadDocumentResult>;
}

export interface DocumentReadServiceOptions {
  clientInstanceId: ClientInstanceId;
  store: DocumentAttachmentStore;
  objectStore: ObjectStore;
  preprocessingVersion: string;
}

export class DocumentReadService implements DocumentReader {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly store: DocumentAttachmentStore;
  private readonly objectStore: ObjectStore;
  private readonly preprocessingVersion: string;

  constructor(options: DocumentReadServiceOptions) {
    this.clientInstanceId = options.clientInstanceId;
    this.store = options.store;
    this.objectStore = options.objectStore;
    this.preprocessingVersion = options.preprocessingVersion;
  }

  async readDocument(input: ReadDocumentInput): Promise<ReadDocumentResult> {
    const attachment = await this.store.findReadableDocumentAttachment({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: asManagedFileId(input.fileId)
    });
    if (!attachment?.preparedTextArtifactId) {
      throw new AppError("NOT_FOUND", "Prepared document text is not available in this conversation");
    }

    if (input.mode === "pages") {
      if (!attachment.preparedPagesArtifactId) {
        throw new AppError("VALIDATION_FAILED", "Page text is not available for this document");
      }
      const artifact = await this.store.getManagedArtifact({
        clientInstanceId: this.clientInstanceId,
        artifactId: attachment.preparedPagesArtifactId
      });
      if (!artifact) {
        throw new AppError("NOT_FOUND", "Prepared page text artifact is not available");
      }
      const bytes = await this.objectStore.getObject(artifact.objectKey);
      const pagesArtifact = parsePreparedPdfPages(new TextDecoder("utf-8", { fatal: false }).decode(bytes));
      const from = Math.max(1, input.pages.from);
      const to = Math.min(input.pages.to, pagesArtifact.pageCount);
      if (from > to) {
        throw new AppError("VALIDATION_FAILED", "Requested page range is outside the document");
      }
      const pages = pagesArtifact.pages.filter((page) => page.pageNumber >= from && page.pageNumber <= to);
      return {
        fileId: attachment.fileId,
        mode: "pages",
        artifactId: artifact.id,
        pages,
        text: pages.map((page) => `[Page ${page.pageNumber}]\n${page.text}`).join("\n\n"),
        metadata: toPreparedDocumentMetadata(attachment, this.preprocessingVersion)
      };
    }

    const artifact = await this.store.getManagedArtifact({
      clientInstanceId: this.clientInstanceId,
      artifactId: attachment.preparedTextArtifactId
    });
    if (!artifact) {
      throw new AppError("NOT_FOUND", "Prepared document text artifact is not available");
    }
    const bytes = await this.objectStore.getObject(artifact.objectKey);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      fileId: attachment.fileId,
      mode: "full",
      artifactId: artifact.id,
      text,
      metadata: toPreparedDocumentMetadata(attachment, this.preprocessingVersion)
    };
  }
}

function parsePreparedPdfPages(json: string): PreparedPdfPagesArtifact {
  const parsed = JSON.parse(json) as PreparedPdfPagesArtifact;
  if (parsed.format !== "pdf" || !Array.isArray(parsed.pages)) {
    throw new AppError("INTERNAL", "Prepared page text artifact is invalid");
  }
  return parsed;
}
