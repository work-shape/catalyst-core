import type { TranslationKey } from "../i18n";
import { apiErrorStatus } from "../workspace-utils";

/**
 * The workspace API answers with English prose today; stable error codes arrive
 * with a later phase. Until then the UI maps HTTP status plus the action that
 * produced it onto localized copy instead of matching server strings.
 */
export type CollaborationWorkspaceAction =
  | "create"
  | "update"
  | "addMember"
  | "changeRole"
  | "removeMember"
  | "leave"
  | "requestAccess"
  | "approveRequest"
  | "declineRequest";

export function collaborationWorkspaceErrorKey(
  action: CollaborationWorkspaceAction,
  error: unknown
): TranslationKey {
  const status = apiErrorStatus(error);

  if (status === 401) {
    return "collaborationWorkspaceErrorSignedOut";
  }
  if (status === 403) {
    return "collaborationWorkspaceErrorNotPermitted";
  }
  if (status === 404) {
    return action === "approveRequest" || action === "declineRequest"
      ? "collaborationWorkspaceErrorRequestGone"
      : "collaborationWorkspaceErrorNotFound";
  }
  if (status === 409) {
    if (action === "removeMember" || action === "leave" || action === "changeRole") {
      return "collaborationWorkspaceErrorLastOwner";
    }
    if (action === "requestAccess") {
      return "collaborationWorkspaceErrorRequestPending";
    }
    if (action === "approveRequest") {
      return "collaborationWorkspaceErrorInvitationsUnavailable";
    }
    return "collaborationWorkspaceErrorAlreadyMember";
  }
  if (status === 400 || status === 422) {
    if (action === "addMember") {
      return "collaborationWorkspaceErrorInvitationsUnavailable";
    }
    return "collaborationWorkspaceErrorInvalid";
  }

  return "collaborationWorkspaceErrorUnexpected";
}
