import type {
  AttachmentManifest,
  ConversationAttachment,
  ConversationId,
  DraftAttachment,
  ManagedFileId
} from "@vivd-catalyst/core";

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

export interface ChatAttachmentService {
  maxFileBytes: number;
  listDraftAttachments(conversationId: ConversationId): Promise<DraftAttachment[]>;
  uploadDraftAttachment(input: UploadDraftAttachmentInput): Promise<DraftAttachment>;
  retryDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment>;
  deleteDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment>;
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
