import type { LocaleCode } from "@vivd-catalyst/api-client";
import { createTranslationContext } from "../i18n";

/** A first message needs a workspace so the page can open the conversation it creates. */
export function workspaceSendBlockedReason(input: {
  attachmentBlockedReason: string | undefined;
  selectedConversationId: string | undefined;
  collaborationWorkspacesAvailable: boolean;
  activeCollaborationWorkspaceId: string | undefined;
  loading: boolean;
  loadFailed: boolean;
  locale: LocaleCode;
}): string | undefined {
  if (input.attachmentBlockedReason !== undefined) {
    return input.attachmentBlockedReason;
  }
  if (
    input.selectedConversationId ||
    !input.collaborationWorkspacesAvailable ||
    input.activeCollaborationWorkspaceId
  ) {
    return undefined;
  }
  return createTranslationContext(input.locale).t(
    input.loading && !input.loadFailed
      ? "collaborationWorkspaceLoading"
      : "collaborationWorkspaceLoadFailed"
  );
}
