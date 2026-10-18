import type { ApiClient, LocaleCode, Message } from "@work-shape/catalyst-api-client";
import type { useWorkspaceCacheActions } from "../../shared/api/workspace-queries";
import { createTranslationContext } from "../../shared/i18n";
import type { ApprovalRevisionRunInput } from "../approvals/approval-revision-host";
import {
  createRunIdempotencyKey,
  startProductConversationRun
} from "../assistant/product-run-transport";
import { openConversationAbout } from "./open-conversation-about";
import type { useConversationListRefresh } from "./use-conversation-list-refresh";
import type { WorkspaceDock } from "./use-workspace-dock";
import { WORKSPACE_AUTH_SCOPE, isAbandonedDraftConversation } from "./workspace-chat-state";
import type { useWorkspaceDraftController } from "./workspace-drafts";
import type { useWorkspaceChromeState, useWorkspaceRouteState } from "./workspace-ui-state";

/**
 * The title of a conversation whose first message only attached files, until the title job
 * names it: the file's name, or the count in the person's language. The job recognises each
 * language's form (`server/src/conversations/conversation-title.ts`).
 */
export function attachedFilesTitle(files: readonly File[], locale: LocaleCode): string {
  const { t } = createTranslationContext(locale);
  return files.length === 1
    ? files[0]?.name || t("conversationAttachedFile")
    : t("conversationAttachedFiles", { count: String(files.length) });
}

interface WorkspaceConversationActionsInput {
  client: ApiClient;
  activeLocale: LocaleCode;
  routeState: ReturnType<typeof useWorkspaceRouteState>;
  dock: WorkspaceDock;
  docked: boolean;
  chrome: Pick<ReturnType<typeof useWorkspaceChromeState>, "requestComposerFocus">;
  draftController: ReturnType<typeof useWorkspaceDraftController>;
  workspaceCache: ReturnType<typeof useWorkspaceCacheActions>;
  conversationListRefresh: ReturnType<typeof useConversationListRefresh>;
  selectedConversationId: string | undefined;
  activeCollaborationWorkspaceId: string | undefined;
  personalCollaborationWorkspaceId: string | undefined;
  messagesLoaded: boolean;
  messages: readonly Message[];
  selectedConversationRunning: boolean;
  setNotice(notice: string | undefined): void;
}

