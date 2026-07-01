import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, asManagedArtifactId, requireAuthScope } from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import { authenticateRequest, getConversationId } from "../request-context";
import type { ChatServerOptions } from "../types";

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
