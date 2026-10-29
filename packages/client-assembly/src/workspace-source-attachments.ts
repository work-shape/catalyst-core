import { detectWorkspaceSourceFileType } from "./workspace-source-file-type";
import { resolveUploadFileContent } from "@work-shape/catalyst-capability-sdk";
import {
  AppError,
  ARTIFACT_PREVIEW_IMAGE_MIME_TYPES,
  asConversationAttachmentId,
  asManagedArtifactId,
  asManagedFileId,
  readObjectBytes,
  type AttachmentManifest,
  type AttachmentManifestEntry,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationId,
  type DraftAttachment,
  type JsonObject,
  type LocaleCode,
  type ManagedArtifactRecord,
  type ManagedFileId,
  type ManagedObjectDeletionResult,
  type ObjectStorage,
  type PlatformFileStore
} from "@work-shape/catalyst-core";
import { EXECUTION_WORKSPACE_ARTIFACT_METADATA_SOURCE } from "@work-shape/catalyst-tool-execution";
import { posix as posixPath } from "node:path";
import type {
  ClientInstanceAttachmentHandler,
  ClientInstanceManagedObjectReaderContribution
} from "./capabilities";

/** The upload surface and source handler use the same refusal in the selected language. */
export function unsupportedAttachmentMessage(locale: LocaleCode | undefined): string {
  const formats = WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES.filter((type) => type.startsWith("."))
    .map((type) => type.slice(1).toUpperCase())
    .join(", ");
  return locale === "de"
    ? `Diesen Dateityp kannst du hier nicht anhängen. Unterstützt werden: ${formats}.`
    : `You cannot attach this file type here. Supported types: ${formats}.`;
}

const WORKSPACE_SOURCE_ATTACHMENT_KIND = "workspace_source";
const WORKSPACE_SOURCE_METADATA_SOURCE = "execution_workspace_source";
const LEGACY_WORKSPACE_PREVIEW_ARTIFACT_METADATA_SOURCE = "execution_workspace_preview";
const DEFAULT_WORKSPACE_SOURCE_MAX_FILE_BYTES = 25 * 1024 * 1024;
const ARTIFACT_PREVIEW_OBJECT_KEY_PREFIX = "artifact-previews/";
const ARTIFACT_PREVIEW_IMAGE_MIME_TYPE_SET = new Set<string>(ARTIFACT_PREVIEW_IMAGE_MIME_TYPES);
const ARTIFACT_PREVIEW_IMAGE_KINDS = new Set([
  "document.preview_page_image",
  "presentation.preview_slide_image",
  "spreadsheet.preview_range_image",
  "spreadsheet.preview_sheet_image"
]);

const WORKSPACE_SOURCE_EXTENSIONS = new Set([
  "csv",
  "txt",
  "md",
  "markdown",
  "html",
  "css",
  "js",
  "svg",
  "xml",
  "doc",
  "docx",
  "pdf",
  "json",
  "odp",
  "ods",
  "odt",
  "ppt",
  "pptm",
  "pptx",
  "rtf",
  "xls",
  "xlsm",
  "xlsx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp"
]);

