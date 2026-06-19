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

export type ManagedArtifactKind = string;

export type SupportedImageMimeType =
  | "image/png"
  | "image/jpeg"
  | "image/webp"
  | "image/gif";

export interface ModelVisibleArtifactHint {
  type: "image";
  mimeType: SupportedImageMimeType;
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

export type ImageFileFormat = "png" | "jpeg" | "webp" | "gif";
export type FileAttachmentFormat = string;

export type ConversationAttachmentStatus =
  | "queued"
  | "preprocessing"
  | "ready"
  | "failed"
  | "unsupported"
  | "deleted";

export interface AttachmentWarning {
  code: string;
  message: string;
}

export type AttachmentArtifactRefs = Record<string, ManagedArtifactId>;

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
  format?: FileAttachmentFormat;
  artifactRefs: AttachmentArtifactRefs;
  processingMetadata: JsonObject;
  warnings: AttachmentWarning[];
  error?: JsonObject | null;
  processingOwnerId?: string;
  processingLeaseToken?: string;
  processingLeaseExpiresAt?: ISODateString;
  processingAttempts: number;
  createdAt: ISODateString;
  updatedAt: ISODateString;
  preprocessingStartedAt?: ISODateString;
  preprocessingCompletedAt?: ISODateString;
  deletedAt?: ISODateString;
}

export type DraftAttachment = ConversationAttachment & {
  messageId?: undefined;
};

export interface AttachmentModelContextHint {
  section: string;
  text: string;
}

export interface AttachmentManifestEntry {
  kind: string;
  fileId: ManagedFileId;
  attachmentId: ConversationAttachmentId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  status: string;
  readable?: boolean;
  modelVisibility?: ModelVisibleArtifactHint;
  modelContext?: AttachmentModelContextHint;
  metadata?: JsonObject;
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
  status: Exclude<ConversationAttachmentStatus, "preprocessing" | "deleted">;
  format?: FileAttachmentFormat;
  artifactRefs?: AttachmentArtifactRefs;
  processingMetadata?: JsonObject;
  warnings?: AttachmentWarning[];
  error?: JsonObject;
}

export interface UpdateConversationAttachmentInput {
  clientInstanceId: ClientInstanceId;
  attachmentId: ConversationAttachmentId;
  status?: ConversationAttachmentStatus;
  format?: FileAttachmentFormat;
  artifactRefs?: AttachmentArtifactRefs;
  processingMetadata?: JsonObject;
  warnings?: AttachmentWarning[];
  error?: JsonObject | null;
  processingOwnerId?: string | null;
  processingLeaseToken?: string | null;
  processingLeaseExpiresAt?: ISODateString | null;
  processingAttempts?: number;
  preprocessingStartedAt?: ISODateString | null;
  preprocessingCompletedAt?: ISODateString | null;
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

export interface ManagedFileStore {
  createManagedFile(input: CreateManagedFileInput): Promise<ManagedFileRecord>;
  getManagedFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<ManagedFileRecord | undefined>;
}

export interface ManagedArtifactStore {
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
}

export interface ConversationAttachmentStore {
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
  claimNextQueuedConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    workerId: string;
    leaseToken: string;
    now: ISODateString;
    leaseExpiresAt: ISODateString;
    perConversationLimit: number;
    globalLimit: number;
    formats?: readonly FileAttachmentFormat[];
  }): Promise<ConversationAttachment | undefined>;
  completeClaimedConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    artifactRefs: AttachmentArtifactRefs;
    processingMetadata?: JsonObject;
    warnings: AttachmentWarning[];
    completedAt: ISODateString;
  }): Promise<ConversationAttachment>;
  failClaimedConversationAttachment(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    error: JsonObject;
    completedAt: ISODateString;
  }): Promise<ConversationAttachment>;
  findReadyConversationAttachmentByFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined>;
  findConversationAttachmentByFile(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    fileId: ManagedFileId;
  }): Promise<ConversationAttachment | undefined>;
}

export interface PlatformFileStore
  extends ManagedFileStore,
    ManagedArtifactStore,
    ConversationAttachmentStore {}
