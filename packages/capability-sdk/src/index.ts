import { createHash } from "node:crypto";
import {
  AppError,
  defineJobHandler,
  defineJobKind,
  type AttachmentManifest,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationId,
  type DraftAttachment,
  type Job,
  type JobControl,
  type JobHandler,
  type JobKind,
  type JobsStore,
  type JsonObject,
  type Logger,
  type ManagedArtifactId,
  type ManagedArtifactKind,
  type ManagedArtifactRecord,
  type ManagedFileId,
  type ManagedFileRecord,
  type ManagedObjectDeletionResult,
  type ModuleDefinition,
  type ModuleSnapshot,
  type PlatformFileStore,
  type RegisteredJobHandler,
  type RegisteredProviderDefinition,
  type RetriedJob,
  type SecretResolver
} from "@vivd-catalyst/core";
import type {
  DataSourceDescribeInput,
  DataSourceDescribeResult,
  DataSourceQueryInput,
  DataSourceQueryResult,
  DataSourceRegistry,
  DataSourceRegistration
} from "@vivd-catalyst/data-source";
import { defineTool, defineConfiguredTool, toolFailed, toolSuccess } from "@vivd-catalyst/tool-sdk";
import type {
  AnyConfiguredToolDefinition,
  AnyToolDefinition,
  ConfiguredToolDefinition,
  ToolAssemblyDefinition,
  ToolDefinition
} from "@vivd-catalyst/tool-sdk";

export type {
  DataSourceDescribeInput,
  DataSourceDescribeResult,
  DataSourceQueryInput,
  DataSourceQueryResult,
  DataSourceRegistry,
  DataSourceRegistration
};
export { defineTool, defineConfiguredTool, toolFailed, toolSuccess };
// A capability declares its job kinds with `defineJobKind`, enqueues through `jobs` on its
// context and serves them from its own worker process with `defineJobHandler`.
export { defineJobHandler, defineJobKind };
export type { Job, JobControl, JobHandler, JobKind, RegisteredJobHandler, RetriedJob };
export type {
  AnyConfiguredToolDefinition,
  AnyToolDefinition,
  ConfiguredToolDefinition,
  ToolAssemblyDefinition,
  ToolDefinition
};

export type ClientInstanceEnv = Record<string, string | undefined>;

export interface ClientInstanceCapabilityContext {
  logger: Logger;
  clientInstanceId: ClientInstanceId;
  capabilitiesConfig: Record<string, unknown>;
  /** Which modules are on. A capability asks this, not its own config, whether its module runs. */
  modules: ModuleSnapshot;
  dataSources: DataSourceRegistry;
  /** Settings only. A capability takes every secret from `secrets`. */
  env: ClientInstanceEnv;
  secrets: SecretResolver;
  /**
   * The instance's object store entries as the config states them. A capability that brings the
   * provider of a store creates it from its own definition.
   */
  objectStorage: { files?: unknown; workspaces?: unknown };
  files: ClientInstanceCapabilityFiles;
  /** Enqueues jobs of the kinds the capability declares. */
  jobs: ClientInstanceCapabilityJobs;
  /**
   * Runs `fn` with `files` and `jobs` bound to one transaction, so a record and the job that
   * drives it commit or roll back together.
   */
  transaction<Result>(
    fn: (stores: ClientInstanceCapabilityStores) => Promise<Result>
  ): Promise<Result>;
  managedObjectAccess: ManagedObjectAccessFactory;
}

export type ClientInstanceCapabilityJobs = Pick<JobsStore, "enqueue">;

/** What a capability writes through inside `transaction`. */
export interface ClientInstanceCapabilityStores {
  files: ClientInstanceCapabilityFiles;
  jobs: ClientInstanceCapabilityJobs;
}

export type ClientInstanceCapabilityFiles = Pick<
  PlatformFileStore,
  | "createConversationAttachment"
  | "getConversationAttachment"
  | "listDraftAttachments"
  | "findConversationAttachmentByChecksum"
  | "updateConversationAttachment"
  | "reactivateDraftAttachment"
  | "deleteDraftAttachment"
  | "claimReadyDraftAttachmentsForMessage"
  | "claimConversationAttachmentForPreprocessing"
  | "renewClaimedConversationAttachmentLease"
  | "listConversationAttachmentsWithoutJob"
  | "completeClaimedConversationAttachment"
  | "failClaimedConversationAttachment"
  | "findReadyConversationAttachmentByFile"
  | "findConversationAttachmentByFile"
  | "listConversationManagedObjectsForDeletion"
  | "listManagedArtifactsForFile"
  | "markConversationManagedObjectsDeleted"
