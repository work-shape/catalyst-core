import type {
  ClientInstanceId,
  CollaborationWorkspaceId,
  ConversationAttachmentId,
  ConversationId,
  ManagedArtifactId,
  ManagedFileId,
  MessageId,
  UserId
} from "./ids";
import type {
  ArtifactPreviewImagePageRef,
  ArtifactPreviewModelImageInput
} from "./artifact-preview-pages";
import type { JsonObject } from "./json";
import type { ISODateString } from "./time";

export interface ManagedFileRef {
  fileId: string;
  mimeType?: string;
  filename?: string;
  checksum?: string;
}

export type ManagedArtifactKind = string;

export type SupportedImageMimeType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export type ArtifactPreviewImageFormat = "png" | "jpeg" | "webp";
export type ArtifactPreviewStatus = "pending" | "ready" | "failed" | "unsupported";
export type ArtifactPreviewJobStatus =
  "pending" | "processing" | "completed" | "failed" | "unsupported";
export type ArtifactPreviewSourceKind = "document" | "presentation" | "pdf" | "spreadsheet";
export type FilePreviewCapability =
  | "native_image"
  | "native_pdf"
  | "spreadsheet"
  | "office_document_pages"
  | "office_presentation_pages"
  | "markdown"
  | "text";
export type ArtifactPreviewFailureCode =
  | "unsupported_type"
  | "source_missing"
  | "source_too_large"
  | "output_too_large"
  | "page_limit_exceeded"
  | "conversion_timeout"
  | "conversion_failed"
  | "rasterization_failed"
  | "storage_failed"
  | "internal_error"
  | "stale_lease";

// Protects the preview worker and every reader of a preview from an unbounded page list. A
// preview of a longer document shows its first 500 pages.
export const ARTIFACT_PREVIEW_MAX_PAGES = 500;
export const DEFAULT_ARTIFACT_PREVIEW_RENDERER = "artifact-preview-worker";
// Names the rules a stored preview or failure was produced under. Raise it when a change makes
// earlier results wrong, so they are rendered again: v2 raised the spreadsheet cell limit.
export const DEFAULT_ARTIFACT_PREVIEW_RENDERER_VERSION = "preview-contract-v2";
export const DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH = "default-image-pages-v1";
export const ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_REF = "preview.source_artifact";
export const ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_KIND = "preview.source_attachment";

export interface ArtifactPreviewIdentityInput {
  renderer?: string;
  rendererVersion?: string;
  settingsHash?: string;
}

export interface ArtifactPreviewIdentity {
  renderer: string;
  rendererVersion: string;
  settingsHash: string;
}

export function normalizeArtifactPreviewIdentity(
  input: ArtifactPreviewIdentityInput = {}
): ArtifactPreviewIdentity {
  return {
    renderer: input.renderer ?? DEFAULT_ARTIFACT_PREVIEW_RENDERER,
    rendererVersion: input.rendererVersion ?? DEFAULT_ARTIFACT_PREVIEW_RENDERER_VERSION,
    settingsHash: input.settingsHash ?? DEFAULT_ARTIFACT_PREVIEW_SETTINGS_HASH
  };
}

export function isRetryableArtifactPreviewErrorCode(errorCode: string | undefined): boolean {
  return (
    errorCode === "conversion_timeout" ||
    errorCode === "conversion_failed" ||
    errorCode === "source_too_large" ||
    errorCode === "output_too_large" ||
    errorCode === "page_limit_exceeded" ||
    errorCode === "rasterization_failed" ||
    errorCode === "storage_failed" ||
    errorCode === "internal_error" ||
    errorCode === "stale_lease" ||
    errorCode === "preview_manifest_missing"
  );
}

