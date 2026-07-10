import { createHash } from "node:crypto";
import {
  AppError,
  type AttachmentManifest,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationId,
  type DraftAttachment,
  type JsonObject,
  type ManagedArtifactId,
  type ManagedArtifactKind,
  type ManagedArtifactRecord,
  type ManagedFileId,
  type ManagedFileRecord,
  type ManagedObjectDeletionResult,
  type PlatformFileStore
} from "@vivd-catalyst/core";
import type {
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

export type { DataSourceQueryInput, DataSourceQueryResult, DataSourceRegistry, DataSourceRegistration };
export { defineTool, defineConfiguredTool, toolFailed, toolSuccess };
export type {
  AnyConfiguredToolDefinition,
  AnyToolDefinition,
  ConfiguredToolDefinition,
  ToolAssemblyDefinition,
  ToolDefinition
};

export type ClientInstanceEnv = Record<string, string | undefined>;
export type PlatformStoreMode = "postgres" | "memory";

export interface ClientInstanceCapabilityContext {
  clientInstanceId: ClientInstanceId;
  capabilitiesConfig: Record<string, unknown>;
  dataSources: DataSourceRegistry;
  env: ClientInstanceEnv;
  files: ClientInstanceCapabilityFiles;
  managedObjectAccess: ManagedObjectAccessFactory;
  storeMode: PlatformStoreMode;
}

export type ClientInstanceCapabilityFiles = Pick<
  PlatformFileStore,
  | "createConversationAttachment"
  | "getConversationAttachment"
  | "listDraftAttachments"
  | "updateConversationAttachment"
  | "deleteDraftAttachment"
  | "claimReadyDraftAttachmentsForMessage"
  | "claimNextQueuedConversationAttachment"
  | "completeClaimedConversationAttachment"
  | "failClaimedConversationAttachment"
  | "findReadyConversationAttachmentByFile"
  | "findConversationAttachmentByFile"
  | "listConversationManagedObjectsForDeletion"
  | "listManagedArtifactsForFile"
  | "markConversationManagedObjectsDeleted"
>;

export interface ClientInstanceCapabilityContribution {
  tools?: AnyToolDefinition[];
  attachments?: ClientInstanceAttachmentHandler[];
  managedObjects?: ClientInstanceManagedObjectReaderContribution[];
  close?: () => Promise<void>;
}

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

export interface ClientInstanceAttachmentHandler {
  name: string;
  maxFileBytes: number;
  acceptedFileTypes: string[];
  acceptsFile(input: Pick<UploadDraftAttachmentInput, "filename" | "mimeType" | "bytes">): boolean;
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
  deleteConversationAttachments(input: {
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult>;
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
  readFile(input: {
    clientInstanceId: ClientInstanceId;
    fileId: ManagedFileId;
  }): Promise<{
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
  create(
    context: ClientInstanceCapabilityContext
  ): ClientInstanceCapabilityContribution | Promise<ClientInstanceCapabilityContribution>;
}

export interface ManagedObjectByteStore {
  putObject(input: {
    key: string;
    body: Uint8Array;
    contentType?: string;
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

export function createManagedObjectAccess(input: CreateManagedObjectAccessInput): ManagedObjectAccess {
  return new DefaultManagedObjectAccess(input);
}

class DefaultManagedObjectAccess implements ManagedObjectAccess {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly files: PlatformFileStore;
  private readonly byteStore: ManagedObjectByteStore;
  private readonly keyFactory: ManagedObjectKeyFactory;

  constructor(input: CreateManagedObjectAccessInput) {
    this.clientInstanceId = input.clientInstanceId;
    this.files = input.files;
    this.byteStore = input.byteStore;
    this.keyFactory = input.keyFactory;
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
    return this.files.createManagedArtifact({
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
