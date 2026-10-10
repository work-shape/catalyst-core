import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, getSubjectUserId, type JsonObject } from "@vivd-catalyst/core";
import { ConversationWorkflow } from "../conversations/conversation-workflow";
import type { Route } from "../http/route";
import { conversationIdParam, requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";
import type { UploadFileContent } from "../attachments";

export function registerDraftAttachmentRoutes(route: Route, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  route(apiOperations["conversations.draft_attachments.list"], async ({ user, params }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    return listed(await attachments(options).listDraftAttachments(conversationId));
  });

  route(
    apiOperations["conversations.draft_attachments.upload"],
    async ({ user, params, request }) => {
      const conversationId = conversationIdParam(params);
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
          attachment: withoutNullError(attachment),
          attachments: listed(await service.listDraftAttachments(conversationId)),
          outcome
        };
      } finally {
        await staged.cleanup();
      }
    }
  );

  route(apiOperations["conversations.draft_attachments.retry"], async ({ user, params }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    const service = attachments(options);
    const attachment = await service.retryDraftAttachment({
      conversationId,
      attachmentId: attachmentIdParam(params)
    });
    return {
      attachment: withoutNullError(attachment),
      attachments: listed(await service.listDraftAttachments(conversationId))
    };
  });

  route(apiOperations["conversations.draft_attachments.delete"], async ({ user, params }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    return withoutNullError(
      await attachments(options).deleteDraftAttachment({
        conversationId,
        attachmentId: attachmentIdParam(params)
      })
    );
  });
}

function attachments(options: ChatServerOptions) {
  if (!options.attachments) {
    throw new AppError("VALIDATION_FAILED", "Attachment handling is not configured");
  }
  return options.attachments;
}

// The stored record may carry `null` for a cleared error; the contract leaves the field out.
function withoutNullError<Attachment extends { error?: JsonObject | null }>(
  attachment: Attachment
) {
  return { ...attachment, error: attachment.error ?? undefined };
}

function listed<Attachment extends { error?: JsonObject | null }>(attachments: Attachment[]) {
  return attachments.map(withoutNullError);
}

function attachmentIdParam(params: { attachmentId: string }): string {
  return requirePathParam(params.attachmentId, "Missing attachment id");
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
