import { AppError } from "./errors";
import {
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type AuthenticatedUser
} from "./identity";

// Named people on one private chat (CHAT-SHARE, `chat-sharing.md`). The creator of a private
// chat in a Shared Workspace, outside any project, names members of that workspace; each reads
// and writes in the chat while a member. Nobody else gains anything: a Workspace Owner, Admin
// or the superadmin still does not see it. Only the creator changes who reads it, from their
// own session: never an agent, a key, an embedding host or another person named.

/** The most people one chat names. More is a team chat or a project. */
export const CONVERSATION_PEOPLE_MAX = 20;

/**
 * Why adding a person to a chat, or taking one off, was refused: `details.reason` of the
 * refusal, one stable code each, which the interface words from one map.
 */
export const CONVERSATION_SHARE_REFUSALS = [
  // The share guard (section 3.2).
  "personal_conversation_private",
  "data_store_conversation_private",
  "subject_conversation_private",
  "conversation_in_project",
  "personal_workspace_conversation",
  // Who may share what, and whom.
  "conversation_not_shareable",
  "share_creator_only",
  "share_first_party_only",
  "share_person_unavailable",
  "share_people_limit",
  // The chat changed between the checks and the lock: the call may be made again.
  "share_checks_changed",
  // Removing or leaving while that person's run still goes.
  "person_run_active"
] as const;

export type ConversationShareRefusal = (typeof CONVERSATION_SHARE_REFUSALS)[number];

/** Why `conversation.person_removed` was recorded. */
export type ConversationPersonRemovedReason = "removed" | "left" | "membership_ended" | "moved";

/**
 * A refusal of a share, a removal or a leave, with its stable reason and any id it names.
 * The message is for a person reading an API answer; the interface words the reason itself.
 */
export function conversationShareRefusal(
  reason: ConversationShareRefusal,
  message: string,
  details: Record<string, string> = {},
  code: "VALIDATION_FAILED" | "FORBIDDEN" | "CONFLICT" = "VALIDATION_FAILED"
): AppError {
  return new AppError(code, message, { ...details, reason }, { exposeMessage: true });
}

/**
 * Whether the caller is the person in their own session: neither a service principal, a key, a
 * delegated actor nor an embedding host acting for them. Only such a caller changes who reads
 * a chat, as only such a caller uses what is theirs alone (`mayUseOwnInChat`).
 */
export function isPersonInOwnSession(
  identity: AuthenticatedIdentity
): identity is AuthenticatedUser {
  return (
    !isAuthenticatedServicePrincipal(identity) &&
    identity.delegatedActor === undefined &&
    identity.keyScopes === undefined
  );
}

/** The refusal of a share or removal that is not the person's own step in their own session. */
export function shareFirstPartyOnlyError(): AppError {
  return conversationShareRefusal(
    "share_first_party_only",
    "Only the person, signed in themselves, changes who reads a chat: never an agent, a key or an embedding host",
    {},
    "FORBIDDEN"
  );
}

/** A chat with named people does not enter a project: its readers would differ from the project's. */
export function conversationHasPeopleError(): AppError {
  return new AppError(
    "VALIDATION_FAILED",
    "This chat is shared with named people. Remove them first, or share the project",
    { reason: "conversation_has_people" },
    { exposeMessage: true }
  );
}
