import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import { authenticateRequest, getConversationId } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerDraftAttachmentRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  app.get("/api/conversations/:conversationId/draft-attachments", async (request) => {
    const { user } = await authenticateRequest(options, request);
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    return attachments(options).listDraftAttachments(conversationId);
  });

  app.post("/api/conversations/:conversationId/draft-attachments", async (request) => {
    const { user } = await authenticateRequest(options, request);
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    const file = await request.file();
    if (!file) {
      throw new AppError("VALIDATION_FAILED", "A file upload is required");
    }
    const bytes = await readMultipartFile(file.file);
    const service = attachments(options);
    const attachment = await service.uploadDraftAttachment({
      conversationId,
      ownerUserId: user.id,
      filename: file.filename,
      mimeType: file.mimetype,
      bytes
    });
    return {
      attachment,
      attachments: await service.listDraftAttachments(conversationId)
    };
  });

  app.post("/api/conversations/:conversationId/draft-attachments/:attachmentId/retry", async (request) => {
    const { user } = await authenticateRequest(options, request);
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    const service = attachments(options);
    const attachment = await service.retryDraftAttachment({
      conversationId,
      attachmentId: getAttachmentId(request)
    });
    return {
      attachment,
      attachments: await service.listDraftAttachments(conversationId)
    };
  });

  app.delete("/api/conversations/:conversationId/draft-attachments/:attachmentId", async (request) => {
    const { user } = await authenticateRequest(options, request);
    const conversationId = getConversationId(request);
    await conversations.requireOwnedActiveConversation(conversationId, user);
    return attachments(options).deleteDraftAttachment({
      conversationId,
      attachmentId: getAttachmentId(request)
    });
  });
}

function attachments(options: ChatServerOptions) {
  if (!options.attachments) {
    throw new AppError("VALIDATION_FAILED", "Attachment handling is not configured");
  }
  return options.attachments;
}

function getAttachmentId(request: FastifyRequest): string {
  const params = request.params as { attachmentId?: string };
  if (!params?.attachmentId) {
    throw new AppError("BAD_REQUEST", "Missing attachment id");
  }
  return params.attachmentId;
}

async function readMultipartFile(stream: AsyncIterable<Buffer | Uint8Array>): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
