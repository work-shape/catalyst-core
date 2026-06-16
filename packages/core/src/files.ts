import type {
  ClientInstanceId,
  ConversationAttachmentId,
  ConversationId,
  ManagedArtifactId,
  ManagedFileId,
  MessageId
} from "./ids";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

export interface ManagedFileRef {
  fileId: string;
  mimeType?: string;
  filename?: string;
  checksum?: string;
}

export type ManagedArtifactKind =
  | "document.prepared_text"
  | "document.pages_json"
  | "document.page_image";

export interface ModelVisibleArtifactHint {
  type: "image";
  mimeType: "image/png";
}

export interface ManagedArtifactRef {
  artifactId: ManagedArtifactId;
  kind: ManagedArtifactKind;
  filename?: string;
  mimeType?: string;
  modelVisibility?: ModelVisibleArtifactHint;
  metadata?: JsonObject;
}

export type ToolDisplayMode = "inline" | "side_panel" | "fullscreen";

export type ToolDisplayOutput = JsonObject & {
  kind: string;
  version: number;
  mode?: ToolDisplayMode;
  displayId?: string;
  data?: JsonObject;
};

export interface AuditSafeSummary {
  action: string;
  subject?: string;
  metadata?: JsonObject;
}

export type ManagedFileStatus = "available" | "deleted";
export type ManagedArtifactStatus = "available" | "deleted";

export type DocumentFileFormat = "pdf" | "docx" | "txt" | "md";

export type ConversationAttachmentStatus =
  | "queued"
  | "preprocessing"
  | "ready"
  | "failed"
  | "unsupported"
  | "deleted";

export type DocumentAttachmentWarningCode =
  | "no_extractable_text"
  | "text_truncated"
  | "page_count_unavailable"
  | "page_text_unavailable"
  | "page_image_rendered";

export interface DocumentAttachmentWarning {
  code: DocumentAttachmentWarningCode;
  message: string;
}

export interface ManagedFileRecord {
  id: ManagedFileId;
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  filename: string;
  mimeType?: string;
  byteSize: number;
  checksum: string;
  objectKey: string;
  status: ManagedFileStatus;
  createdAt: ISODateString;
  deletedAt?: ISODateString;
}

export interface ManagedArtifactRecord {
  id: ManagedArtifactId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  sourceFileId?: ManagedFileId;
  kind: ManagedArtifactKind;
  objectKey: string;
  filename?: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  metadata: JsonObject;
  status: ManagedArtifactStatus;
  createdAt: ISODateString;
  deletedAt?: ISODateString;
}

export interface PreparedDocumentMetadata {
  fileId: ManagedFileId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  format?: DocumentFileFormat;
  characterCount?: number;
  wordCount?: number;
  pageCount?: number;
  preparedTextArtifactId?: ManagedArtifactId;
  preparedPagesArtifactId?: ManagedArtifactId;
  warnings: DocumentAttachmentWarning[];
  preprocessingVersion?: string;
  preprocessingEngine?: string;
}

export interface ConversationAttachment {
  id: ConversationAttachmentId;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  messageId?: MessageId;
  fileId: ManagedFileId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  checksum: string;
  status: ConversationAttachmentStatus;
  format?: DocumentFileFormat;
  preparedTextArtifactId?: ManagedArtifactId | null;
  preparedPagesArtifactId?: ManagedArtifactId | null;
  preprocessingEngine?: string;
  characterCount?: number;
  wordCount?: number;
  pageCount?: number;
  warnings: DocumentAttachmentWarning[];
  error?: JsonObject | null;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  preprocessingStartedAt?: ISODateString;
  preprocessingCompletedAt?: ISODateString;
  deletedAt?: ISODateString;
}

export type DraftAttachment = ConversationAttachment & {
  messageId?: undefined;
};

export interface AttachmentManifestEntry {
  fileId: ManagedFileId;
  attachmentId: ConversationAttachmentId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  status: "ready";
  readable: true;
  readToolName: "read_document";
  metadata: PreparedDocumentMetadata;
}

export interface AttachmentManifest {
  version: 1;
  attachments: AttachmentManifestEntry[];
}

export interface CreateManagedFileInput {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  filename: string;
  mimeType?: string;
  byteSize: number;
  checksum: string;
  objectKey: string;
}

export interface CreateConversationAttachmentInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  fileId: ManagedFileId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  checksum: string;
  status: Exclude<ConversationAttachmentStatus, "preprocessing" | "ready" | "deleted">;
  format?: DocumentFileFormat;
  warnings?: DocumentAttachmentWarning[];
  error?: JsonObject;
}

export interface UpdateConversationAttachmentInput {
  clientInstanceId: ClientInstanceId;
  attachmentId: ConversationAttachmentId;
  status?: ConversationAttachmentStatus;
  format?: DocumentFileFormat;
  preparedTextArtifactId?: ManagedArtifactId | null;
  preparedPagesArtifactId?: ManagedArtifactId | null;
  preprocessingEngine?: string;
  characterCount?: number;
  wordCount?: number;
  pageCount?: number;
  warnings?: DocumentAttachmentWarning[];
  error?: JsonObject | null;
  preprocessingStartedAt?: ISODateString;
  preprocessingCompletedAt?: ISODateString;
  deletedAt?: ISODateString;
}

export interface CreateManagedArtifactInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  sourceFileId?: ManagedFileId;
  kind: ManagedArtifactKind;
  objectKey: string;
  filename?: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  metadata?: JsonObject;
}

export interface DocumentAttachmentStore {
  createManagedFile(input: CreateManagedFileInput): Promise<ManagedFileRecord>;
  getManagedFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<ManagedFileRecord | undefined>;
  createManagedArtifact(input: CreateManagedArtifactInput): Promise<ManagedArtifactRecord>;
  getManagedArtifact(input: {
    clientInstanceId: ClientInstanceId;
    artifactId: ManagedArtifactId;
  }): Promise<ManagedArtifactRecord | undefined>;
  listManagedArtifactsForFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
    kind?: ManagedArtifactKind;
  }): Promise<ManagedArtifactRecord[]>;
  createConversationAttachment(
    input: CreateConversationAttachmentInput
  ): Promise<ConversationAttachment>;
  getConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
  }): Promise<ConversationAttachment | undefined>;
  listDraftAttachments(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<DraftAttachment[]>;
  updateConversationAttachment(
    input: UpdateConversationAttachmentInput
  ): Promise<ConversationAttachment>;
  deleteDraftAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    deletedAt: ISODateString;
  }): Promise<ConversationAttachment>;
  claimReadyDraftAttachmentsForMessage(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    messageId: MessageId;
    claimedAt: ISODateString;
  }): Promise<ConversationAttachment[]>;
  findReadableDocumentAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined>;
}