>;

/**
 * How an ended job of a kind the capability declares is retried by hand. The API retries no
 * job of a kind it was not given one for.
 */
export interface ClientInstanceJobRetry {
  kind: JobKind;
  /**
   * Puts the subject record back into the state the job works from, in the transaction that
   * queues the job again. Answers false when the record cannot be worked on again. Missing
   * when the job reads everything it needs anew.
   */
  restoreSubject?(job: RetriedJob, stores: ClientInstanceCapabilityStores): Promise<boolean>;
}

export interface ClientInstanceCapabilityContribution {
  tools?: AnyToolDefinition[];
  attachments?: ClientInstanceAttachmentHandler[];
  managedObjects?: ClientInstanceManagedObjectReaderContribution[];
  jobRetries?: ClientInstanceJobRetry[];
  close?: () => Promise<void>;
}

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

export interface UploadDraftAttachmentResult {
  attachment: ConversationAttachment;
  outcome: "created" | "already_available";
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

export interface ClientInstanceAttachmentHandler {
  name: string;
  maxFileBytes: number;
  acceptedFileTypes: string[];
  acceptsFile(
    input: Pick<UploadDraftAttachmentInput, "filename" | "mimeType" | "content">
  ): boolean;
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
   * Deletes the stored bytes of managed files that no Conversation refers to any more. A
   * handler removes only the object keys it stores itself and returns those.
   */
  deleteOrphanedFileObjects?(input: { objectKeys: readonly string[] }): Promise<string[]>;
  /**
   * Transition release only: enqueues a job for each of the handler's attachments that waits
   * for preprocessing and has no queued or running job, up to `limit`, and returns how many.
   * The schedule `platform_jobs.adopt_legacy` calls it every minute. It goes with that schedule
   * in the contract step.
   */
  adoptLegacyAttachments?(input: { limit: number }): Promise<number>;
  readConversationFile(input: ReadConversationFileInput): Promise<ReadConversationFileResult>;
  blockingDraftAttachmentMessage(attachments: readonly DraftAttachment[]): string | undefined;
  createAttachmentManifest(attachments: readonly ConversationAttachment[]): AttachmentManifest;
  isInlineDisplayMimeType(mimeType: string): boolean;
}

export interface ClientInstanceManagedObjectReader {
  readArtifact(input: {
    clientInstanceId: ClientInstanceId;
    artifactId: ManagedArtifactId;
  }): Promise<{
    bytes: Uint8Array;
    mimeType: string;
  }>;
  readFile(input: { clientInstanceId: ClientInstanceId; fileId: ManagedFileId }): Promise<{
    bytes: Uint8Array;
    mimeType?: string;
  }>;
}

export interface ClientInstanceManagedObjectReaderContribution extends ClientInstanceManagedObjectReader {
  name: string;
}

export interface ClientInstanceCapability {
  name: string;
  configKey?: string;
  /** Modules whose code the capability ships. They register beside the platform's own. */
  modules?: readonly ModuleDefinition[];
  /** Providers the capability brings. They register beside the platform's own at startup. */
  providers?: readonly RegisteredProviderDefinition[];
  create(
    context: ClientInstanceCapabilityContext
  ): ClientInstanceCapabilityContribution | Promise<ClientInstanceCapabilityContribution>;
}

export interface ManagedObjectByteStore {
  putObject(input: {
    key: string;
    body: Uint8Array | AsyncIterable<Uint8Array>;
    contentType?: string;
    contentLength?: number;
  }): Promise<void>;
  getObject(key: string): Promise<Uint8Array>;
  deleteObject(key: string): Promise<void>;
}

export interface ManagedObjectFileKeyInput {
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  conversationId?: ConversationId;
  filename: string;
  mimeType?: string;
  byteSize: number;
  checksum: string;
  extension?: string;
  keyContext?: JsonObject;
}

export interface ManagedObjectArtifactKeyInput {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  sourceFileId?: ManagedFileId;
  kind: ManagedArtifactKind;
  filename?: string;
  mimeType: string;
  byteSize: number;
  checksum: string;
  extension?: string;
  metadata?: JsonObject;
  keyContext?: JsonObject;
}

export interface ManagedObjectKeyFactory {
  createFileObjectKey(input: ManagedObjectFileKeyInput): string;
  createArtifactObjectKey(input: ManagedObjectArtifactKeyInput): string;
}

export interface CreateManagedObjectFileInput {
  ownerUserId: string;
  conversationId?: ConversationId;
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
  extension?: string;
  keyContext?: JsonObject;
}

export interface CreateManagedObjectStreamedFileInput {
  ownerUserId: string;
  conversationId?: ConversationId;
  filename: string;
  mimeType?: string;
  content: UploadFileContent;
  extension?: string;
  keyContext?: JsonObject;
}

export interface CreateManagedObjectArtifactInput {
  conversationId: ConversationId;
  sourceFileId?: ManagedFileId;
  kind: ManagedArtifactKind;
  filename?: string;
  mimeType: string;
  bytes: Uint8Array;
  metadata?: JsonObject;
  extension?: string;
  keyContext?: JsonObject;
}

export interface ReadManagedObjectFileInput {
  fileId: ManagedFileId;
}

export interface ReadManagedObjectArtifactInput {
  artifactId: ManagedArtifactId;
}

export interface ManagedObjectFileRead {
  record: ManagedFileRecord;
  bytes: Uint8Array;
  mimeType?: string;
}

export interface ManagedObjectArtifactRead {
  record: ManagedArtifactRecord;
  bytes: Uint8Array;
  mimeType: string;
}

export interface ManagedObjectAccess {
  createFile(input: CreateManagedObjectFileInput): Promise<ManagedFileRecord>;
  createStreamedFile(input: CreateManagedObjectStreamedFileInput): Promise<ManagedFileRecord>;
  createArtifact(input: CreateManagedObjectArtifactInput): Promise<ManagedArtifactRecord>;
  readFile(input: ReadManagedObjectFileInput): Promise<ManagedObjectFileRead>;
  readArtifact(input: ReadManagedObjectArtifactInput): Promise<ManagedObjectArtifactRead>;
  deleteConversationObjects(input: {
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult>;
}

export interface CreateManagedObjectAccessInput {
  clientInstanceId: ClientInstanceId;
  files: PlatformFileStore;
  byteStore: ManagedObjectByteStore;
  keyFactory: ManagedObjectKeyFactory;
  logger?: import("@vivd-catalyst/core").Logger;
}

export interface CreateManagedObjectAccessFromContextInput {
  byteStore: ManagedObjectByteStore;
  keyFactory: ManagedObjectKeyFactory;
}

export interface ManagedObjectAccessFactory {
  createAccess(input: CreateManagedObjectAccessFromContextInput): ManagedObjectAccess;
}

export function defineCapability(capability: ClientInstanceCapability): ClientInstanceCapability {
  return capability;
}

export function createManagedObjectAccess(
  input: CreateManagedObjectAccessInput
): ManagedObjectAccess {
  return new DefaultManagedObjectAccess(input);
}

class DefaultManagedObjectAccess implements ManagedObjectAccess {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly files: PlatformFileStore;
  private readonly byteStore: ManagedObjectByteStore;
  private readonly keyFactory: ManagedObjectKeyFactory;
  private readonly logger: CreateManagedObjectAccessInput["logger"];

  constructor(input: CreateManagedObjectAccessInput) {
    this.clientInstanceId = input.clientInstanceId;
    this.files = input.files;
    this.byteStore = input.byteStore;
    this.keyFactory = input.keyFactory;
    this.logger = input.logger;
  }

  async createFile(input: CreateManagedObjectFileInput): Promise<ManagedFileRecord> {
    const checksum = createManagedObjectChecksum(input.bytes);
    const objectKey = this.keyFactory.createFileObjectKey({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      extension: input.extension,
      keyContext: input.keyContext
    });
    await this.byteStore.putObject({
      key: objectKey,
      body: input.bytes,
      contentType: input.mimeType
    });
    return this.files.createManagedFile({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      objectKey
    });
  }

  async createStreamedFile(
    input: CreateManagedObjectStreamedFileInput
  ): Promise<ManagedFileRecord> {
    const objectKey = this.keyFactory.createFileObjectKey({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      conversationId: input.conversationId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.content.byteSize,
      checksum: input.content.checksum,
      extension: input.extension,
      keyContext: input.keyContext
    });
    await this.byteStore.putObject({
      key: objectKey,
      body: input.content.openStream(),
      contentType: input.mimeType,
      contentLength: input.content.byteSize
    });
    return this.files.createManagedFile({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.content.byteSize,
      checksum: input.content.checksum,
      objectKey
    });
  }

  async createArtifact(input: CreateManagedObjectArtifactInput): Promise<ManagedArtifactRecord> {
    const checksum = createManagedObjectChecksum(input.bytes);
    const objectKey = this.keyFactory.createArtifactObjectKey({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      sourceFileId: input.sourceFileId,
      kind: input.kind,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.bytes.byteLength,
      checksum,
      extension: input.extension,
      metadata: input.metadata,
      keyContext: input.keyContext
    });
    await this.byteStore.putObject({
      key: objectKey,
      body: input.bytes,
      contentType: input.mimeType
    });
    try {
      return await this.files.createManagedArtifact({
        clientInstanceId: this.clientInstanceId,
        conversationId: input.conversationId,
        sourceFileId: input.sourceFileId,
        kind: input.kind,
        objectKey,
        filename: input.filename,
        mimeType: input.mimeType,
        byteSize: input.bytes.byteLength,
        checksum,
        metadata: input.metadata
      });
    } catch (error: unknown) {
      // The store refuses the record when the Conversation was deleted in the meantime. No
      // record names the bytes then, so they are removed here, best effort.
      if (error instanceof AppError && error.code === "NOT_FOUND") {
        try {
          await this.byteStore.deleteObject(objectKey);
        } catch (deleteError: unknown) {
          this.logger?.error(
            {
              objectKey,
              error: deleteError instanceof Error ? deleteError.message : String(deleteError)
            },
            "Could not remove an artifact object after its record was refused"
          );
        }
      }
      throw error;
    }
  }

  async readFile(input: ReadManagedObjectFileInput): Promise<ManagedObjectFileRead> {
    const record = await this.files.getManagedFile({
      clientInstanceId: this.clientInstanceId,
      fileId: input.fileId
    });
    if (!record) {
      throw new AppError("NOT_FOUND", `Managed file '${input.fileId}' was not found`);
    }
    return {
      record,
      bytes: await this.byteStore.getObject(record.objectKey),
      mimeType: record.mimeType
    };
  }

  async readArtifact(input: ReadManagedObjectArtifactInput): Promise<ManagedObjectArtifactRead> {
    const record = await this.files.getManagedArtifact({
      clientInstanceId: this.clientInstanceId,
      artifactId: input.artifactId
    });
    if (!record) {
      throw new AppError("NOT_FOUND", `Managed artifact '${input.artifactId}' was not found`);
    }
    return {
      record,
      bytes: await this.byteStore.getObject(record.objectKey),
      mimeType: record.mimeType
    };
  }

  async deleteConversationObjects(input: {
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult> {
    const deletion = await this.files.listConversationManagedObjectsForDeletion({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId
    });
    await Promise.all(
      [...deletion.artifactObjectKeys, ...deletion.fileObjectKeys].map((objectKey) =>
        this.byteStore.deleteObject(objectKey)
      )
    );
    return this.files.markConversationManagedObjectsDeleted({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      deletedAt: input.deletedAt
    });
  }
}

export function createManagedObjectChecksum(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function createUploadFileContent(bytes: Uint8Array): UploadFileContent {
  return {
    byteSize: bytes.byteLength,
    checksum: createManagedObjectChecksum(bytes),
    headerBytes: bytes.slice(0, 16),
    async *openStream() {
      yield bytes;
    }
  };
}

export function resolveUploadFileContent(input: {
  content?: UploadFileContent;
  bytes?: Uint8Array;
}): UploadFileContent {
  if (input.content) {
    return input.content;
  }
  if (input.bytes) {
    return createUploadFileContent(input.bytes);
  }
  throw new AppError("VALIDATION_FAILED", "Uploaded file content is missing");
}
