import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, getSubjectUserId, requireAuthScope } from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversation-workflow";
import { authenticateRequest, getConversationId } from "../request-context";
import type { ChatServerOptions } from "../types";
import type { UploadFileContent } from "../attachments";

export function registerDraftAttachmentRoutes(
  app: FastifyInstance,
  options: ChatServerOptions
): void {
  const conversations = new ConversationWorkflow(options);

  app.get(apiOperations.listDraftAttachments.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:read");
    const conversationId = getConversationId(request);
    await conversations.requireConversationAccess(conversationId, user);
    return attachments(options).listDraftAttachments(conversationId);
  });

  app.post(apiOperations.uploadDraftAttachment.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    const conversationId = getConversationId(request);
    await conversations.requireConversationAccess(conversationId, user);
    const file = await request.file();
    if (!file) {
      throw new AppError("VALIDATION_FAILED", "A file upload is required");
    }
    const staged = await stageMultipartFile(file.file);
    try {
      if (file.file.truncated) {
        throw new AppError("VALIDATION_FAILED", "File exceeds the configured upload size limit");
      }
      // Receiving the body can take minutes. Check again before any bytes are stored, so that
      // a Conversation deleted in the meantime does not receive objects nothing cleans up.
      await conversations.requireConversationAccess(conversationId, user);
      const service = attachments(options);
      const { attachment, outcome } = await service.uploadDraftAttachment({
        conversationId,
        ownerUserId: getSubjectUserId(user),
        filename: file.filename,
        mimeType: file.mimetype,
        content: staged.content
      });
      return {
        attachment,
        attachments: await service.listDraftAttachments(conversationId),
        outcome
      };
    } finally {
      await staged.cleanup();
    }
  });

  app.post(apiOperations.retryDraftAttachment.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    const conversationId = getConversationId(request);
    await conversations.requireConversationAccess(conversationId, user);
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

  app.delete(apiOperations.deleteDraftAttachment.path, async (request) => {
    const { user } = await authenticateRequest(options, request);
    requireAuthScope(user, "conversation:write");
    const conversationId = getConversationId(request);
    await conversations.requireConversationAccess(conversationId, user);
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

async function stageMultipartFile(stream: NodeJS.ReadableStream): Promise<{
  content: UploadFileContent;
  cleanup(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "vivd-catalyst-upload-"));
  const path = join(directory, "upload");
  const checksum = createHash("sha256");
  let byteSize = 0;
  let header = Buffer.alloc(0);
  const inspect = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteSize += bytes.byteLength;
      checksum.update(bytes);
      if (header.byteLength < 16) {
        header = Buffer.concat([header, bytes.subarray(0, 16 - header.byteLength)]);
      }
      callback(null, bytes);
    }
  });
  try {
    await pipeline(stream, inspect, createWriteStream(path));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    content: {
      byteSize,
      checksum: checksum.digest("hex"),
      headerBytes: header,
      openStream: () => createReadStream(path)
    },
    cleanup: () => rm(directory, { recursive: true, force: true })
  };
}
