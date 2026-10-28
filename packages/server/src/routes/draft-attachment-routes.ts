import { apiOperations } from "@work-shape/catalyst-api-contract";
import { AppError, getSubjectUserId, type JsonObject } from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import { readMultipartFile, stageMultipartFile } from "../http/multipart-upload";
import type { Route } from "../http/route";
import { conversationIdParam, requirePathParam, resolveRequestLocale } from "./request-context";
import { getWorkspaceAssetSnapshot } from "../workspaces/agent-availability";
import type { ChatServerOptions } from "../types";

export function registerDraftAttachmentRoutes(route: Route, options: ChatServerOptions): void {
  const conversations = new ConversationWorkflow(options);

  route(apiOperations["conversations.draft_attachments.list"], async ({ user, params }) => {
    const conversationId = conversationIdParam(params);
    await conversations.requireConversationAccess(conversationId, user);
    return listed(await attachments(options).listDraftAttachments(conversationId));
  });

  route(
    apiOperations["conversations.draft_attachments.upload"],
    async ({ user, access, params, query, request }) => {
      const conversationId = conversationIdParam(params);
      await conversations.requireConversationAccess(conversationId, user);
      const file = await readMultipartFile(request);
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
        const conversation = await conversations.requireConversationAccess(conversationId, user);
        let workspaceToolsAvailable = false;
        if (query.agentName !== undefined) {
          const workspace = await conversations.resolveTargetWorkspace(
            user,
            conversation.collaborationWorkspaceId
          );
          const assets = await getWorkspaceAssetSnapshot(options, workspace, access);
          const agent = assets.agents.find((candidate) => candidate.name === query.agentName);
          if (!agent) throw new AppError("NOT_FOUND", "The selected agent is not available");
          workspaceToolsAvailable =
            options.config.executionWorkspaces?.enabled === true &&
            ["workspace.import_files", "workspace.exec"].every((tool) =>
              (agent.toolNames ?? []).includes(tool)
            );
        }
        const service = attachments(options);
        const { attachment, outcome } = await service.uploadDraftAttachment({
          conversationId,
          workspaceToolsAvailable,
          locale: resolveRequestLocale(options, request),
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
