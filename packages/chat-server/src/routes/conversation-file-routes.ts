import type { FastifyInstance } from "fastify";
import { apiOperations, type ArtifactPreviewResponse } from "@vivd-catalyst/api-contract";
import {
  AppError,
  asManagedArtifactId,
  detectArtifactPreviewSourceKind,
  requireAuthScope,
  type ArtifactPreviewImageFormat,
  type ArtifactPreviewManifest,
  type ArtifactPreviewStore,
  type ManagedArtifactRecord
} from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import { authenticateRequest, getConversationId } from "../request-context";
import type { ChatServerOptions } from "../types";

type ArtifactPreviewReadyResponse = Extract<ArtifactPreviewResponse, { status: "ready" }>;

export function registerConversationFileRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  app.get(apiOperations.getConversationFileContent.path, async (request, reply) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    const service = attachments(options);
    const file = await service.readConversationFile({
      conversationId,
      fileId: getFileId(request)
    });
    if (!file.mimeType || !service.isInlineDisplayMimeType(file.mimeType)) {
      throw new AppError("VALIDATION_FAILED", "Only image attachments can be displayed inline");
    }
    return reply
      .header("content-type", file.mimeType)
      .header("content-length", String(file.bytes.byteLength))
      .header("cache-control", "private, max-age=60")
      .header("content-disposition", contentDisposition("inline", file.filename))
      .send(Buffer.from(file.bytes));
  });

  app.get(apiOperations.getConversationArtifactContent.path, async (request, reply) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    const artifactId = asManagedArtifactId(getArtifactId(request));
    const artifactRecord = await options.conversationStore.getManagedArtifact({
      clientInstanceId: options.clientInstanceId,
      artifactId
    });
    if (!artifactRecord || artifactRecord.conversationId !== conversationId) {
      throw new AppError("NOT_FOUND", "Managed artifact is not available in this conversation");
    }
    if (!options.managedObjects) {
      throw new AppError("VALIDATION_FAILED", "Managed artifact downloads are not configured");
    }
    const artifact = await options.managedObjects.readArtifact({
      clientInstanceId: options.clientInstanceId,
      artifactId
    });
    const filename = artifactRecord.filename ?? `${artifactRecord.id}`;
    return reply
      .header("content-type", artifact.mimeType)
      .header("content-length", String(artifact.bytes.byteLength))
      .header("cache-control", "private, max-age=60")
      .header("content-disposition", contentDisposition("attachment", filename))
      .send(Buffer.from(artifact.bytes));
  });

  app.get(apiOperations.getConversationArtifactPreview.path, async (request, reply) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    const artifactId = asManagedArtifactId(getArtifactId(request));
    const artifactRecord = await options.conversationStore.getManagedArtifact({
      clientInstanceId: options.clientInstanceId,
      artifactId
    });
    if (!artifactRecord || artifactRecord.conversationId !== conversationId) {
      throw new AppError("NOT_FOUND", "Managed artifact is not available in this conversation");
    }
    const preview = await readArtifactPreviewState(options.conversationStore, artifactRecord);
    return reply.header("cache-control", "private, no-store, max-age=0").send(preview);
  });
}

function attachments(options: ChatServerOptions) {
  if (!options.attachments) {
    throw new AppError("VALIDATION_FAILED", "Attachment handling is not configured");
  }
  return options.attachments;
}

function getFileId(request: { params: unknown }): string {
  const params = request.params as { fileId?: string };
  if (!params?.fileId) {
    throw new AppError("BAD_REQUEST", "Missing file id");
  }
  return params.fileId;
}

function getArtifactId(request: { params: unknown }): string {
  const params = request.params as { artifactId?: string };
  if (!params?.artifactId) {
    throw new AppError("BAD_REQUEST", "Missing artifact id");
  }
  return params.artifactId;
}

function contentDisposition(disposition: "attachment" | "inline", filename: string): string {
  const safeFilename = sanitizeHeaderFilename(filename);
  return [
    `${disposition}; filename="${asciiFilenameFallback(safeFilename)}"`,
    `filename*=UTF-8''${encodeRfc5987Value(safeFilename)}`
  ].join("; ");
}

