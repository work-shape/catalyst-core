import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { posix as posixPath } from "node:path";
import {
  AppError,
  asConversationAttachmentId,
  asManagedFileId,
  type AttachmentManifest,
  type AttachmentManifestEntry,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationId,
  type DraftAttachment,
  type JsonObject,
  type ManagedFileId,
  type ManagedObjectDeletionResult,
  type PlatformFileStore
} from "@vivd-catalyst/core";
import type {
  ClientInstanceAttachmentHandler,
  ClientInstanceManagedObjectReaderContribution
} from "./capabilities";
import type { WorkspaceFileByteStore } from "@vivd-catalyst/tool-execution";

const WORKSPACE_SOURCE_ATTACHMENT_KIND = "workspace_source";
const WORKSPACE_SOURCE_METADATA_SOURCE = "execution_workspace_source";
const WORKSPACE_ARTIFACT_METADATA_SOURCE = "execution_workspace";
const DEFAULT_WORKSPACE_SOURCE_MAX_FILE_BYTES = 25 * 1024 * 1024;

const WORKSPACE_SOURCE_EXTENSIONS = new Set([
  "csv",
  "doc",
  "odp",
  "ods",
  "odt",
  "ppt",
  "pptm",
  "pptx",
  "rtf",
  "xls",
  "xlsm",
  "xlsx"
]);

const WORKSPACE_SOURCE_MIME_TYPES = new Map<string, string>([
  ["application/msword", "doc"],
  ["application/rtf", "rtf"],
  ["application/vnd.ms-excel", "xls"],
  ["application/vnd.ms-excel.sheet.macroenabled.12", "xlsm"],
  ["application/vnd.ms-powerpoint", "ppt"],
  ["application/vnd.ms-powerpoint.presentation.macroenabled.12", "pptm"],
  ["application/vnd.oasis.opendocument.presentation", "odp"],
  ["application/vnd.oasis.opendocument.spreadsheet", "ods"],
  ["application/vnd.oasis.opendocument.text", "odt"],
  ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"],
  ["text/csv", "csv"]
]);

export const WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES = [
  ".csv",
  ".doc",
  ".odt",
  ".rtf",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ods",
  ".ppt",
  ".pptx",
  ".pptm",
  ".odp",
  "text/csv",
  "application/msword",
  "application/rtf",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.ms-powerpoint.presentation.macroenabled.12",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.oasis.opendocument.text"
];

export interface CreateExecutionWorkspaceSourceAttachmentHandlerInput {
  clientInstanceId: ClientInstanceId;
  files: PlatformFileStore;
  objectRootDirectory: string;
  maxFileBytes?: number;
  markDeletedOnDelete: boolean;
}

export function createExecutionWorkspaceSourceAttachmentHandler(
  input: CreateExecutionWorkspaceSourceAttachmentHandlerInput
): ClientInstanceAttachmentHandler {
  const objectStore = new LocalWorkspaceSourceObjectStore(input.objectRootDirectory);
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_WORKSPACE_SOURCE_MAX_FILE_BYTES;
  const service = new ExecutionWorkspaceSourceAttachmentService({
    ...input,
    objectStore,
    maxFileBytes
  });

  return {
    name: "execution-workspace-source-files",
    maxFileBytes,
    acceptedFileTypes: WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES,
    acceptsFile(file) {
      return detectWorkspaceSourceFileFormat(file.filename, file.mimeType) !== undefined;
    },
    listDraftAttachments(conversationId) {
      return service.listDraftAttachments(conversationId);
    },
    uploadDraftAttachment(file) {
      return service.uploadDraftAttachment(file);
    },
    retryDraftAttachment(file) {
      return service.retryDraftAttachment(file);
    },
    deleteDraftAttachment(file) {
      return service.deleteDraftAttachment(file);
    },
    deleteConversationAttachments(file) {
      return service.deleteConversationAttachments(file);
    },
    readConversationFile(file) {
      return service.readConversationFile(file);
    },
    blockingDraftAttachmentMessage(attachments) {
      if (attachments.some((attachment) => attachment.status === "failed")) {
        return "Remove or retry failed file attachments before sending.";
      }
      if (attachments.some((attachment) => attachment.status === "unsupported")) {
        return "Remove unsupported file attachments before sending.";
      }
      return undefined;
    },
    createAttachmentManifest(attachments) {
      return createWorkspaceSourceAttachmentManifest(attachments);
    },
    isInlineDisplayMimeType() {
      return false;
    }
  };
}

export function createExecutionWorkspaceManagedObjectReader(input: {
  clientInstanceId: ClientInstanceId;
  files: PlatformFileStore;
  byteStore: WorkspaceFileByteStore;
}): ClientInstanceManagedObjectReaderContribution {
  return {
    name: "execution-workspace",
    async readArtifact(readInput) {
      const artifact = await input.files.getManagedArtifact({
        clientInstanceId: input.clientInstanceId,
        artifactId: readInput.artifactId
      });
      if (!artifact || artifact.metadata.source !== WORKSPACE_ARTIFACT_METADATA_SOURCE) {
        throw new AppError("NOT_FOUND", "Managed workspace artifact is not available");
      }
      return {
        bytes: await input.byteStore.getObject(artifact.objectKey),
        mimeType: artifact.mimeType
      };
    },
    async readFile() {
      throw new AppError("NOT_FOUND", "Execution workspace managed files are internal");
    }
  };
}

