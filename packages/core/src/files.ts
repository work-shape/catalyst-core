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

export type ArtifactPreviewImageFormat = "png" | "jpeg" | "webp";
export type ArtifactPreviewStatus = "pending" | "ready" | "failed" | "unsupported";
export type ArtifactPreviewJobStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "unsupported";
export type ArtifactPreviewSourceKind = "document" | "presentation";
export type ArtifactPreviewFailureCode =
  | "unsupported_type"
  | "source_missing"
  | "source_too_large"
  | "page_limit_exceeded"
  | "conversion_timeout"
  | "conversion_failed"
  | "rasterization_failed"
  | "storage_failed"
  | "internal_error"
  | "stale_lease";

export const DEFAULT_ARTIFACT_PREVIEW_RENDERER = "artifact-preview-worker";
export const DEFAULT_ARTIFACT_PREVIEW_RENDERER_VERSION = "preview-contract-v1";
export const DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH = "default-image-pages-v1";

export interface ArtifactPreviewImagePageRef {
  artifactId: ManagedArtifactId;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  filename?: string;
  pageNumber?: number;
  slideNumber?: number;
  width?: number;
  height?: number;
}

export type ArtifactPreviewManifest =
  | {
      status: "ready";
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      sourceArtifactId: ManagedArtifactId;
      type: "image_pages";
      format: ArtifactPreviewImageFormat;
      pageCount: number;
      pages: ArtifactPreviewImagePageRef[];
      createdAt: ISODateString;
      updatedAt: ISODateString;
    }
  | {
      status: "failed" | "unsupported";
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      sourceArtifactId: ManagedArtifactId;
      errorCode?: string;
      createdAt: ISODateString;
      updatedAt: ISODateString;
    };