const WORKSPACE_SOURCE_MIME_TYPES = new Map<string, string>([
  ["text/plain", "txt"],
  ["text/markdown", "markdown"],
  ["text/x-markdown", "markdown"],
  ["text/html", "html"],
  ["text/css", "css"],
  ["text/javascript", "js"],
  ["application/javascript", "js"],
  ["image/svg+xml", "svg"],
  ["text/xml", "xml"],
  ["application/xml", "xml"],
  ["application/msword", "doc"],
  ["application/pdf", "pdf"],
  ["application/json", "json"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
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
  ["text/csv", "csv"],
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"]
]);

/**
 * Pictures a model reads and a browser shows: they go to the model as images and show in the
 * chat (T23). Recognized by their bytes, whatever their name says.
 */
// The same pictures a preview shows.
const MODEL_IMAGE_MIME_TYPES = ARTIFACT_PREVIEW_IMAGE_MIME_TYPES;
type ModelImageMimeType = (typeof MODEL_IMAGE_MIME_TYPES)[number];
const MODEL_IMAGE_FORMATS = new Set(["png", "jpg", "gif", "webp"]);

function isModelImageMimeType(mimeType: string | undefined): mimeType is ModelImageMimeType {
  return MODEL_IMAGE_MIME_TYPES.some((imageType) => imageType === mimeType);
}

/** A picture is refused where its name or type says image and its bytes are not one. */
function unreadableImageMessage(locale: LocaleCode | undefined): string {
  return locale === "de"
    ? "Diese Bilddatei ist kein lesbares Bild. Unterstützt werden PNG, JPG, GIF und WebP."
    : "This image file is not a readable picture. Supported are PNG, JPG, GIF and WebP.";
}

/** Picker and upload detection are derived from the same formats. */
export const WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES = [
  ...[...WORKSPACE_SOURCE_EXTENSIONS].map((extension) => `.${extension}`),
  ...WORKSPACE_SOURCE_MIME_TYPES.keys()
];

export interface CreateExecutionWorkspaceSourceAttachmentHandlerInput {
  clientInstanceId: ClientInstanceId;
  files: PlatformFileStore;
  /** The `workspaces` object store of the instance. */
  objectStore: ObjectStorage;
  maxFileBytes?: number;
  markDeletedOnDelete: boolean;
  /** Specialized processing owns a file where one of these handlers accepts it. */
  capabilityAttachmentHandlers?: readonly Pick<ClientInstanceAttachmentHandler, "acceptsFile">[];
}

export function createExecutionWorkspaceSourceAttachmentHandler(
  input: CreateExecutionWorkspaceSourceAttachmentHandlerInput
): ClientInstanceAttachmentHandler {
  const { objectStore } = input;
  const maxFileBytes = input.maxFileBytes ?? DEFAULT_WORKSPACE_SOURCE_MAX_FILE_BYTES;
  const service = new ExecutionWorkspaceSourceAttachmentService({
    ...input,
    maxFileBytes
  });

  return {
    name: "execution-workspace-source-files",
    maxFileBytes,
    acceptedFileTypes: WORKSPACE_SOURCE_ACCEPTED_FILE_TYPES,
    acceptsFile(file) {
      return (
        (file.workspaceToolsAvailable ||
          detectWorkspaceSourceFileFormat(file.filename, file.mimeType) !== undefined) &&
        !input.capabilityAttachmentHandlers?.some(
          (handler) =>
            handler.acceptsFile(file) && handler.acceptsFile(workspaceSourceRoutingInput(file))
        )
      );
    },
    listDraftAttachments(conversationId) {
      return service.listDraftAttachments(conversationId);
    },
    async uploadDraftAttachment(file) {
      return {
        attachment: await service.uploadDraftAttachment({
          ...file,
          content: resolveUploadFileContent(file)
        }),
        outcome: "created"
      };
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
    async deleteOrphanedFileObjects(file) {
      const objectKeys = file.objectKeys.filter(isSourceObjectKey);
      await Promise.all(objectKeys.map((objectKey) => objectStore.delete(objectKey)));
      return objectKeys;
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
    isInlineDisplayMimeType(mimeType) {
      return isModelImageMimeType(mimeType);
    }
  };
}

export function createExecutionWorkspaceManagedObjectReader(input: {
  clientInstanceId: ClientInstanceId;
  files: PlatformFileStore;
  /** The `workspaces` object store of the instance. */
  byteStore: ObjectStorage;
}): ClientInstanceManagedObjectReaderContribution {
  return {
    name: "execution-workspace",
    async readArtifact(readInput) {
      const artifact = await input.files.getManagedArtifact({
        clientInstanceId: input.clientInstanceId,
        artifactId: readInput.artifactId
      });
      if (!artifact) {
        throw new AppError("NOT_FOUND", "Managed workspace artifact is not available");
      }
      if (
        artifact.metadata.source !== EXECUTION_WORKSPACE_ARTIFACT_METADATA_SOURCE &&
        artifact.metadata.source !== LEGACY_WORKSPACE_PREVIEW_ARTIFACT_METADATA_SOURCE &&
        !(await isReadableArtifactPreviewImage({
          artifact,
          clientInstanceId: input.clientInstanceId,
          files: input.files
        }))
      ) {
        throw new AppError("NOT_FOUND", "Managed workspace artifact is not available");
      }
      return {
        bytes: await readObjectBytes(input.byteStore, artifact.objectKey),
        mimeType: artifact.mimeType
      };
    },
    // Only an attached picture leaves the workspace's store, for the model to see (T23).
    async readFile(readInput) {
      const file = await input.files.getManagedFile({
        clientInstanceId: input.clientInstanceId,
        fileId: readInput.fileId
      });
      if (!file || !isSourceObjectKey(file.objectKey) || !isModelImageMimeType(file.mimeType)) {
        throw new AppError("NOT_FOUND", "Execution workspace managed files are internal");
      }
      return {
        bytes: await readObjectBytes(input.byteStore, file.objectKey),
        mimeType: file.mimeType
      };
    }
  };
}

async function isReadableArtifactPreviewImage(input: {
  artifact: ManagedArtifactRecord;
  clientInstanceId: ClientInstanceId;
  files: PlatformFileStore;
}): Promise<boolean> {
  if (
    !ARTIFACT_PREVIEW_IMAGE_KINDS.has(input.artifact.kind) ||
    !ARTIFACT_PREVIEW_IMAGE_MIME_TYPE_SET.has(input.artifact.mimeType) ||
    !input.artifact.objectKey.startsWith(ARTIFACT_PREVIEW_OBJECT_KEY_PREFIX)
  ) {
    return false;
  }

  const sourceArtifactId = readPreviewSourceArtifactId(input.artifact.metadata);
  if (!sourceArtifactId || sourceArtifactId === input.artifact.id) {
    return false;
  }

  const sourceArtifact = await input.files.getManagedArtifact({
    clientInstanceId: input.clientInstanceId,
    artifactId: asManagedArtifactId(sourceArtifactId)
  });
  return (
    sourceArtifact?.clientInstanceId === input.artifact.clientInstanceId &&
    sourceArtifact.conversationId === input.artifact.conversationId
  );
}

function readPreviewSourceArtifactId(metadata: JsonObject): string | undefined {
  return typeof metadata.sourceArtifactId === "string" && metadata.sourceArtifactId.length > 0
    ? metadata.sourceArtifactId
    : undefined;
}

export function detectWorkspaceSourceFileFormat(
  filename: string,
  mimeType: string | undefined
): string | undefined {
  const extension = extensionFromFilename(filename);
  const extensionFormat =
    extension && WORKSPACE_SOURCE_EXTENSIONS.has(extension)
      ? extension === "md"
        ? "markdown"
        : extension === "jpeg"
          ? "jpg"
          : extension
      : undefined;
  const normalizedMimeType = mimeType?.split(";", 1)[0]?.trim().toLowerCase();
  const mimeFormat = normalizedMimeType
    ? WORKSPACE_SOURCE_MIME_TYPES.get(normalizedMimeType)
    : undefined;
  // Browsers can label CSV or Markdown as plain text. Preserve a known extension, and
  // never let a generic text MIME type admit an unsupported extension such as .py or .bin.
  if (mimeFormat === "txt" || mimeFormat === "markdown") {
    return extensionFormat ?? (extension === undefined ? mimeFormat : undefined);
  }
  return mimeFormat ?? extensionFormat;
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
      if (isModelImageAttachment(attachment)) {
        return [
          {
            kind: "image",
            fileId: attachment.fileId,
            attachmentId: attachment.id,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            byteSize: attachment.byteSize,
            status: "ready",
            readable: false,
            modelVisibility: { type: "image", mimeType: attachment.mimeType },
            modelContext: {
              section: "Attached images",
              text: `- ${attachment.filename} (fileId: ${attachment.fileId}, status: ready, mimeType: ${attachment.mimeType}, size: ${attachment.byteSize} bytes). The image is loaded directly into visual context when the model supports image inputs.`
            },
            metadata: {
              fileId: attachment.fileId,
              filename: attachment.filename,
              mimeType: attachment.mimeType,
              byteSize: attachment.byteSize,
              format: attachment.format ?? null,
              checksum: attachment.checksum
            }
          }
        ];
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
            text: `- ${attachment.filename} (fileId: ${attachment.fileId}, status: ready, size: ${attachment.byteSize} bytes, type: ${attachment.processingMetadata.detectedType ?? "unknown binary data"}). Use workspace.import_files({ "files": [{ "fileId": "${attachment.fileId}" }] }) before workspace.exec when you need to inspect, convert, or edit this file in the execution workspace; use the returned importedFiles[].path exactly; do not guess or shorten filenames.`
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
  private readonly objectStore: ObjectStorage;
  private readonly maxFileBytes: number;
  private readonly markDeletedOnDelete: boolean;

  constructor(
    input: CreateExecutionWorkspaceSourceAttachmentHandlerInput & {
      objectStore: ObjectStorage;
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
    locale?: LocaleCode;
    workspaceToolsAvailable?: boolean;
    conversationId: ConversationId;
    ownerUserId: string;
    filename: string;
    mimeType?: string;
    content: {
      byteSize: number;
      checksum: string;
      headerBytes: Uint8Array;
      openStream(): AsyncIterable<Uint8Array>;
    };
  }): Promise<DraftAttachment> {
    if (input.content.byteSize > this.maxFileBytes) {
      throw new AppError(
        "VALIDATION_FAILED",
        "File exceeds the configured workspace source upload size limit"
      );
    }
    if (input.content.byteSize === 0) {
      throw new AppError("VALIDATION_FAILED", "Empty files cannot be attached");
    }
    if (safeObjectFilename(input.filename).startsWith("~$")) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Microsoft Word temporary owner files are not readable documents. Upload the original .docx file instead of the '~$' lock file."
      );
    }
    const detectedType = detectWorkspaceSourceFileType(input.content.headerBytes);
    const declaredFormat = detectWorkspaceSourceFileFormat(input.filename, input.mimeType);
    if (!input.workspaceToolsAvailable && !declaredFormat) {
      throw new AppError("VALIDATION_FAILED", unsupportedAttachmentMessage(input.locale));
    }
    // A picture is stored as what its bytes are, so the model and the chat get a real image.
    const image = isModelImageMimeType(detectedType.mimeType);
    if (!image && declaredFormat !== undefined && MODEL_IMAGE_FORMATS.has(declaredFormat)) {
      throw new AppError("VALIDATION_FAILED", unreadableImageMessage(input.locale));
    }
    const format = image ? detectedType.extension : declaredFormat;
    const mimeType = image ? detectedType.mimeType : input.mimeType;

    if (!input.workspaceToolsAvailable && format === "docx") {
      const header = input.content.headerBytes;
      if (header[0] !== 0x50 || header[1] !== 0x4b || header[2] !== 0x03 || header[3] !== 0x04)
        throw new AppError(
          "VALIDATION_FAILED",
          input.locale === "de"
            ? "Diese DOCX-Datei ist kein lesbares Word-Dokument. Hänge die ursprüngliche DOCX-Datei an."
            : "This DOCX file is not a readable Word document. Attach the original DOCX file."
        );
    }
    const checksum = input.content.checksum;
    const objectKey = createSourceObjectKey({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      checksum,
      filename: input.filename
    });
    await this.objectStore.put(objectKey, input.content.openStream(), {
      contentType: mimeType,
      size: input.content.byteSize
    });
    const file = await this.files.createManagedFile({
      clientInstanceId: this.clientInstanceId,
      ownerUserId: input.ownerUserId,
      filename: input.filename,
      byteSize: input.content.byteSize,
      checksum,
      objectKey,
      ...(mimeType ? { mimeType } : {})
    });
    const attachment = await this.files.createConversationAttachment({
      clientInstanceId: this.clientInstanceId,
      conversationId: input.conversationId,
      fileId: file.id,
      filename: input.filename,
      byteSize: input.content.byteSize,
      checksum,
      status: "ready",
      format: format ?? detectedType.extension,
      processingMetadata: {
        detectedType: detectedType.description,
        source: WORKSPACE_SOURCE_METADATA_SOURCE
      },
      warnings: [],
      ...(mimeType ? { mimeType } : {})
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
    // Alone, this handler marks every record of the Conversation deleted, so it removes every
    // object those records name, preview images included. Beside a capability handler it
    // removes only its own two prefixes and leaves the records to that handler.
    const fileObjectKeys = this.markDeletedOnDelete
      ? deletion.fileObjectKeys
      : deletion.fileObjectKeys.filter(isSourceObjectKey);
    const artifactObjectKeys = this.markDeletedOnDelete
      ? deletion.artifactObjectKeys
      : deletion.artifactObjectKeys.filter(isWorkspaceArtifactObjectKey);
    await Promise.all(
      [...fileObjectKeys, ...artifactObjectKeys].map((objectKey) =>
        this.objectStore.delete(objectKey)
      )
    );
    if (this.markDeletedOnDelete) {
      return this.files.markConversationManagedObjectsDeleted({
        clientInstanceId: this.clientInstanceId,
        conversationId: input.conversationId,
        deletedAt: input.deletedAt
      });
    }
    return { attachmentCount: 0, fileObjectKeys, artifactObjectKeys };
  }

  async readConversationFile(input: { conversationId: ConversationId; fileId: string }): Promise<{
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
      bytes: await readObjectBytes(this.objectStore, file.objectKey),
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
    if (
      !attachment ||
      attachment.conversationId !== conversationId ||
      !isWorkspaceSourceAttachment(attachment)
    ) {
      throw new AppError("NOT_FOUND", "Draft attachment is not available");
    }
    if (attachment.messageId !== undefined) {
      throw new AppError("CONFLICT", "Sent attachments cannot be retried");
    }
    return attachment;
  }
}

function isModelImageAttachment(
  attachment: ConversationAttachment
): attachment is ConversationAttachment & { mimeType: ModelImageMimeType } {
  return (
    isModelImageMimeType(attachment.mimeType) &&
    attachment.format !== undefined &&
    MODEL_IMAGE_FORMATS.has(attachment.format)
  );
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

function isWorkspaceArtifactObjectKey(value: string): boolean {
  return value.startsWith("execution-workspaces/");
}

function extensionFromFilename(filename: string): string | undefined {
  return filename
    .trim()
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/u)?.[1];
}

function safeObjectFilename(filename: string): string {
  const normalized = filename.replaceAll("\\", "/");
  const basename = posixPath.basename(normalized).trim();
  return basename && basename !== "." && basename !== ".." ? basename : "source.bin";
}

/** Select specialized readers using signatures when unrestricted workspace intake is allowed.
 * Original names and browser media types are kept on the stored attachment. */
export function workspaceSourceRoutingInput<
  Input extends {
    filename: string;
    mimeType?: string;
    workspaceToolsAvailable?: boolean;
    content: { headerBytes: Uint8Array };
  }
>(input: Input): Input {
  if (!input.workspaceToolsAvailable) return input;
  const detected = detectWorkspaceSourceFileType(input.content.headerBytes);
  // DOCX is itself a ZIP package; a bounded prefix need not contain its word/ entries.
  if (detected.extension === "zip" && extensionFromFilename(input.filename) === "docx")
    return input;
  // Text formats need their language-specific reader; a signature cannot distinguish Markdown.
  const declaredFormat = detectWorkspaceSourceFileFormat(input.filename, input.mimeType);
  if (
    detected.extension === "txt" &&
    declaredFormat &&
    ["txt", "markdown", "md", "html", "css", "js", "svg", "xml", "json", "csv"].includes(
      declaredFormat
    )
  )
    return input;
  return { ...input, filename: `upload.${detected.extension}`, mimeType: detected.mimeType };
}