/** Conversation navigation, creation and approval revisions share one render's workspace. */
export function createWorkspaceConversationActions({
  client,
  activeLocale,
  routeState,
  dock,
  docked,
  chrome,
  draftController,
  workspaceCache,
  conversationListRefresh,
  selectedConversationId,
  activeCollaborationWorkspaceId,
  personalCollaborationWorkspaceId,
  messagesLoaded,
  messages,
  selectedConversationRunning,
  setNotice
}: WorkspaceConversationActionsInput) {
  const { route } = routeState;

  function showConversationInActiveCollaborationWorkspace(
    conversationId: string,
    options?: { replace?: boolean }
  ) {
    if (docked) {
      dock.show(conversationId, { replace: true });
      return;
    }
    if (!activeCollaborationWorkspaceId) {
      return;
    }
    routeState.showConversation(activeCollaborationWorkspaceId, conversationId, options);
  }

  /**
   * A conversation the server just made opens in the workspace the server put it in. The open
   * workspace is not known yet while the address is still the application root, which is where a
   * person lands on the first sign-in, and the server places such a conversation in the Personal
   * Workspace.
   */
  function showCreatedConversation(
    conversation: { id: string; collaborationWorkspaceId: string },
    options?: { replace?: boolean }
  ) {
    if (docked) {
      // The empty dock's first message made it: the dock now holds it in place of nothing.
      dock.show(conversation.id, { replace: true });
      return;
    }
    routeState.showConversation(conversation.collaborationWorkspaceId, conversation.id, options);
  }

  function goToActiveCollaborationWorkspaceChat(options?: { replace?: boolean }) {
    routeState.goToDefaultChat(activeCollaborationWorkspaceId, options);
  }

  async function ensureConversationForFiles(files: File[]): Promise<string> {
    if (selectedConversationId) {
      return selectedConversationId;
    }
    const title = attachedFilesTitle(files, activeLocale);
    const conversation = await client.conversations.create({
      body: {
        title,
        locale: activeLocale,
        ...(activeCollaborationWorkspaceId
          ? { collaborationWorkspaceId: activeCollaborationWorkspaceId }
          : {})
      }
    });
    draftController.moveDraft({
      authScope: WORKSPACE_AUTH_SCOPE,
      fromConversationId: undefined,
      toConversationId: conversation.id
    });
    showCreatedConversation(conversation, {
      replace: route.kind === "new-conversation"
    });
    setNotice(undefined);
    workspaceCache.invalidateConversations();
    return conversation.id;
  }

  /**
   * A conversation of the open workspace about one asset, opened once the instance made it.
   * What a conversation is about is set when it is made, so it is made before its first turn;
   * it opens in the dock of the asset's page, with `prompt` in its composer where one is given.
   * Every caller names its prompt, also none, so a prompt is never dropped on the way.
   */
  async function startConversationAbout(
    subject: { kind: string; name: string },
    prompt: string | undefined
  ): Promise<void> {
    if (!activeCollaborationWorkspaceId) {
      throw new Error("A conversation about an asset belongs to a workspace");
    }
    const conversation = await client.conversations.create({
      body: {
        locale: activeLocale,
        collaborationWorkspaceId: activeCollaborationWorkspaceId,
        subject
      }
    });
    openConversationAbout(conversation, subject, prompt, { routeState, dock, draftController });
    setNotice(undefined);
    workspaceCache.invalidateConversations();
    chrome.requestComposerFocus();
  }

  // A conversation that only existed to hold draft attachments is an unsent draft. Once the
  // last one is removed the composer is back on the start page; the server stops listing the
  // empty conversation and its retention job removes it.
  function returnToStartPageAfterDraftEmptied(conversationId: string) {
    if (
      !isAbandonedDraftConversation({
        conversationId,
        selectedConversationId,
        messagesLoaded,
        messageCount: messages.length,
        running: selectedConversationRunning
      })
    ) {
      return;
    }
    draftController.moveDraft({
      authScope: WORKSPACE_AUTH_SCOPE,
      fromConversationId: conversationId,
      toConversationId: undefined
    });
    if (docked) {
      dock.show(undefined, { replace: true });
      return;
    }
    goToActiveCollaborationWorkspaceChat({ replace: true });
  }

  function startNewConversation() {
    goToActiveCollaborationWorkspaceChat();
    setNotice(undefined);
    chrome.requestComposerFocus();
  }

  /** A new conversation of the open workspace, with this text in its composer. */
  function startNewConversationWith(prompt: string) {
    draftController.setDraft(
      { authScope: WORKSPACE_AUTH_SCOPE, conversationId: undefined },
      prompt
    );
    startNewConversation();
  }

  /** The dock beside the open page, with a new conversation and this text in its composer. */
  function startDockedChat(prompt: string) {
    draftController.setDraft(
      { authScope: WORKSPACE_AUTH_SCOPE, conversationId: undefined },
      prompt
    );
    dock.show(undefined);
    chrome.requestComposerFocus();
  }

  // A conversation picked in the sidebar or the palette opens on its chat route, also from a
  // page with a dock: the dock's own conversation goes out of the dock into it.
  function selectConversation(conversationId: string) {
    if (activeCollaborationWorkspaceId) {
      routeState.showConversation(activeCollaborationWorkspaceId, conversationId);
    }
    setNotice(undefined);
  }

  async function startRevisionRun(input: ApprovalRevisionRunInput) {
    const response = await startProductConversationRun({
      agentName: input.agentName,
      client,
      collaborationWorkspaceId: input.conversationId ? undefined : personalCollaborationWorkspaceId,
      conversationId: input.conversationId,
      idempotencyKey: createRunIdempotencyKey(),
      locale: activeLocale,
      text: input.text
    });
    workspaceCache.cacheRunStarted(response);
    routeState.showConversation(
      response.conversation.collaborationWorkspaceId,
      response.conversation.id
    );
    setNotice(undefined);
    conversationListRefresh.runAccepted(response);
  }

  /** The run did not start: open the composer with the message ready to send. */
  function leaveRevisionInComposer(
    conversationId: string | undefined,
    text: string,
    failureNotice: string
  ) {
    const target = { authScope: WORKSPACE_AUTH_SCOPE, conversationId };
    if (!draftController.draftFor(target)) {
      draftController.setDraft(target, text);
    }
    const collaborationWorkspaceId = conversationId
      ? (activeCollaborationWorkspaceId ?? personalCollaborationWorkspaceId)
      : (personalCollaborationWorkspaceId ?? activeCollaborationWorkspaceId);
    if (conversationId && collaborationWorkspaceId) {
      // A conversation in another workspace is redirected to its canonical URL.
      routeState.showConversation(collaborationWorkspaceId, conversationId);
    } else {
      routeState.goToDefaultChat(collaborationWorkspaceId);
    }
    setNotice(failureNotice);
  }

  return {
    showConversationInActiveCollaborationWorkspace,
    showCreatedConversation,
    goToActiveCollaborationWorkspaceChat,
    ensureConversationForFiles,
    startConversationAbout,
    returnToStartPageAfterDraftEmptied,
    startNewConversation,
    startNewConversationWith,
    startDockedChat,
    selectConversation,
    startRevisionRun,
    leaveRevisionInComposer
  };
}