export interface ArtifactPreviewJobRecord {
  id: string;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  sourceArtifactId: ManagedArtifactId;
  sourceChecksum: string;
  sourceMimeType: string;
  renderer: string;
  rendererVersion: string;
  settingsHash: string;
  status: ArtifactPreviewJobStatus;
  attempts: number;
  nextAttemptAt?: ISODateString;
  leaseOwnerId?: string;
  leaseToken?: string;
  leaseExpiresAt?: ISODateString;
  errorCode?: string;
  errorMessage?: string;
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

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

export interface ManagedObjectDeletionResult {
  attachmentCount: number;
  fileObjectKeys: string[];
  artifactObjectKeys: string[];
}

export type ToolDisplayMode = "inline" | "side_panel" | "fullscreen";

export type ToolDisplayOutput = JsonObject & {
  kind: string;
  version: number;
  mode?: ToolDisplayMode;
  displayId?: string;
  title?: string;
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

export interface ArtifactPreviewImageArtifactInput {
  sourceFileId?: ManagedFileId;
  kind: ManagedArtifactKind;
  objectKey: string;
  filename?: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  byteSize: number;
  checksum: string;
  metadata?: JsonObject;
  pageNumber?: number;
  slideNumber?: number;
  width?: number;
  height?: number;
}

export interface EnqueueArtifactPreviewJobInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  sourceArtifactId: ManagedArtifactId;
  sourceChecksum: string;
  sourceMimeType: string;
  renderer?: string;
  rendererVersion?: string;
  settingsHash?: string;
  queuedAt?: ISODateString;
}

export type WriteArtifactPreviewManifestInput =
  | {
      status: "ready";
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      sourceArtifactId: ManagedArtifactId;
      type: "image_pages";
      format: ArtifactPreviewImageFormat;
      pages: ArtifactPreviewImagePageRef[];
      writtenAt?: ISODateString;
    }
  | {
      status: "failed" | "unsupported";
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      sourceArtifactId: ManagedArtifactId;
      errorCode?: string;
      writtenAt?: ISODateString;
    };

export interface ClaimNextArtifactPreviewJobInput {
  clientInstanceId: ClientInstanceId;
  workerId: string;
  leaseToken: string;
  now: ISODateString;
  leaseExpiresAt: ISODateString;
}

export interface CompleteClaimedArtifactPreviewJobInput {
  clientInstanceId: ClientInstanceId;
  jobId: string;
  leaseToken: string;
  format: ArtifactPreviewImageFormat;
  pages?: ArtifactPreviewImagePageRef[];
  previewArtifacts?: ArtifactPreviewImageArtifactInput[];
  completedAt: ISODateString;
}

export interface FailClaimedArtifactPreviewJobInput {
  clientInstanceId: ClientInstanceId;
  jobId: string;
  leaseToken: string;
  errorCode: ArtifactPreviewFailureCode;
  errorMessage?: string;
  failedAt: ISODateString;
  retryAt?: ISODateString;
}

export interface MarkClaimedArtifactPreviewJobUnsupportedInput {
  clientInstanceId: ClientInstanceId;
  jobId: string;
  leaseToken: string;
  errorCode?: ArtifactPreviewFailureCode;
  errorMessage?: string;
  unsupportedAt: ISODateString;
}

export interface RecoverStaleArtifactPreviewJobsInput {
  clientInstanceId: ClientInstanceId;
  staleLeaseExpiredBefore: ISODateString;
  recoveredAt: ISODateString;
  maxAttempts: number;
  limit: number;
  errorCode?: ArtifactPreviewFailureCode;
  errorMessage?: string;
  retryAt?: ISODateString;
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

export interface ArtifactPreviewStore {
  enqueueArtifactPreviewJob(input: EnqueueArtifactPreviewJobInput): Promise<ArtifactPreviewJobRecord>;
  getArtifactPreviewJob(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
  }): Promise<ArtifactPreviewJobRecord | undefined>;
  claimNextArtifactPreviewJob(
    input: ClaimNextArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord | undefined>;
  completeClaimedArtifactPreviewJob(
    input: CompleteClaimedArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord>;
  failClaimedArtifactPreviewJob(
    input: FailClaimedArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord>;
  markClaimedArtifactPreviewJobUnsupported(
    input: MarkClaimedArtifactPreviewJobUnsupportedInput
  ): Promise<ArtifactPreviewJobRecord>;
  recoverStaleArtifactPreviewJobs(
    input: RecoverStaleArtifactPreviewJobsInput
  ): Promise<ArtifactPreviewJobRecord[]>;
  getArtifactPreviewManifest(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
  }): Promise<ArtifactPreviewManifest | undefined>;
  writeArtifactPreviewManifest(
    input: WriteArtifactPreviewManifestInput
  ): Promise<ArtifactPreviewManifest>;
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
  markConversationManagedObjectsDeleted(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    deletedAt: ISODateString;
  }): Promise<ManagedObjectDeletionResult>;
  listConversationManagedObjectsForDeletion(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ManagedObjectDeletionResult>;
}

export interface PlatformFileStore
  extends ManagedFileStore,
    ManagedArtifactStore,
    ArtifactPreviewStore,
    ConversationAttachmentStore {}

export function detectArtifactPreviewSourceKind(input: {
  filename?: string;
  kind?: string;
  mimeType?: string;
}): ArtifactPreviewSourceKind | undefined {
  const descriptor = `${input.mimeType ?? ""} ${input.kind ?? ""} ${input.filename ?? ""}`.toLowerCase();
  if (containsOfficePresentationSignal(descriptor)) {
    return "presentation";
  }
  if (containsOfficeDocumentSignal(descriptor)) {
    return "document";
  }
  return undefined;
}

function containsOfficePresentationSignal(descriptor: string): boolean {
  return (
    descriptor.includes("presentationml") ||
    descriptor.includes("powerpoint") ||
    hasArtifactPreviewExtension(descriptor, ["pptx", "ppt"])
  );
}

function containsOfficeDocumentSignal(descriptor: string): boolean {
  return (
    descriptor.includes("wordprocessingml") ||
    descriptor.includes("msword") ||
    hasArtifactPreviewExtension(descriptor, ["docx", "doc"])
  );
}

function hasArtifactPreviewExtension(descriptor: string, extensions: string[]): boolean {
  return extensions.some((extension) => new RegExp(`(^|[^a-z0-9])${extension}([^a-z0-9]|$)`, "iu").test(descriptor));
}
