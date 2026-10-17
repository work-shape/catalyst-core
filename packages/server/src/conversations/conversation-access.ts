import {
  AppError,
  getSubjectUserId,
  isAppError,
  type AuthenticatedUser,
  type Conversation,
  type ConversationId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceAccess } from "../workspaces/workspace-access";

/**
 * The single read check of a Conversation: it is active, the user reaches its Collaboration
 * Workspace, and a private one is its author's. Every refusal reads as a Conversation that
 * does not exist, so an answer never tells a closed one from one that never was.
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
  try {
    await requireWorkspaceAccess(options, user, conversation.collaborationWorkspaceId);
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") {
      throw new AppError("NOT_FOUND", "Conversation is not available");
    }
    throw error;
  }
  if (
    conversation.visibility === "private" &&
    conversation.createdByUserId !== getSubjectUserId(user)
  ) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  return conversation;
}
