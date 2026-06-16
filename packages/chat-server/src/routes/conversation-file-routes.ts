import type { FastifyInstance } from "fastify";
import { AppError } from "@vivd-catalyst/core";
import { isSupportedImageMimeType } from "@vivd-catalyst/document-processing";
import { ConversationWorkflow } from "../conversation-workflow";
import { authenticateRequest, getConversationId } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConversationFileRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  app.get("/api/conversations/:conversationId/files/:fileId/content", async (request, reply) => {
    const { user } = await authenticateRequest(options, request);
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    const file = await documentPreprocessing(options).readConversationFile({
      conversationId,
      fileId: getFileId(request)
    });
    if (!file.mimeType || !isSupportedImageMimeType(file.mimeType)) {
      throw new AppError("VALIDATION_FAILED", "Only image attachments can be displayed inline");
    }
    return reply
      .header("content-type", file.mimeType)
      .header("content-length", String(file.bytes.byteLength))
      .header("cache-control", "private, max-age=60")
      .header("content-disposition", `inline; filename="${escapeHeaderValue(file.filename)}"`)
      .send(Buffer.from(file.bytes));
  });
}

function documentPreprocessing(options: ChatServerOptions) {
  if (!options.documentPreprocessing) {
    throw new AppError("VALIDATION_FAILED", "Document preprocessing is not configured");
  }
  return options.documentPreprocessing;
}

function getFileId(request: { params: unknown }): string {
  const params = request.params as { fileId?: string };
  if (!params?.fileId) {
    throw new AppError("BAD_REQUEST", "Missing file id");
  }
  return params.fileId;
}

function escapeHeaderValue(value: string): string {
  return value.replaceAll(/["\r\n]/gu, "_");
}