export function detectWorkspaceSourceFileFormat(
  filename: string,
  mimeType: string | undefined
): string | undefined {
  const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const mimeFormat = normalizedMimeType ? WORKSPACE_SOURCE_MIME_TYPES.get(normalizedMimeType) : undefined;
  if (mimeFormat) {
    return mimeFormat;
  }
  const extension = extensionFromFilename(filename);
  return extension && WORKSPACE_SOURCE_EXTENSIONS.has(extension) ? extension : undefined;
}

function createWorkspaceSourceAttachmentManifest(
  attachments: readonly ConversationAttachment[]
): AttachmentManifest {
  return {
    version: 1,
    attachments: attachments.flatMap((attachment): AttachmentManifestEntry[] => {
      if (attachment.status !== "ready" || !isWorkspaceSourceAttachment(attachment)) {
        return [];
      }
      return [
        {
          kind: WORKSPACE_SOURCE_ATTACHMENT_KIND,
          fileId: attachment.fileId,
          attachmentId: attachment.id,
          filename: attachment.filename,
          ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
          byteSize: attachment.byteSize,
          status: "ready",
          readable: false,
          modelContext: {
            section: "Attached source artifacts",
            text: `- ${attachment.filename} (fileId: ${attachment.fileId}, status: ready, size: ${attachment.byteSize} bytes, format: ${attachment.format ?? "file"}). Use workspace.import_files({ "files": [{ "fileId": "${attachment.fileId}" }] }) before workspace.exec when you need to inspect, convert, or edit this file in the execution workspace.`
          },
          metadata: {
            fileId: attachment.fileId,
            filename: attachment.filename,
            mimeType: attachment.mimeType ?? null,
            byteSize: attachment.byteSize,
            format: attachment.format ?? null,
            checksum: attachment.checksum
          } as unknown as JsonObject
        }
      ];
    })
  };
}

class ExecutionWorkspaceSourceAttachmentService {
  private readonly clientInstanceId: ClientInstanceId;
  private readonly files: PlatformFileStore;
  private readonly objectStore: LocalWorkspaceSourceObjectStore;
  private readonly maxFileBytes: number;
  private readonly markDeletedOnDelete: boolean;

  constructor(
    input: CreateExecutionWorkspaceSourceAttachmentHandlerInput & {
      objectStore: LocalWorkspaceSourceObjectStore;
      maxFileBytes: number;
    }
  ) {
    this.clientInstanceId = input.clientInstanceId;
    this.files = input.files;
    this.objectStore = input.objectStore;
    this.maxFileBytes = input.maxFileBytes;
    this.markDeletedOnDelete = input.markDeletedOnDelete;
  }

  async listDraftAttachments(conversationId: ConversationId): Promise<DraftAttachment[]> {
    return this.files.listDraftAttachments({
      clientInstanceId: this.clientInstanceId,
      conversationId
    });
  }

