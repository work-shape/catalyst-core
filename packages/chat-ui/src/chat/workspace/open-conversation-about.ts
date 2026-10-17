import { assetPageRoute } from "../conversation/subject-run";
import type { WorkspaceDock } from "./use-workspace-dock";
import { WORKSPACE_AUTH_SCOPE } from "./workspace-chat-state";
import type { useWorkspaceDraftController } from "./workspace-drafts";
import type { useWorkspaceRouteState } from "./workspace-ui-state";

/**
 * Opens a conversation the instance just made about an asset: the asset's page with the
 * conversation in the dock beside it, or the conversation itself for an asset without a page.
 * `prompt` stands in its composer, unsent.
 */
export function openConversationAbout(
  conversation: { id: string; collaborationWorkspaceId: string },
  subject: { kind: string; name: string },
  prompt: string | undefined,
  {
    routeState,
    dock,
    draftController
  }: {
    routeState: Pick<ReturnType<typeof useWorkspaceRouteState>, "showConversation">;
    dock: Pick<WorkspaceDock, "openPage">;
    draftController: Pick<ReturnType<typeof useWorkspaceDraftController>, "setDraft">;
  }
): void {
  if (prompt !== undefined) {
    draftController.setDraft(
      { authScope: WORKSPACE_AUTH_SCOPE, conversationId: conversation.id },
      prompt
    );
  }
  const page = assetPageRoute(subject, conversation.collaborationWorkspaceId);
  if (page === undefined) {
    routeState.showConversation(conversation.collaborationWorkspaceId, conversation.id);
  } else {
    dock.openPage(page, conversation.id);
  }
}
