import { Readable } from "node:stream";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createHash } from "node:crypto";
import {
  AppError,
  getSubjectUserId,
  type ActorAccess,
  type AuthenticatedUser,
  type CollaborationWorkspaceId,
  type Conversation,
  type JsonObject,
  type LocaleCode
} from "@work-shape/catalyst-core";
import { ConversationWorkflow } from "../conversations/conversation-service";
import { readMultipartFile, stageMultipartFile } from "../http/multipart-upload";
import type { Route } from "../http/route";
import { conversationIdParam, requirePathParam, resolveRequestLocale } from "./request-context";
import { getWorkspaceAssetSnapshot } from "../workspaces/agent-availability";
import { ProjectFileService } from "../projects/project-files";
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
        const projectFiles = new ProjectFileService(options);
        // In a chat of a project the upload lands in the project's folder too (PRJ-2). Room is
        // asked first, so a full folder refuses the upload before anything is stored.
        if (!(await projectFiles.roomFor(conversation, staged.content.byteSize))) {
          throw new AppError(
            "VALIDATION_FAILED",
            "The project's folder has no room for this file",
            { reason: "project_files_full" },
            { exposeMessage: true }
          );
        }
        const workspaceToolsAvailable = await workspaceToolsFor(
          options,
          conversations,
          user,
          access,
          conversation.collaborationWorkspaceId,
          query.agentName
        );
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
        const projectFile =
          conversation.projectId !== undefined && attachment.status !== "failed"
            ? await projectFiles.landUpload(conversation, user, {
                filename: file.filename,
                ...(file.mimetype ? { mimeType: file.mimetype } : {}),
                bytes: await readAll(staged.content.openStream())
              })
            : undefined;
        return {
          attachment: withoutNullError(attachment),
          attachments: listed(await service.listDraftAttachments(conversationId)),
          outcome,
          ...(projectFile ? { projectFile } : {})
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

/**
 * Whether the agent chosen for the next message has the workspace tools, so that any file may
 * come along: the server checks the agent in the conversation's workspace.
 */
async function workspaceToolsFor(
  options: ChatServerOptions,
  conversations: ConversationWorkflow,
  user: AuthenticatedUser,
  access: ActorAccess,
  collaborationWorkspaceId: CollaborationWorkspaceId,
  agentName: string | undefined
): Promise<boolean> {
  if (agentName === undefined) return false;
  const workspace = await conversations.resolveTargetWorkspace(user, collaborationWorkspaceId);
  const assets = await getWorkspaceAssetSnapshot(options, workspace, access);
  const agent = assets.agents.find((candidate) => candidate.name === agentName);
  if (!agent) throw new AppError("NOT_FOUND", "The selected agent is not available");
  return (
    options.config.executionWorkspaces?.enabled === true &&
    ["workspace.import_files", "workspace.exec"].every((tool) =>
      (agent.toolNames ?? []).includes(tool)
    )
  );
}

/**
 * A draft attachment of bytes the server holds, such as a project file for "Add from project"
 * (PRJ-2): the same path as an upload from the person's device, after the caller's checks.
 */
export async function addDraftAttachmentFromBytes(
  options: ChatServerOptions,
  input: {
    conversation: Conversation;
    user: AuthenticatedUser;
    access: ActorAccess;
    agentName?: string;
    locale?: LocaleCode;
    filename: string;
    mimeType?: string;
    bytes: Uint8Array;
  }
) {
  const service = attachments(options);
  if (input.bytes.byteLength > service.maxFileBytes) {
    throw new AppError(
      "VALIDATION_FAILED",
      "File exceeds the configured upload size limit",
      { reason: "attachment_too_large" },
      { exposeMessage: true }
    );
  }
  const workspaceToolsAvailable = await workspaceToolsFor(
    options,
    new ConversationWorkflow(options),
    input.user,
    input.access,
    input.conversation.collaborationWorkspaceId,
    input.agentName
  );
  const bytes = input.bytes;
  const { attachment, outcome } = await service.uploadDraftAttachment({
    conversationId: input.conversation.id,
    workspaceToolsAvailable,
    ...(input.locale ? { locale: input.locale } : {}),
    ownerUserId: getSubjectUserId(input.user),
    filename: input.filename,
    ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    content: {
      byteSize: bytes.byteLength,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      headerBytes: bytes.slice(0, 8192),
      // One chunk, already read.
      openStream: () => Readable.from([bytes])
    }
  });
  return {
    attachment: withoutNullError(attachment),
    attachments: listed(await service.listDraftAttachments(input.conversation.id)),
    outcome
  };
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
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
