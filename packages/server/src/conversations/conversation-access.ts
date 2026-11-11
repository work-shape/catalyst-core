import {
  AppError,
  getSubjectUserId,
  inProjectAudience,
  isAppError,
  type AuthenticatedUser,
  type CollaborationWorkspace,
  type Conversation,
  type ConversationId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { requireWorkspaceToWorkIn } from "../workspaces/workspace-access";

/**
 * The single read check of a Conversation: it is active, the user reaches its Collaboration
 * Workspace, and a private one is its author's and the people they named. One in a project
 * is read by the project's audience. A holder of a bundle who is no member reaches only their
 * own private ones outside any project. A named person who is no member reads that one chat
 * and nothing else of the workspace (ADR-0034). Every refusal reads as a Conversation that
 * does not exist, so an answer never tells a closed one from one that never was.
 */
export async function requireConversationAccess(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  conversationId: ConversationId,
  user: AuthenticatedUser
): Promise<Conversation> {
  return (await requireConversationReach(options, conversationId, user)).conversation;
}

/**
 * `requireConversationAccess`, saying how the user reaches the chat: `outside` for a named
 * person who neither is a member of its workspace nor holds a bundle there (CHAT-SHARE-6). Such
 * a reader reaches the workspace only through this conversation, and their turns run with
 * their own rights as a non-member: only the conversation's own paths take this answer.
 */
export async function requireConversationReach(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  conversationId: ConversationId,
  user: AuthenticatedUser
): Promise<{ conversation: Conversation; outside: boolean }> {
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
    const { outside } = await requireConversationReach(
      options,
      conversation.parentConversationId,
      user
    );
    return { conversation, outside };
  }
  const userId = getSubjectUserId(user);
  let member: boolean;
  try {
    ({ member } = await requireWorkspaceToWorkIn(
      options,
      user,
      conversation.collaborationWorkspaceId
    ));
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") {
      // A named person reads the chat, member or not: a private chat outside any project, which
      // only a Shared Workspace's chat can name people on (CHAT-SHARE-6).
      if (
        conversation.kind === "chat" &&
        conversation.visibility === "private" &&
        conversation.projectId === undefined &&
        conversation.people.some((person) => person.userId === userId)
      ) {
        return { conversation, outside: true };
      }
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
    return { conversation, outside: false };
  }
  const ownPrivate =
    conversation.visibility === "private" && conversation.createdByUserId === userId;
  // A person its creator named reads it too, and nobody else does (CHAT-SHARE). A holder of a
  // bundle who is no member is named like anyone outside the workspace: their own rights.
  const named = conversation.people.some((person) => person.userId === userId);
  if (conversation.visibility === "private" ? !ownPrivate && !named : !member) {
    throw new AppError("NOT_FOUND", "Conversation is not available");
  }
  return { conversation, outside: !member && !ownPrivate };
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
    throw runThreadIsReadOnly();
  }
  return conversation;
}

/** `requireChatConversationAccess`, saying whether the user reads the chat from outside. */
export async function requireChatConversationReach(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  conversationId: ConversationId,
  user: AuthenticatedUser
): Promise<{ conversation: Conversation; outside: boolean }> {
  const reach = await requireConversationReach(options, conversationId, user);
  if (reach.conversation.kind === "run_thread") {
    throw runThreadIsReadOnly();
  }
  return reach;
}

/**
 * The workspace of a conversation the caller passed `requireConversationAccess` for. An in-chat
 * path reaches the workspace only through the conversation (CHAT-SHARE-6): it asks no
 * membership, which a named person outside the workspace does not hold.
 */
export async function workspaceOfConversation(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  conversation: Pick<Conversation, "collaborationWorkspaceId">
): Promise<CollaborationWorkspace> {
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    conversation.collaborationWorkspaceId
  );
  if (!workspace) throw new AppError("NOT_FOUND", "Conversation is not available");
  return workspace;
}

/**
 * Whether the user, who passed `requireConversationAccess` for this conversation, reads it from
 * outside its workspace: no member and no holder of a bundle there (CHAT-SHARE-6).
 */
export async function readsFromOutside(
  options: Pick<ChatServerOptions, "stores" | "clientInstanceId">,
  conversation: Pick<Conversation, "collaborationWorkspaceId">,
  user: AuthenticatedUser
): Promise<boolean> {
  try {
    await requireWorkspaceToWorkIn(options, user, conversation.collaborationWorkspaceId);
    return false;
  } catch (error) {
    if (isAppError(error) && error.code === "NOT_FOUND") return true;
    throw error;
  }
}

/** The refusal of a write to a run thread. An agent reads it too, so it says what it refuses. */
export function runThreadIsReadOnly(): AppError {
  return new AppError(
    "CONFLICT",
    "A subagent's thread is read only",
    { reason: "run_thread" },
    { exposeMessage: true }
  );
}
