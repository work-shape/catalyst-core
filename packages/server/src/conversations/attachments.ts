import type {
  AttachmentManifest,
  ConversationAttachment,
  ConversationId,
  DraftAttachment,
  ManagedFileId,
  LocaleCode,
  ManagedObjectDeletionResult
} from "@work-shape/catalyst-core";
import { ATTACHMENT_CREATE_OUTCOMES } from "@work-shape/catalyst-core";

export interface UploadDraftAttachmentInput {
  /** Set by the server after checking the selected agent in this workspace. */
  workspaceToolsAvailable?: boolean;
  locale?: LocaleCode;
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
  outcome: (typeof ATTACHMENT_CREATE_OUTCOMES)[number];
}

/** The text a handler prepared of a conversation's file, such as a PDF's extracted text. */
interface PreparedFileText {
  text: string;
  /** The handler cut the text short at its own limit: what lies beyond was not prepared. */
  truncated: boolean;
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
  /**
   * The text an attachment handler prepared of a file, such as a PDF's extracted text, for the
   * guardrails on chat input. Undefined where no handler prepared text of it.
   */
  readPreparedText?(input: ReadConversationFileInput): Promise<PreparedFileText | undefined>;
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
