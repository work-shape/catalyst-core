import type { LocaleCode } from "@vivd-catalyst/api-client";
import type { SendBlock } from "../assistant/send-block";
import { createTranslationContext } from "../i18n";

/**
 * A first message needs a workspace so the page can open the conversation it creates. Only the
 * wait for that workspace is a loading block; attachments and a failed load refuse the send.
 */
export function workspaceSendBlock(input: {
  attachmentBlockedReason: string | undefined;
  selectedConversationId: string | undefined;
  collaborationWorkspacesAvailable: boolean;
  activeCollaborationWorkspaceId: string | undefined;
  loading: boolean;
  loadFailed: boolean;
  /** The list arrived with a workspace in it; the page opens one right after. */
  workspacesListed: boolean;
  locale: LocaleCode;
}): SendBlock | undefined {
  if (input.attachmentBlockedReason !== undefined) {
    return { reason: input.attachmentBlockedReason, loading: false };
  }
  if (
    input.selectedConversationId ||
    !input.collaborationWorkspacesAvailable ||
    input.activeCollaborationWorkspaceId
  ) {
    return undefined;
  }
  // Between the arrival of the list and the redirect into one of its workspaces nothing failed.
  const loading = !input.loadFailed && (input.loading || input.workspacesListed);
  return {
    reason: createTranslationContext(input.locale).t(
      loading ? "collaborationWorkspaceLoading" : "collaborationWorkspaceLoadFailed"
    ),
    loading
  };
}
