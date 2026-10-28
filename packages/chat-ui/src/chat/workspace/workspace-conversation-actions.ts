import type { ApiClient, LocaleCode, Message } from "@work-shape/catalyst-api-client";
import type { useWorkspaceCacheActions } from "../../shared/api/workspace-queries";
import { createTranslationContext } from "../../shared/i18n";
import type { ApprovalRevisionRunInput } from "../approvals/approval-revision-host";
import {
  createRunIdempotencyKey,
  startProductConversationRun
} from "../assistant/product-run-transport";
import {
  dockConversationToReuse,
  openConversationAbout,
  type ThreadAbout
} from "./open-conversation-about";
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

/**
 * A conversation of the person's own in a workspace, made before its first turn, with `prompt`
 * in its composer (ACCEPT-FIX-11 E3). A workspace whose members read its conversations builds
 * nothing in them: building goes on in a private conversation of the same workspace, whatever
 * the workspace starts conversations as.
 */
export async function createPrivateConversationWith(input: {
  client: {
    conversations: {
      create(
        input: Parameters<ApiClient["conversations"]["create"]>[0]
      ): Promise<{ id: string; collaborationWorkspaceId: string }>;
    };
  };
  locale: LocaleCode;
  collaborationWorkspaceId: string;
  prompt: string;
  draftController: Pick<ReturnType<typeof useWorkspaceDraftController>, "setDraft">;
  /** `instance` where Studio is set to "Instance": its first saves create for the instance. */
  creationTarget?: "instance";
}): Promise<{ id: string; collaborationWorkspaceId: string }> {
  const conversation = await input.client.conversations.create({
    body: {
      locale: input.locale,
      collaborationWorkspaceId: input.collaborationWorkspaceId,
      visibility: "private",
      ...(input.creationTarget ? { creationTarget: input.creationTarget } : {})
    }
  });
  input.draftController.setDraft(
    { authScope: WORKSPACE_AUTH_SCOPE, conversationId: conversation.id },
    input.prompt
  );
  return conversation;
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
  /** What the open conversation is about and where, once its thread has loaded. */
  selectedConversationAbout: ThreadAbout | undefined;
  activeCollaborationWorkspaceId: string | undefined;
  personalCollaborationWorkspaceId: string | undefined;
  messagesLoaded: boolean;
  messages: readonly Message[];
  selectedConversationRunning: boolean;
  setNotice(notice: string | undefined): void;
  /** The next new conversation of the open workspace starts private. */
  startsPrivate: boolean;
  /** Names the workspace whose next new conversation starts private, or none. */
  setPrivateStartIn(collaborationWorkspaceId: string | undefined): void;
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
  selectedConversationAbout,
  activeCollaborationWorkspaceId,
  personalCollaborationWorkspaceId,
  messagesLoaded,
  messages,
  selectedConversationRunning,
  setNotice,
  startsPrivate,
  setPrivateStartIn
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

  /**
   * The conversation the files of a first message go to. It is made as that message is sent,
   * not when the files are picked, and opens once its run starts.
   */
  function createConversationForFiles(files: File[]) {
    return client.conversations.create({
      body: {
        title: attachedFilesTitle(files, activeLocale),
        locale: activeLocale,
        ...(activeCollaborationWorkspaceId
          ? { collaborationWorkspaceId: activeCollaborationWorkspaceId }
          : {}),
        ...(startsPrivate && !docked ? { visibility: "private" as const } : {})
      }
    });
  }

  /** A first message's files could not be got ready: their conversation opens with them. */
  function showConversationForFiles(conversation: {
    id: string;
    collaborationWorkspaceId: string;
  }) {
    draftController.moveDraft({
      authScope: WORKSPACE_AUTH_SCOPE,
      fromConversationId: undefined,
      toConversationId: conversation.id
    });
    showCreatedConversation(conversation, {
      replace: route.kind === "new-conversation"
    });
    workspaceCache.invalidateConversations();
  }

  /**
   * A conversation about one asset, opened once the instance made it: in `workspaceId`, the
   * workspace that owns the asset, or else in the open workspace.
   * What a conversation is about is set when it is made, so it is made before its first turn;
   * it opens in the dock of the asset's page, with `prompt` in its composer where one is given.
   * Every caller names its prompt, also none, so a prompt is never dropped on the way.
   * With `checkout` ("Edit in chat" on an App's page) the conversation is always a new one,
   * which the instance makes holding the App's draft with all its files.
   */
  async function startConversationAbout(
    subject: { kind: string; name: string },
    prompt: string | undefined,
    workspaceId: string | undefined = activeCollaborationWorkspaceId,
    options?: { fresh: boolean; checkout?: true }
  ): Promise<void> {
    if (!workspaceId) {
      throw new Error("A conversation about an asset belongs to a workspace");
    }
    // The dock already holds a conversation about this asset: it opens again, also where the
    // person closed it or it lies behind the page, and keeps what was said there. The dock's
    // "New chat" asks for a fresh one.
    const dockConversationId =
      options?.fresh || options?.checkout ? undefined : dock.conversationId;
    const reused = dockConversationToReuse({
      dockConversationId,
      dock:
        dockConversationId === undefined
          ? undefined
          : dockConversationId === selectedConversationId
            ? selectedConversationAbout
            : workspaceCache.knownThreadAbout(dockConversationId),
      subject,
      workspaceId,
      prompt,
      draftText:
        dockConversationId === undefined
          ? ""
          : draftController.draftFor({
              authScope: WORKSPACE_AUTH_SCOPE,
              conversationId: dockConversationId
            })
    });
    if (reused !== undefined) {
      openConversationAbout(
        { id: reused, collaborationWorkspaceId: workspaceId },
        subject,
        prompt,
        { routeState, dock, draftController }
      );
      setNotice(undefined);
      chrome.requestComposerFocus();
      return;
    }
    const conversation = await client.conversations.create({
      body: {
        locale: activeLocale,
        collaborationWorkspaceId: workspaceId,
        subject,
        ...(options?.checkout ? { checkout: true as const } : {})
      }
    });
    openConversationAbout(conversation, subject, prompt, { routeState, dock, draftController });
    setNotice(undefined);
    workspaceCache.invalidateConversations();
    chrome.requestComposerFocus();
  }

  /**
   * A private conversation of `options.workspaceId`, the open workspace unless named, with
   * `prompt` in its composer, where building goes on in a workspace whose members read its
   * conversations, in the workspace Studio is set to, or with Studio set to "Instance", whose
   * `creationTarget` the conversation keeps. It opens in the dock where `inDock`, else where a
   * conversation the server made opens. Answers its id.
   */
  async function startPrivateConversationWith(
    prompt: string,
    inDock: boolean,
    options: { workspaceId?: string; creationTarget?: "instance" } = {}
  ): Promise<string> {
    const workspaceId = options.workspaceId ?? activeCollaborationWorkspaceId;
    if (!workspaceId) {
      throw new Error("A private conversation belongs to a workspace");
    }
    const conversation = await createPrivateConversationWith({
      client,
      locale: activeLocale,
      collaborationWorkspaceId: workspaceId,
      ...(options.creationTarget ? { creationTarget: options.creationTarget } : {}),
      prompt,
      draftController
    });
    if (inDock) {
      dock.show(conversation.id);
    } else {
      showCreatedConversation(conversation);
    }
    setNotice(undefined);
    workspaceCache.invalidateConversations();
    chrome.requestComposerFocus();
    return conversation.id;
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

  /**
   * Goes on privately after a build was refused because others read the open conversation:
   * the workspace's start page with the request in its composer, as a new chat opens. Nothing
   * exists until the first send, which makes the conversation private (ACCEPT-2e).
   */
  function continuePrivatelyWith(prompt: string) {
    if (!activeCollaborationWorkspaceId) {
      throw new Error("A private conversation belongs to a workspace");
    }
    draftController.setDraft(
      { authScope: WORKSPACE_AUTH_SCOPE, conversationId: undefined },
      prompt
    );
    goToActiveCollaborationWorkspaceChat();
    setPrivateStartIn(activeCollaborationWorkspaceId);
    setNotice(undefined);
    chrome.requestComposerFocus();
  }

  function startNewConversation() {
    setPrivateStartIn(undefined);
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

  /**
   * Starts a new conversation in a project with its first message and opens it (PRJ-1). It
   * belongs to the project's workspace and takes the project's audience.
   */
  async function startConversationInProject(input: {
    text: string;
    collaborationWorkspaceId: string;
    projectId: string;
  }) {
    const response = await startProductConversationRun({
      client,
      collaborationWorkspaceId: input.collaborationWorkspaceId,
      projectId: input.projectId,
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
    createConversationForFiles,
    showConversationForFiles,
    startConversationAbout,
    startPrivateConversationWith,
    continuePrivatelyWith,
    returnToStartPageAfterDraftEmptied,
    startNewConversation,
    startNewConversationWith,
    startDockedChat,
    selectConversation,
    startRevisionRun,
    startConversationInProject,
    leaveRevisionInComposer
  };
}
