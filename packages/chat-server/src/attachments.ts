import type {
  AttachmentManifest,
  ConversationAttachment,
  ConversationId,
  DraftAttachment,
  ManagedFileId,
  ManagedObjectDeletionResult
} from "@vivd-catalyst/core";

export interface UploadDraftAttachmentInput {
  conversationId: ConversationId;
  ownerUserId: string;
  filename: string;
  mimeType?: string;
  content: UploadFileContent;
}

export interface UploadFileContent {
  byteSize: number;
  checksum: string;
  headerBytes: Uint8Array;
  openStream(): AsyncIterable<Uint8Array>;
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

export interface UploadDraftAttachmentResult {
  attachment: ConversationAttachment;
  outcome: "created" | "already_available";
}

export interface ChatAttachmentService {
  maxFileBytes: number;
  acceptedFileTypes: string[];
  listDraftAttachments(conversationId: ConversationId): Promise<DraftAttachment[]>;
  uploadDraftAttachment(input: UploadDraftAttachmentInput): Promise<UploadDraftAttachmentResult>;
  retryDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment>;
  deleteDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment>;
  deleteConversationAttachments(input: {
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult>;
  /**
   * Deletes the stored bytes of managed files that no Conversation refers to any more. Returns
   * the object keys that were removed; a key nobody stores is left out.
   */
  deleteOrphanedFileObjects?(input: { objectKeys: readonly string[] }): Promise<string[]>;
  /**
   * Transition release only: enqueues a job for each attachment that waits for preprocessing
   * and has no queued or running job, up to `limit`, and returns how many.
   */
  adoptLegacyAttachments?(input: { limit: number }): Promise<number>;
  readConversationFile(input: ReadConversationFileInput): Promise<ReadConversationFileResult>;
  blockingDraftAttachmentMessage(attachments: readonly DraftAttachment[]): string | undefined;
  createAttachmentManifest(attachments: readonly ConversationAttachment[]): AttachmentManifest;
  isInlineDisplayMimeType(mimeType: string): boolean;
}

export function createEmptyAttachmentManifest(): AttachmentManifest {
  return {
    version: 1,
    attachments: []
  };
}
