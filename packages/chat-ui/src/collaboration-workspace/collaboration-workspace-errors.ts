import type { ApiErrorCode } from "@vivd-catalyst/api-client";
import type { TranslationKey } from "../i18n";
import { apiErrorCode, apiErrorStatus } from "../workspace-utils";

/**
 * The workspace API answers with English prose, so the UI maps the stable
 * `AppError` code plus the action that produced it onto localized copy instead
 * of matching server strings. Older responses without a code fall back to their
 * HTTP status.
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
  | "declineRequest"
  | "moveConversation"
  | "deleteCollaborationWorkspace";

export function collaborationWorkspaceErrorKey(
  action: CollaborationWorkspaceAction,
  error: unknown
): TranslationKey {
  const code = apiErrorCode(error) ?? statusFallbackCode(apiErrorStatus(error));

  switch (code) {
    case "UNAUTHENTICATED":
      return "collaborationWorkspaceErrorSignedOut";
    case "FORBIDDEN":
      // A move only fails on membership, and naming the missing membership would
      // leak whether the target workspace exists.
      return action === "moveConversation"
        ? "collaborationWorkspaceErrorMoveUnavailable"
        : "collaborationWorkspaceErrorNotPermitted";
    case "NOT_FOUND":
      if (action === "moveConversation") {
        return "collaborationWorkspaceErrorMoveUnavailable";
      }
      return action === "approveRequest" || action === "declineRequest"
        ? "collaborationWorkspaceErrorRequestGone"
        : "collaborationWorkspaceErrorNotFound";
    case "CONFLICT":
      if (action === "moveConversation") {
        return "collaborationWorkspaceErrorConversationBusy";
      }
      if (action === "deleteCollaborationWorkspace") {
        return "collaborationWorkspaceErrorCollaborationWorkspaceBusy";
      }
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
    case "BAD_REQUEST":
    case "VALIDATION_FAILED":
      if (action === "deleteCollaborationWorkspace") {
        return "collaborationWorkspaceErrorNameMismatch";
      }
      if (action === "addMember") {
        return "collaborationWorkspaceErrorInvitationsUnavailable";
      }
      return "collaborationWorkspaceErrorInvalid";
    default:
      return "collaborationWorkspaceErrorUnexpected";
  }
}

/** Only the statuses the workspace surfaces used before codes existed. */
function statusFallbackCode(status: number | undefined): ApiErrorCode | undefined {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 422:
      return "VALIDATION_FAILED";
    default:
      return undefined;
  }
}
