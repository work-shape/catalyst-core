import {
  AppError,
  type AttachmentManifestEntry,
  type ClientInstanceId,
  type ConversationId,
  type DocumentAttachmentStore,
  type ManagedFileId,
  type PreparedDocumentId,
  asManagedFileId
} from "@vivd-catalyst/core";
import type { ObjectStore } from "./object-store";
import { toPreparedDocumentMetadata } from "./attachment-manifest";

export interface ReadDocumentInput {
  conversationId: ConversationId;
  fileId: string;
}

export interface ReadDocumentResult {
  fileId: ManagedFileId;
  preparedDocumentId: PreparedDocumentId;
  text: string;
  metadata: AttachmentManifestEntry["metadata"];
}

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
    if (!attachment?.preparedObjectKey || !attachment.preparedDocumentId) {
      throw new AppError("NOT_FOUND", "Prepared document text is not available in this conversation");
    }
    const bytes = await this.objectStore.getObject(attachment.preparedObjectKey);
    const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    return {
      fileId: attachment.fileId,
      preparedDocumentId: attachment.preparedDocumentId,
      text,
      metadata: toPreparedDocumentMetadata(attachment, this.preprocessingVersion)
    };
  }
}