  async uploadDraftAttachment(input: {
    conversationId: ConversationId;
    ownerUserId: string;
    filename: string;
    mimeType?: string;
    bytes: Uint8Array;
  }): Promise<DraftAttachment> {
    if (input.bytes.byteLength > this.maxFileBytes) {
      throw new AppError(
        "VALIDATION_FAILED",
        "File exceeds the configured workspace source upload size limit"
      );
    }
    const format = detectWorkspaceSourceFileFormat(input.filename, input.mimeType);
    if (!format) {
      throw new AppError(
        "VALIDATION_FAILED",
        "This file type is not supported for workspace artifact uploads"
      );
    }

    const checksum = checksumBytes(input.bytes);
    const objectKey = createSourceObjectKey({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      checksum,
      filename: input.filename
    });
    await this.objectStore.putObject(objectKey, input.bytes);
    const file = await this.files.createManagedFile({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      byteSize: input.bytes.byteLength,
      checksum,
      objectKey,
      ...(input.mimeType ? { mimeType: input.mimeType } : {})
    });
    const attachment = await this.files.createConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: file.id,
      filename: input.filename,
      byteSize: input.bytes.byteLength,
      checksum,
      status: "ready",
      format,
      processingMetadata: {
        source: WORKSPACE_SOURCE_METADATA_SOURCE
      },
      warnings: [],
      ...(input.mimeType ? { mimeType: input.mimeType } : {})
    });
    return attachment as DraftAttachment;
  }

  async retryDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment> {
    const attachment = await this.requireSourceAttachment(input.conversationId, input.attachmentId);
    if (attachment.status !== "failed") {
      throw new AppError("CONFLICT", "Only failed draft attachments can be retried");
    }
    return this.files.updateConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      attachmentId: attachment.id,
      status: "ready",
      error: null,
      warnings: []
    });
  }

  async deleteDraftAttachment(input: {
    conversationId: ConversationId;
    attachmentId: string;
  }): Promise<ConversationAttachment> {
    await this.requireSourceAttachment(input.conversationId, input.attachmentId);
    return this.files.deleteDraftAttachment({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      attachmentId: asConversationAttachmentId(input.attachmentId),
      deletedAt: new Date().toISOString()
    });
  }

  async deleteConversationAttachments(input: {
    conversationId: ConversationId;
    deletedAt: string;
  }): Promise<ManagedObjectDeletionResult> {
    const deletion = await this.files.listConversationManagedObjectsForDeletion({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId
    });
    const sourceFileObjectKeys = deletion.fileObjectKeys.filter(isSourceObjectKey);
    await Promise.all(sourceFileObjectKeys.map((objectKey) => this.objectStore.deleteObject(objectKey)));
    if (this.markDeletedOnDelete) {
      return this.files.markConversationManagedObjectsDeleted({
        clientInstanceId: this.clientInstanceId,
        conversationId: input.conversationId,
        deletedAt: input.deletedAt
      });
    }
    return {
      attachmentCount: 0,
      fileObjectKeys: sourceFileObjectKeys,
      artifactObjectKeys: []
    };
  }

  async readConversationFile(input: {
    conversationId: ConversationId;
    fileId: string;
  }): Promise<{
    fileId: ManagedFileId;
    filename: string;
    mimeType?: string;
    byteSize: number;
    bytes: Uint8Array;
  }> {
    const attachment = await this.files.findConversationAttachmentByFile({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: asManagedFileId(input.fileId)
    });
    if (!attachment || attachment.status !== "ready" || !isWorkspaceSourceAttachment(attachment)) {
      throw new AppError("NOT_FOUND", "Managed source file is not available in this conversation");
    }
    const file = await this.files.getManagedFile({
      clientInstanceId: this.clientInstanceId,
      fileId: attachment.fileId
    });
    if (!file || !isSourceObjectKey(file.objectKey)) {
      throw new AppError("NOT_FOUND", "Managed source file is not available");
    }
    const mimeType = attachment.mimeType ?? file.mimeType;
    return {
      fileId: file.id,
      filename: attachment.filename,
      byteSize: attachment.byteSize,
      bytes: await this.objectStore.getObject(file.objectKey),
      ...(mimeType ? { mimeType } : {})
    };
  }

  private async requireSourceAttachment(
    conversationId: ConversationId,
    attachmentId: string
  ): Promise<ConversationAttachment> {
    const attachment = await this.files.getConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      attachmentId: asConversationAttachmentId(attachmentId)
    });
    if (!attachment || attachment.conversationId !== conversationId || !isWorkspaceSourceAttachment(attachment)) {
      throw new AppError("NOT_FOUND", "Draft attachment is not available");
    }
    if (attachment.messageId !== undefined) {
      throw new AppError("CONFLICT", "Sent attachments cannot be retried");
    }
    return attachment;
  }
}

class LocalWorkspaceSourceObjectStore {
  constructor(private readonly rootDirectory: string) {}

  async putObject(key: string, bytes: Uint8Array): Promise<void> {
    const path = this.resolveObjectPath(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  async getObject(key: string): Promise<Uint8Array> {
    return readFile(this.resolveObjectPath(key));
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.resolveObjectPath(key), { force: true });
  }

  private resolveObjectPath(key: string): string {
    const normalized = normalizeObjectKey(key);
    const root = resolve(this.rootDirectory);
    const target = resolve(root, ...normalized.split("/"));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new Error(`Workspace source object key '${key}' escapes the object root`);
    }
    return target;
  }
}

function isWorkspaceSourceAttachment(attachment: ConversationAttachment): boolean {
  return attachment.processingMetadata.source === WORKSPACE_SOURCE_METADATA_SOURCE;
}

function createSourceObjectKey(input: {
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
  checksum: string;
  filename: string;
}): string {
  return [
    "execution-workspace-source-files",
    encodeURIComponent(input.clientInstanceId),
    encodeURIComponent(input.conversationId),
    encodeURIComponent(input.checksum),
    encodeURIComponent(safeObjectFilename(input.filename))
  ].join("/");
}

function isSourceObjectKey(value: string): boolean {
  return value.startsWith("execution-workspace-source-files/");
}

function checksumBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionFromFilename(filename: string): string | undefined {
  return filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/u)?.[1];
}

function safeObjectFilename(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  const basename = posixPath.basename(normalized).trim();
  return basename && basename !== "." && basename !== ".." ? basename : "source.bin";
}

function normalizeObjectKey(key: string): string {
  if (
    key.trim().length === 0 ||
    key.includes("\0") ||
    key.startsWith("/") ||
    key.startsWith("\\") ||
    key.includes("\\")
  ) {
    throw new Error(`Invalid workspace source object key '${key}'`);
  }
  const normalized = posixPath.normalize(key);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Invalid workspace source object key '${key}'`);
  }
  return normalized;
}
