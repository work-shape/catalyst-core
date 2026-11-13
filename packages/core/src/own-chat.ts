import type { CollaborationWorkspace } from "./collaboration-workspace";
import type { Conversation } from "./conversation";
import {
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity
} from "./identity";

// A person's own chat: what is theirs alone, a skill switched on for their chats
// (SCOPE-MYCHATS) or an agent of their Personal Workspace, is used only there.

/** The workspace of a chat, as far as whose own it is. */
type ChatWorkspace = { kind: CollaborationWorkspace["kind"]; personalUserId?: string | null };

/**
 * Whether no one but `person` reads the chat: one they created, in their own Personal Workspace
 * or private in a team, that names no other person (CHAT-SHARE), as for a personal Connection.
 * A chat others read, or one another person created, is not.
 */
export function chatReadOnlyBy(
  conversation: Pick<Conversation, "kind" | "createdByUserId" | "visibility" | "people">,
  workspace: ChatWorkspace | undefined,
  person: string
): boolean {
  return (
    conversation.kind === "chat" &&
    conversation.createdByUserId === person &&
    conversation.people.length === 0 &&
    workspace !== undefined &&
    (workspace.kind === "personal"
      ? workspace.personalUserId === person
      : conversation.visibility === "private")
  );
}

/**
 * Whether the caller acts as themself in an active chat, whoever else reads it: the person, neither
 * a service principal, a key nor an embedding host acting for them. What may be offered there
 * shows nobody anything of theirs, such as the proposal of their own MCP server (PMCP-CHAT-2).
 */
export function actsAsThemselfInChat(
  user: AuthenticatedIdentity,
  conversation: Pick<Conversation, "kind" | "status">
): boolean {
  return (
    !isAuthenticatedServicePrincipal(user) &&
    user.delegatedActor === undefined &&
    user.keyScopes === undefined &&
    conversation.kind === "chat" &&
    conversation.status === "active"
  );
}

/**
 * Whether the caller may use what is theirs alone in this chat: the person themself, neither a
 * service principal, a key nor an embedding host acting for them, in an active chat only they
 * read.
 */
export function mayUseOwnInChat(
  user: AuthenticatedIdentity,
  conversation: Pick<Conversation, "kind" | "status" | "createdByUserId" | "visibility" | "people">,
  workspace: ChatWorkspace | undefined
): boolean {
  if (isAuthenticatedServicePrincipal(user)) return false;
  return (
    actsAsThemselfInChat(user, conversation) &&
    chatReadOnlyBy(conversation, workspace, getSubjectUserId(user))
  );
}
