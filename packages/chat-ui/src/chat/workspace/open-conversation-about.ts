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

/** What a conversation is about and the workspace it belongs to, as its thread says. */
export interface ThreadAbout {
  subject: { kind: string; name: string } | undefined;
  collaborationWorkspaceId: string;
}

/**
 * The conversation in the dock that "Edit with the agent" opens again rather than making a
 * new one: the dock already holds a conversation about the same asset in the same workspace.
 * An asset of the same kind and name in another workspace is another asset. Where a prompt
 * comes along, it stands in that composer only when the composer is empty or holds the same
 * text, so nothing the person typed is replaced; otherwise a new conversation takes the prompt.
 */
export function dockConversationToReuse({
  dockConversationId,
  dock,
  subject,
  workspaceId,
  prompt,
  draftText
}: {
  dockConversationId: string | undefined;
  /** What the dock's conversation is about and where, once its thread has loaded. */
  dock: ThreadAbout | undefined;
  subject: { kind: string; name: string };
  /** The workspace the asset is opened in. */
  workspaceId: string;
  prompt: string | undefined;
  /** What the dock's composer holds. */
  draftText: string;
}): string | undefined {
  if (
    dockConversationId === undefined ||
    dock === undefined ||
    dock.subject === undefined ||
    dock.collaborationWorkspaceId !== workspaceId ||
    dock.subject.kind !== subject.kind ||
    dock.subject.name !== subject.name
  ) {
    return undefined;
  }
  if (prompt !== undefined && draftText.trim() !== "" && draftText !== prompt) {
    return undefined;
  }
  return dockConversationId;
}