function sanitizeHeaderFilename(value: string): string {
  const sanitized = value.replaceAll(/["\r\n\\/]/gu, "_").trim();
  return sanitized || "download";
}

function asciiFilenameFallback(value: string): string {
  return value.replaceAll(/[^\x20-\x7E]/gu, "_");
}

function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replaceAll(/['()*]/gu, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

async function readArtifactPreviewState(
  store: ArtifactPreviewStore,
  artifact: ManagedArtifactRecord
): Promise<ArtifactPreviewResponse> {
  const manifest = await store.getArtifactPreviewManifest({
    clientInstanceId: artifact.clientInstanceId,
    sourceArtifactId: artifact.id
  });
  if (manifest) {
    return artifactPreviewResponseFromManifest(artifact.id, manifest);
  }

  const embedded = readEmbeddedImagePagesPreview(artifact.metadata);
  if (embedded) {
    return {
      artifactId: artifact.id,
      ...embedded
    };
  }

  const job = await store.getArtifactPreviewJob({
    clientInstanceId: artifact.clientInstanceId,
    sourceArtifactId: artifact.id
  });
  if (job) {
    if (job.status === "failed") {
      return {
        status: "failed",
        artifactId: artifact.id,
        ...(job.errorCode ? { errorCode: job.errorCode } : {})
      };
    }
    if (job.status === "unsupported") {
      return {
        status: "unsupported",
        artifactId: artifact.id,
        ...(job.errorCode ? { errorCode: job.errorCode } : {})
      };
    }
    if (job.status === "completed") {
      return {
        status: "failed",
        artifactId: artifact.id,
        errorCode: "preview_manifest_missing"
      };
    }
    return {
      status: "pending",
      artifactId: artifact.id,
      queuedAt: job.createdAt
    };
  }

  if (detectArtifactPreviewSourceKind(artifact)) {
    const queued = await store.enqueueArtifactPreviewJob({
      clientInstanceId: artifact.clientInstanceId,
      conversationId: artifact.conversationId,
      sourceArtifactId: artifact.id,
      sourceChecksum: artifact.checksum,
      sourceMimeType: artifact.mimeType
    });
    return {
      status: "pending",
      artifactId: artifact.id,
      queuedAt: queued.createdAt
    };
  }

  return {
    status: "unsupported",
    artifactId: artifact.id,
    errorCode: "unsupported_type"
  };
}

function artifactPreviewResponseFromManifest(
  artifactId: string,
  manifest: ArtifactPreviewManifest
): ArtifactPreviewResponse {
  if (manifest.status === "ready") {
    return {
      status: "ready",
      artifactId,
      type: "image_pages",
      format: manifest.format,
      pages: manifest.pages.map((page) => ({
        artifactId: page.artifactId,
        mimeType: page.mimeType,
        ...(page.filename ? { filename: page.filename } : {}),
        ...(page.pageNumber !== undefined ? { pageNumber: page.pageNumber } : {}),
        ...(page.slideNumber !== undefined ? { slideNumber: page.slideNumber } : {}),
        ...(page.width !== undefined ? { width: page.width } : {}),
        ...(page.height !== undefined ? { height: page.height } : {})
      }))
    };
  }
  return {
    status: manifest.status,
    artifactId,
    ...(manifest.errorCode ? { errorCode: manifest.errorCode } : {})
  };
}

function readEmbeddedImagePagesPreview(
  metadata: unknown
): Omit<ArtifactPreviewReadyResponse, "artifactId"> | undefined {
  const metadataRecord = isRecord(metadata) ? metadata : undefined;
  const preview = isRecord(metadataRecord?.preview) ? metadataRecord.preview : undefined;
  if (preview?.type !== "image_pages") {
    return undefined;
  }
  const format = readPreviewImageFormat(preview.format);
  if (!format) {
    return undefined;
  }
  const pages = Array.isArray(preview.pages)
    ? preview.pages.slice(0, 200).flatMap((page): ArtifactPreviewReadyResponse["pages"] => {
        const sanitized = sanitizeEmbeddedPreviewPage(page);
        return sanitized ? [sanitized] : [];
      })
    : [];
  if (pages.length === 0) {
    return undefined;
  }
  return {
    status: "ready",
    type: "image_pages",
    format,
    pages
  };
}

function sanitizeEmbeddedPreviewPage(
  value: unknown
): ArtifactPreviewReadyResponse["pages"][number] | undefined {
  const record = isRecord(value) ? value : undefined;
  const artifactId = readShortString(record?.artifactId, 200);
  const mimeType = readPreviewImageMimeType(record?.mimeType);
  if (!artifactId || !mimeType) {
    return undefined;
  }
  return {
    artifactId,
    mimeType,
    ...optionalStringField("filename", readShortString(record?.filename, 255)),
    ...optionalPositiveIntegerField("pageNumber", record?.pageNumber),
    ...optionalPositiveIntegerField("slideNumber", record?.slideNumber),
    ...optionalPositiveIntegerField("width", record?.width),
    ...optionalPositiveIntegerField("height", record?.height)
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readPreviewImageFormat(value: unknown): ArtifactPreviewImageFormat | undefined {
  return value === "png" || value === "jpeg" || value === "webp" ? value : undefined;
}

function readPreviewImageMimeType(
  value: unknown
): "image/png" | "image/jpeg" | "image/webp" | undefined {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp"
    ? value
    : undefined;
}

function readShortString(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function optionalStringField<Field extends string>(
  field: Field,
  value: string | undefined
): { [key in Field]?: string } {
  return (value ? { [field]: value } : {}) as { [key in Field]?: string };
}

function optionalPositiveIntegerField<Field extends string>(
  field: Field,
  value: unknown
): { [key in Field]?: number } {
  return (
    typeof value === "number" && Number.isInteger(value) && value > 0 ? { [field]: value } : {}
  ) as { [key in Field]?: number };
}