export type ArtifactPreviewManifest =
  | {
      status: "ready";
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      sourceArtifactId: ManagedArtifactId;
      renderer: string;
      rendererVersion: string;
      settingsHash: string;
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
      renderer: string;
      rendererVersion: string;
      settingsHash: string;
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

export interface ManagedArtifactPreviewImagePageRef {
  artifactId: string;
  kind?: string;
  filename?: string;
  mimeType: SupportedImageMimeType;
  pageNumber?: number;
  slideNumber?: number;
  sheet?: string;
  range?: string;
}

export interface ManagedArtifactImagePagesPreview {
  type: "image_pages";
  format: ImageFileFormat;
  pages: ManagedArtifactPreviewImagePageRef[];
}

export interface ManagedArtifactPreviewMetadata {
  preview: ManagedArtifactImagePagesPreview;
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
  resource?: {
    category: "analysis";
    key: string;
  };
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

export function isImageFileFormat(
  format: FileAttachmentFormat | undefined
): format is ImageFileFormat {
  return format === "png" || format === "jpeg" || format === "webp" || format === "gif";
}

export type ConversationAttachmentStatus =
  "queued" | "preprocessing" | "ready" | "failed" | "unsupported" | "deleted";

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

export interface EnsureManagedArtifactInput extends CreateManagedArtifactInput {
  id: ManagedArtifactId;
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
  sheet?: string;
  range?: string;
  width?: number;
  height?: number;
  modelImage?: ArtifactPreviewModelImageInput;
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
  replaceTerminal?: boolean;
  queuedAt?: ISODateString;
}

export type WriteArtifactPreviewManifestInput =
  | {
      status: "ready";
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      sourceArtifactId: ManagedArtifactId;
      renderer?: string;
      rendererVersion?: string;
      settingsHash?: string;
      type: "image_pages";
      format: ArtifactPreviewImageFormat;
      pages: ArtifactPreviewImagePageRef[];
      pageCount?: number;
      writtenAt?: ISODateString;
    }
  | {
      status: "failed" | "unsupported";
      clientInstanceId: ClientInstanceId;
      conversationId: ConversationId;
      sourceArtifactId: ManagedArtifactId;
      renderer?: string;
      rendererVersion?: string;
      settingsHash?: string;
      errorCode?: string;
      writtenAt?: ISODateString;
    };

/**
 * What a job finds when it claims its subject row by id. `finished` is a row that needs no
 * work any more, a missing one included. `held` is a row under a live lease that is not the
 * job's: during the transition release a worker of the previous release has it.
 */
export type SubjectRowClaim<Row> =
  { status: "claimed"; row: Row } | { status: "finished" } | { status: "held" };

export interface ClaimArtifactPreviewJobInput {
  clientInstanceId: ClientInstanceId;
  jobId: string;
  /** Names the executor job, so a later attempt of it takes the row over at once. */
  leaseOwnerId: string;
  leaseToken: string;
  leaseMs: number;
}

export interface RenewClaimedArtifactPreviewJobLeaseInput {
  clientInstanceId: ClientInstanceId;
  jobId: string;
  leaseToken: string;
  leaseMs: number;
}

export interface CompleteClaimedArtifactPreviewJobInput {
  clientInstanceId: ClientInstanceId;
  jobId: string;
  leaseToken: string;
  format: ArtifactPreviewImageFormat;
  pages?: ArtifactPreviewImagePageRef[];
  previewArtifacts?: ArtifactPreviewImageArtifactInput[];
  sourcePageCount?: number;
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

/**
 * A managed file that no active Conversation refers to: neither through an attachment, whatever
 * its status, nor as the source of an artifact that is not deleted.
 */
export interface OrphanedManagedFile {
  id: ManagedFileId;
  objectKey: string;
  /**
   * True when a managed file outside the listed batch, or a managed artifact, that is not
   * deleted stores its bytes under the same object key. The bytes must then be kept.
   */
  objectKeyInUse: boolean;
}

export interface ManagedFileStore {
  createManagedFile(input: CreateManagedFileInput): Promise<ManagedFileRecord>;
  getManagedFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<ManagedFileRecord | undefined>;
  /** Lists orphaned managed files created before `createdBefore`, ordered by id. */
  listOrphanedManagedFiles(input: {
    clientInstanceId: ClientInstanceId;
    createdBefore: ISODateString;
    afterFileId?: ManagedFileId;
    limit: number;
  }): Promise<OrphanedManagedFile[]>;
  /**
   * Marks the given files deleted and returns how many were marked. A file that is no longer
   * orphaned is left alone.
   */
  markOrphanedManagedFilesDeleted(input: {
    clientInstanceId: ClientInstanceId;
    fileIds: readonly ManagedFileId[];
    createdBefore: ISODateString;
    deletedAt: ISODateString;
  }): Promise<number>;
}

export interface ManagedArtifactStore {
  createManagedArtifact(input: CreateManagedArtifactInput): Promise<ManagedArtifactRecord>;
  ensureManagedArtifact(input: EnsureManagedArtifactInput): Promise<ManagedArtifactRecord>;
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
  listConversationManagedArtifacts(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ManagedArtifactRecord[]>;
}

export interface ArtifactPreviewStore {
  /**
   * Writes the preview row and, in the same transaction, enqueues the job
   * `artifact_preview.render` that drives it while the row is not finished.
   */
  enqueueArtifactPreviewJob(
    input: EnqueueArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord>;
  getArtifactPreviewJob(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
    renderer?: string;
    rendererVersion?: string;
    settingsHash?: string;
  }): Promise<ArtifactPreviewJobRecord | undefined>;
  /**
   * The first step of the job that drives a preview row: takes the row by id when it is
   * pending, when its lease ran out or when an earlier attempt of the same job held it, and
   * writes the job's lease onto the row's lease columns. The times are the database's.
   */
  claimArtifactPreviewJob(
    input: ClaimArtifactPreviewJobInput
  ): Promise<SubjectRowClaim<ArtifactPreviewJobRecord>>;
  /** Extends the lease copied onto the row. False when the row is no longer held with the token. */
  renewClaimedArtifactPreviewJobLease(
    input: RenewClaimedArtifactPreviewJobLeaseInput
  ): Promise<boolean>;
  completeClaimedArtifactPreviewJob(
    input: CompleteClaimedArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord>;
  failClaimedArtifactPreviewJob(
    input: FailClaimedArtifactPreviewJobInput
  ): Promise<ArtifactPreviewJobRecord>;
  markClaimedArtifactPreviewJobUnsupported(
    input: MarkClaimedArtifactPreviewJobUnsupportedInput
  ): Promise<ArtifactPreviewJobRecord>;
  /**
   * Transition release only: enqueues a job for every preview row that is not finished and has
   * no queued or running job, up to `limit`. Returns how many it enqueued.
   */
  adoptArtifactPreviewJobs(input: {
    clientInstanceId: ClientInstanceId;
    limit: number;
  }): Promise<number>;
  getArtifactPreviewManifest(input: {
    clientInstanceId: ClientInstanceId;
    sourceArtifactId: ManagedArtifactId;
    renderer?: string;
    rendererVersion?: string;
    settingsHash?: string;
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
  listSentConversationAttachments(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
  }): Promise<ConversationAttachment[]>;
  findConversationAttachmentByChecksum(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    checksum: string;
  }): Promise<ConversationAttachment | undefined>;
  updateConversationAttachment(
    input: UpdateConversationAttachmentInput
  ): Promise<ConversationAttachment>;
  reactivateDraftAttachment(input: {
    clientInstanceId: ClientInstanceId;
    conversationId: ConversationId;
    attachmentId: ConversationAttachmentId;
    status: "queued" | "ready" | "unsupported";
  }): Promise<ConversationAttachment>;
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
  /**
   * The first step of the job that preprocesses an attachment: takes the row by id when it is
   * queued, when its lease ran out or when an earlier attempt of the same job held it, and
   * writes the job's lease onto the row's lease columns. The times are the database's.
   */
  claimConversationAttachmentForPreprocessing(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    /** Names the executor job, so a later attempt of it takes the row over at once. */
    leaseOwnerId: string;
    leaseToken: string;
    leaseMs: number;
  }): Promise<SubjectRowClaim<ConversationAttachment>>;
  /** Extends the lease copied onto the row. False when the row is no longer held with the token. */
  renewClaimedConversationAttachmentLease(input: {
    clientInstanceId: ClientInstanceId;
    attachmentId: ConversationAttachmentId;
    leaseToken: string;
    leaseMs: number;
  }): Promise<boolean>;
  /**
   * Transition release only: the attachments that wait for preprocessing and have no queued or
   * running job of `jobKind`, oldest first. The adopt schedule enqueues a job for each.
   */
  listConversationAttachmentsWithoutJob(input: {
    clientInstanceId: ClientInstanceId;
    jobKind: string;
    formats?: readonly FileAttachmentFormat[];
    limit: number;
  }): Promise<Array<{ id: ConversationAttachmentId; conversationId: ConversationId }>>;
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
  /**
   * Conversations that are no longer active and still hold data to clean up: an artifact that
   * is not marked deleted, preview state, or an attachment whose file is not marked deleted and
   * has no live attachment in another Conversation.
   */
  listConversationsPendingObjectCleanup(input: {
    clientInstanceId: ClientInstanceId;
    /** Only this workspace's, and then also those whose execution workspace holds data. */
    collaborationWorkspaceId?: CollaborationWorkspaceId;
    /** Only those this user created, with the same addition. */
    createdByUserId?: UserId;
    limit: number;
  }): Promise<ConversationId[]>;
}

export interface PlatformFileStore
  extends
    ManagedFileStore,
    ManagedArtifactStore,
    ArtifactPreviewStore,
    ConversationAttachmentStore {}
