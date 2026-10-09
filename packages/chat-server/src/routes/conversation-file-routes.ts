import { apiOperations, type ArtifactPreviewResponse } from "@vivd-catalyst/api-contract";
import {
  AppError,
  ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_KIND,
  ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_REF,
  asArtifactPreviewContractReady,
  asConversationAttachmentId,
  asManagedArtifactId,
  detectArtifactPreviewSourceKind,
  isRetryableArtifactPreviewErrorCode,
  readArtifactPreviewLifecycle,
  resolveFilePreviewCapability,
  type ArtifactPreviewLifecycleState,
  type ArtifactPreviewStore,
  type ConversationAttachment,
  type ManagedArtifactRecord
} from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import type { Route } from "../http/route";
import { conversationIdParam, requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConversationFileRoutes(route: Route, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  route(apiOperations.getConversationFileContent, async ({ user, params, query, reply }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const service = attachments(options);
    const download = query.download === "true";
    const sentAttachment = download
      ? (
          await options.stores.files.listSentConversationAttachments({
            clientInstanceId: options.clientInstanceId,
            conversationId
          })
        ).find((attachment) => attachment.fileId === fileIdParam(params))
      : undefined;
    if (download && !sentAttachment) {
      throw new AppError("NOT_FOUND", "Attachment is not available in this conversation");
    }
    const file = await service.readConversationFile({
      conversationId,
      fileId: fileIdParam(params)
    });
    const inlineCapability = resolveFilePreviewCapability({
      filename: file.filename,
      mimeType: file.mimeType
    });
    if (
      !download &&
      inlineCapability !== "native_pdf" &&
      (!file.mimeType || !service.isInlineDisplayMimeType(file.mimeType))
    ) {
      throw new AppError("VALIDATION_FAILED", "This attachment cannot be displayed inline");
    }
    return reply
      .header("content-type", file.mimeType ?? "application/octet-stream")
      .header("content-length", String(file.bytes.byteLength))
      .header("cache-control", "private, max-age=60")
      .header(
        "content-disposition",
        contentDisposition(
          download ? "attachment" : "inline",
          sentAttachment?.filename ?? file.filename
        )
      )
      .send(Buffer.from(file.bytes));
  });

  route(apiOperations.getConversationArtifactContent, async ({ user, params, query, reply }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const artifactId = asManagedArtifactId(artifactIdParam(params));
    const artifactRecord = await options.stores.files.getManagedArtifact({
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
    const inline = query.inline === "true";
    const previewCapability = resolveFilePreviewCapability(artifactRecord);
    if (inline && previewCapability !== "native_image" && previewCapability !== "native_pdf") {
      throw new AppError("VALIDATION_FAILED", "This artifact cannot be displayed inline");
    }
    return reply
      .header("content-type", artifact.mimeType)
      .header("content-length", String(artifact.bytes.byteLength))
      .header("cache-control", "private, max-age=60")
      .header("content-disposition", contentDisposition(inline ? "inline" : "attachment", filename))
      .send(Buffer.from(artifact.bytes));
  });

  route(apiOperations.getConversationArtifactPreview, async ({ user, params, reply }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const artifactId = asManagedArtifactId(artifactIdParam(params));
    const artifactRecord = await options.stores.files.getManagedArtifact({
      clientInstanceId: options.clientInstanceId,
      artifactId
    });
    if (!artifactRecord || artifactRecord.conversationId !== conversationId) {
      throw new AppError("NOT_FOUND", "Managed artifact is not available in this conversation");
    }
    const preview = await readArtifactPreviewState(options.stores.files, artifactRecord);
    void reply.header("cache-control", "private, no-store, max-age=0");
    return preview;
  });

  route(apiOperations.startConversationArtifactPreview, async ({ user, params, reply }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const artifactId = asManagedArtifactId(artifactIdParam(params));
    const artifactRecord = await options.stores.files.getManagedArtifact({
      clientInstanceId: options.clientInstanceId,
      artifactId
    });
    if (!artifactRecord || artifactRecord.conversationId !== conversationId) {
      throw new AppError("NOT_FOUND", "Managed artifact is not available in this conversation");
    }
    const preview = await startArtifactPreviewState(options.stores.files, artifactRecord);
    void reply.header("cache-control", "private, no-store, max-age=0");
    return preview;
  });

  route(apiOperations.getConversationAttachmentPreview, async ({ user, params, reply }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const attachment = await options.stores.files.getConversationAttachment({
      clientInstanceId: options.clientInstanceId,
      attachmentId: asConversationAttachmentId(attachmentIdParam(params))
    });
    if (
      !attachment ||
      attachment.conversationId !== conversationId ||
      !attachment.messageId ||
      attachment.status === "deleted"
    ) {
      throw new AppError("NOT_FOUND", "Attachment is not available in this conversation");
    }
    if (!isOfficePagePreviewCapability(resolveFilePreviewCapability(attachment))) {
      throw new AppError("VALIDATION_FAILED", "This attachment uses its native preview path");
    }
    const source = await ensureAttachmentPreviewSource(options, attachment);
    const preview = source
      ? await readArtifactPreviewState(options.stores.files, source)
      : ({
          status: "pending",
          artifactId: attachmentPreviewSourceArtifactId(attachment)
        } satisfies ArtifactPreviewResponse);

    void reply.header("cache-control", "private, no-store, max-age=0");
    return preview;
  });

  route(apiOperations.startConversationAttachmentPreview, async ({ user, params, reply }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const attachment = await options.stores.files.getConversationAttachment({
      clientInstanceId: options.clientInstanceId,
      attachmentId: asConversationAttachmentId(attachmentIdParam(params))
    });
    if (
      !attachment ||
      attachment.conversationId !== conversationId ||
      !attachment.messageId ||
      attachment.status === "deleted"
    ) {
      throw new AppError("NOT_FOUND", "Attachment is not available in this conversation");
    }
    if (!isOfficePagePreviewCapability(resolveFilePreviewCapability(attachment))) {
      throw new AppError("VALIDATION_FAILED", "This attachment uses its native preview path");
    }
    const source = await ensureAttachmentPreviewSource(options, attachment, true);
    if (!source) throw new AppError("INTERNAL", "Preview source was not created");
    const preview = await startArtifactPreviewState(options.stores.files, source);
    void reply.header("cache-control", "private, no-store, max-age=0");
    return preview;
  });

  route(apiOperations.retryConversationArtifactPreview, async ({ user, params, reply }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const artifactId = asManagedArtifactId(artifactIdParam(params));
    const artifactRecord = await options.stores.files.getManagedArtifact({
      clientInstanceId: options.clientInstanceId,
      artifactId
    });
    if (!artifactRecord || artifactRecord.conversationId !== conversationId) {
      throw new AppError("NOT_FOUND", "Managed artifact is not available in this conversation");
    }
    const preview = await retryArtifactPreviewState(options.stores.files, artifactRecord);
    void reply.header("cache-control", "private, no-store, max-age=0");
    return preview;
  });
}

function isOfficePagePreviewCapability(
  capability: ReturnType<typeof resolveFilePreviewCapability>
): boolean {
  return capability === "office_document_pages" || capability === "office_presentation_pages";
}

function attachments(options: ChatServerOptions) {
  if (!options.attachments) {
    throw new AppError("VALIDATION_FAILED", "Attachment handling is not configured");
  }
  return options.attachments;
}

function fileIdParam(params: { fileId: string }): string {
  return requirePathParam(params.fileId, "Missing file id");
}

function artifactIdParam(params: { artifactId: string }): string {
  return requirePathParam(params.artifactId, "Missing artifact id");
}

function attachmentIdParam(params: { attachmentId: string }): string {
  return requirePathParam(params.attachmentId, "Missing attachment id");
}

async function ensureAttachmentPreviewSource(
  options: ChatServerOptions,
  attachment: ConversationAttachment,
  create = false
): Promise<ManagedArtifactRecord | undefined> {
  const referencedId = attachment.artifactRefs[ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_REF];
  if (referencedId) {
    const referenced = await options.stores.files.getManagedArtifact({
      clientInstanceId: options.clientInstanceId,
      artifactId: referencedId
    });
    if (
      referenced?.conversationId === attachment.conversationId &&
      referenced.sourceFileId === attachment.fileId &&
      referenced.status === "available"
    ) {
      return referenced;
    }
  }

  const existing = (
    await options.stores.files.listManagedArtifactsForFile({
      clientInstanceId: options.clientInstanceId,
      conversationId: attachment.conversationId,
      fileId: attachment.fileId,
      kind: ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_KIND
    })
  ).find((artifact) => artifact.metadata.sourceAttachmentId === attachment.id);
  if (existing) {
    if (create) await rememberAttachmentPreviewSource(options, attachment, existing);
    return existing;
  }

  if (!create) return undefined;

  const file = await options.stores.files.getManagedFile({
    clientInstanceId: options.clientInstanceId,
    fileId: attachment.fileId
  });
  if (!file || file.status !== "available" || file.checksum !== attachment.checksum) {
    throw new AppError("NOT_FOUND", "Attachment source file is not available");
  }
  const source = await options.stores.files.ensureManagedArtifact({
    id: attachmentPreviewSourceArtifactId(attachment),
    clientInstanceId: options.clientInstanceId,
    conversationId: attachment.conversationId,
    sourceFileId: attachment.fileId,
    kind: ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_KIND,
    objectKey: file.objectKey,
    filename: attachment.filename,
    mimeType: attachment.mimeType ?? "application/octet-stream",
    byteSize: attachment.byteSize,
    checksum: attachment.checksum,
    metadata: {
      source: "conversation_attachment",
      sourceAttachmentId: attachment.id
    }
  });
  await rememberAttachmentPreviewSource(options, attachment, source);
  return source;
}

function attachmentPreviewSourceArtifactId(
  attachment: ConversationAttachment
): ManagedArtifactRecord["id"] {
  return asManagedArtifactId(`art_attachment_preview_${attachment.id}`);
}

async function rememberAttachmentPreviewSource(
  options: ChatServerOptions,
  attachment: ConversationAttachment,
  source: ManagedArtifactRecord
): Promise<void> {
  await options.stores.files.updateConversationAttachment({
    clientInstanceId: options.clientInstanceId,
    attachmentId: attachment.id,
    artifactRefs: {
      ...attachment.artifactRefs,
      [ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_REF]: source.id
    }
  });
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
  return encodeURIComponent(value).replaceAll(
    /['()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

async function readArtifactPreviewState(
  store: ArtifactPreviewStore,
  artifact: ManagedArtifactRecord
): Promise<ArtifactPreviewResponse> {
  const preview = await readArtifactPreviewLifecycle(store, {
    clientInstanceId: artifact.clientInstanceId,
    sourceArtifactId: artifact.id,
    metadata: artifact.metadata
  });
  if (preview.status === "ready") {
    if (asArtifactPreviewContractReady(preview)) {
      return artifactPreviewResponse(artifact.id, preview);
    }
  } else if (preview.status !== "missing") {
    return artifactPreviewResponse(artifact.id, preview);
  }
  if (preview.status === "missing" && preview.completedWithoutManifest) {
    return failedArtifactPreviewResponse(artifact.id, "preview_manifest_missing");
  }

  if (detectArtifactPreviewSourceKind(artifact)) {
    return { status: "pending", artifactId: artifact.id };
  }

  return {
    status: "unsupported",
    artifactId: artifact.id,
    errorCode: "unsupported_type"
  };
}

async function startArtifactPreviewState(
  store: ArtifactPreviewStore,
  artifact: ManagedArtifactRecord
): Promise<ArtifactPreviewResponse> {
  const current = await readArtifactPreviewState(store, artifact);
  return current.status === "pending" && !current.queuedAt
    ? queueArtifactPreview(store, artifact)
    : current;
}

async function retryArtifactPreviewState(
  store: ArtifactPreviewStore,
  artifact: ManagedArtifactRecord
): Promise<ArtifactPreviewResponse> {
  const preview = await readArtifactPreviewLifecycle(store, {
    clientInstanceId: artifact.clientInstanceId,
    sourceArtifactId: artifact.id
  });
  if (preview.status === "ready") {
    if (asArtifactPreviewContractReady(preview)) {
      return artifactPreviewResponse(artifact.id, preview);
    }
    return detectArtifactPreviewSourceKind(artifact)
      ? queueArtifactPreview(store, artifact, true)
      : failedArtifactPreviewResponse(artifact.id, "preview_manifest_missing");
  }
  if (preview.status === "active") {
    return artifactPreviewResponse(artifact.id, preview);
  }
  if (preview.status === "unsupported") {
    return artifactPreviewResponse(artifact.id, {
      ...preview,
      errorCode: preview.errorCode ?? "unsupported_type"
    });
  }
  const errorCode =
    preview.status === "failed"
      ? preview.errorCode
      : preview.completedWithoutManifest
        ? "preview_manifest_missing"
        : undefined;
  if (
    errorCode &&
    isRetryableArtifactPreviewErrorCode(errorCode) &&
    detectArtifactPreviewSourceKind(artifact)
  ) {
    return queueArtifactPreview(store, artifact, true);
  }
  if (errorCode) {
    return failedArtifactPreviewResponse(artifact.id, errorCode);
  }
  return detectArtifactPreviewSourceKind(artifact)
    ? queueArtifactPreview(store, artifact)
    : readArtifactPreviewState(store, artifact);
}

async function queueArtifactPreview(
  store: ArtifactPreviewStore,
  artifact: ManagedArtifactRecord,
  replaceTerminal = false
): Promise<ArtifactPreviewResponse> {
  const queued = await store.enqueueArtifactPreviewJob({
    clientInstanceId: artifact.clientInstanceId,
    conversationId: artifact.conversationId,
    sourceArtifactId: artifact.id,
    sourceChecksum: artifact.checksum,
    sourceMimeType: artifact.mimeType,
    ...(replaceTerminal ? { replaceTerminal: true } : {})
  });
  return pendingArtifactPreviewResponse(artifact.id, queued.nextAttemptAt ?? queued.createdAt);
}

function artifactPreviewResponse(
  artifactId: string,
  preview: Exclude<ArtifactPreviewLifecycleState, { status: "missing" }>
): ArtifactPreviewResponse {
  if (preview.status === "ready") {
    const ready = asArtifactPreviewContractReady(preview);
    if (!ready) {
      return failedArtifactPreviewResponse(artifactId, "preview_manifest_missing");
    }
    return {
      status: "ready",
      artifactId,
      type: "image_pages",
      format: ready.format,
      ...(preview.pageCount ? { pageCount: preview.pageCount } : {}),
      ...(preview.pageCount && preview.pageCount > preview.pages.length ? { truncated: true } : {}),
      pages: ready.pages.map((page) => ({
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
  if (preview.status === "active") {
    return pendingArtifactPreviewResponse(artifactId, preview.queuedAt);
  }
  if (preview.status === "failed") {
    return failedArtifactPreviewResponse(artifactId, preview.errorCode);
  }
  return {
    status: "unsupported",
    artifactId,
    ...(preview.errorCode ? { errorCode: preview.errorCode } : {})
  };
}

function pendingArtifactPreviewResponse(
  artifactId: string,
  queuedAt: string
): ArtifactPreviewResponse {
  return {
    status: "pending",
    artifactId,
    queuedAt
  };
}

function failedArtifactPreviewResponse(
  artifactId: string,
  errorCode: string | undefined
): ArtifactPreviewResponse {
  return {
    status: "failed",
    artifactId,
    ...(errorCode ? { errorCode } : {}),
    ...(isRetryableArtifactPreviewErrorCode(errorCode) ? { retryable: true } : {})
  };
}
