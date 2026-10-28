import {
  AppError,
  getSubjectUserId,
  inProjectAudience,
  isAppError,
  type AuthenticatedUser,
  type Conversation,
  type ConversationId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceToWorkIn } from "../workspaces/workspace-access";

/**
 * The single read check of a Conversation: it is active, the user reaches its Collaboration
 * Workspace, and a private one is its author's. One in a project is read by the project's
 * audience. A holder of a bundle who is no member reaches only their own private ones outside
 * any project. Every refusal reads as a Conversation that does not exist, so an
 * answer never tells a closed one from one that never was.
 */
export async function requireConversationAccess(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  conversationId: ConversationId,
  user: AuthenticatedUser
): Promise<Conversation> {
  const conversation = await options.stores.conversations.getConversation(
    options.clientInstanceId,
    conversationId
  );
  if (!conversation || conversation.status !== "active") {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  // A subagent's run thread has no audience of its own: it is read through its root (CR-1).
  // Another run thread, an agent step's, is read through its Workflow run only.
  if (conversation.kind === "run_thread") {
    if (!conversation.parentConversationId) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    await requireConversationAccess(options, conversation.parentConversationId, user);
    return conversation;
  }
  let member: boolean;
  try {
    ({ member } = await requireWorkspaceToWorkIn(
      options,
      user,
      conversation.collaborationWorkspaceId
    ));
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    throw error;
  }
  // In a project the project's audience decides, not the conversation's own visibility, which
  // its writers keep equal to it (PRJ-1). A project is reached through membership alone: a
  // holder of a bundle who is no member reads none of its conversations.
  if (conversation.projectId !== undefined) {
    const project = member
      ? await options.stores.projects.getProject({
          clientInstanceId: options.clientInstanceId,
          projectId: conversation.projectId
        })
      : undefined;
    if (
      !project ||
      project.collaborationWorkspaceId !== conversation.collaborationWorkspaceId ||
      !inProjectAudience(project, getSubjectUserId(user))
    ) {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    return conversation;
  }
  const ownPrivate =
    conversation.visibility === "private" &&
    conversation.createdByUserId === getSubjectUserId(user);
  if (member ? conversation.visibility === "private" && !ownPrivate : !ownPrivate) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  return conversation;
}

/**
 * The access check of a write to a Conversation that only a chat Conversation takes: a new
 * message or run, a title, a subject, a move or a deletion. A subagent's run thread is read
 * only; it changes with its root.
 */
export async function requireChatConversationAccess(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  conversationId: ConversationId,
  user: AuthenticatedUser
): Promise<Conversation> {
  const conversation = await requireConversationAccess(options, conversationId, user);
  if (conversation.kind === "run_thread") {
    throw new AppError("CONFLICT", "A subagent's thread is read only", { reason: "run_thread" });
  }
  return conversation;
}
