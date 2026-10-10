import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiClient,
  ApiUser,
  CollaborationWorkspaceAgents,
  ConversationListItem,
  DraftAttachment,
  LocaleCode,
  Message,
  SafeConfig,
  StartConversationRunResponse
} from "@vivd-catalyst/api-client";
import type { ThemeInputs } from "@vivd-catalyst/ui/theme";
import { useApprovalPendingCountQuery } from "../approvals/approval-request-api";
import {
  startApprovalRevision,
  type ApprovalRevisionHost,
  type ApprovalRevisionRunInput
} from "../approvals/approval-revision-host";
import {
  createRunIdempotencyKey,
  startProductConversationRun
} from "../assistant/product-run-transport";
import { resolveContextUsage } from "../assistant/context-usage";
import type { SendBlock } from "../assistant/send-block";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import { useConversationListRefresh } from "./use-conversation-list-refresh";
import {
  useCancelRunMutation,
  useDeleteConversationMutation,
  useRenameConversationMutation,
  useWorkspaceSignOutMutation
} from "../api/workspace-mutations";
import { useRailConversations } from "../api/rail-conversations";
import {
  useCollaborationWorkspaceAgentsQuery,
  useWorkspaceCacheActions,
  useWorkspaceConfigQuery,
  useWorkspaceMeQuery,
  useWorkspaceModelPreferenceQuery,
  useWorkspaceThreadQuery
} from "../api/workspace-queries";
import {
  useCollaborationWorkspaceModel,
  type CollaborationWorkspaceModel
} from "../collaboration-workspace/collaboration-workspace-model";
import type { LocalUploadingAttachment } from "../assistant/assistant-composer";
import type { ChatFileDropzoneController } from "../chat-file-dropzone";
import type { ChatShellAdministration } from "../settings/page-definition";
import { useControlPlaneModel, type ControlPlaneModel } from "../control-plane/control-plane-model";
import { clearRunCursors } from "../conversation/run-connection-manager";
import {
  isLiveRunStatus,
  type ConversationControllerState
} from "../conversation/conversation-controller-state";
import { useConversationController } from "../conversation/use-conversation-controller";
import { useDraftAttachmentController } from "../conversation/draft-attachment-controller";
import { useChatFileDropzone } from "../chat-file-dropzone";
import { useToolDisplayPanel } from "../tool-display-panel";
import type { ResolvedThemeMode } from "../theme";
import type { WorkspaceView } from "./workspace-rail";
import { inboxRailEntry } from "../inbox/inbox-model";
import type { WorkspaceRoute } from "./workspace-route";
import { apiErrorStatus, applyFavicon, createEnvironmentDocumentTitle } from "../workspace-utils";
import {
  agentModelSelection,
  conversationModelPicks,
  modelReasoningEffortSelection,
  NO_MODEL_PICKS,
  type AgentSelectableModel,
  type ModelPicks,
  type ReasoningEffort
} from "./agent-model-selection";
import { useWorkspaceDraft, useWorkspaceDraftController } from "./workspace-drafts";
import {
  useWorkspaceChromeState,
  useWorkspaceConversationActivityState,
  useWorkspaceLocale,
  useWorkspacePreferences,
  useWorkspaceRouteState,
  useWorkspaceTheme
} from "./workspace-ui-state";
import { createTranslationContext, type TranslationContextValue } from "../i18n";
import { workspaceSendBlock } from "./workspace-send-block";

export const WORKSPACE_AUTH_SCOPE = "standalone";

/**
 * Narrows the instance config to the agents the active Collaboration Workspace
 * offers. `getConfig` only knows the caller's Personal Workspace view, so it
 * stands in solely where that view is the right one: fixed-context sessions,
 * the Personal Workspace itself, and a failed workspace lookup. Anything else
 * waits for the workspace's own list instead of showing the wrong agents.
 */
export function workspaceScopedConfigFor(input: {
  config: SafeConfig | undefined;
  collaborationWorkspacesAvailable: boolean;
  workspaceAgents: CollaborationWorkspaceAgents | undefined;
  instanceViewApplies: boolean;
}): { config: SafeConfig | undefined; agentsLoading: boolean; workspaceScoped: boolean } {
  const { config } = input;
  if (!config || !input.collaborationWorkspacesAvailable) {
    return { config, agentsLoading: false, workspaceScoped: false };
  }
  if (input.workspaceAgents) {
    return {
      config: {
        ...config,
        agents: input.workspaceAgents.items,
        defaultAgentName: input.workspaceAgents.defaultAgentName
      },
      agentsLoading: false,
      workspaceScoped: true
    };
  }
  if (input.instanceViewApplies) {
    return { config, agentsLoading: false, workspaceScoped: false };
  }
  return {
    config: { ...config, agents: [], defaultAgentName: undefined },
    agentsLoading: true,
    workspaceScoped: true
  };
}

/**
 * Whether the conversation on screen holds nothing the user would lose: it is the selected one,
 * its thread is loaded and empty, and no run is underway.
 */
export function isAbandonedDraftConversation(input: {
  conversationId: string;
  selectedConversationId: string | undefined;
  messagesLoaded: boolean;
  messageCount: number;
  running: boolean;
}): boolean {
  return (
    input.conversationId === input.selectedConversationId &&
    input.messagesLoaded &&
    input.messageCount === 0 &&
    !input.running
  );
}

/**
 * The agent a new run would use: the user's pick while this workspace offers
 * it, otherwise the workspace default. Derived rather than stored, so switching
 * to a workspace without the picked agent never renders an unavailable one.
 */
export function activeAgentNameFor(
  config: Pick<SafeConfig, "agents" | "defaultAgentName"> | undefined,
  selectedAgentName: string | undefined
): string | undefined {
  const agents = config?.agents ?? [];
  const offered = (name: string | undefined) =>
    name !== undefined && agents.some((agent) => agent.name === name);
  return offered(selectedAgentName)
    ? selectedAgentName
    : offered(config?.defaultAgentName)
      ? config?.defaultAgentName
      : agents[0]?.name;
}

export interface WorkspaceChatModelInput {
  administration: ChatShellAdministration | undefined;
  manageDocumentTitle: boolean | undefined;
  /** False for embedded token sessions, which stay fixed-context. */
  collaborationWorkspacesAvailable: boolean;
}

export interface WorkspaceChatModel {
  auth: WorkspaceAuthModel;
  config: WorkspaceConfigModel;
  route: WorkspaceRouteModel;
  chrome: WorkspaceChromeModel;
  collaborationWorkspace: CollaborationWorkspaceModel;
  conversationRail: ConversationRailModel;
  selectedChat: SelectedChatModel;
  controlPlane: ControlPlaneModel;
  toolDisplay: ToolDisplayModel;
  approvalRevision: ApprovalRevisionHost;
}

export interface WorkspaceAuthModel {
  apiBaseUrl: string;
  user: ApiUser | undefined;
  loginRequired: boolean;
  sessionUnavailable: boolean;
  sessionRetrying: boolean;
  signingOut: boolean;
  signOut(): void;
  /** Opens one of the user's own Settings pages. */
  openSettings(page: OwnSettingsPage): void;
  invalidateCurrentUser(): void;
  retryCurrentUser(): void;
}

export interface WorkspaceConfigModel {
  config: SafeConfig | undefined;
  /**
   * Why the configuration did not load. `outdated`: the answer or the path belongs to another
   * release than this interface, so only a reload helps. `unavailable`: anything else.
   */
  failure: "outdated" | "unavailable" | undefined;
  retrying: boolean;
  retry(): void;
  activeLocale: LocaleCode;
  localePreference: LocaleCode | undefined;
  supportedLocales: LocaleCode[];
  resolvedThemeMode: ResolvedThemeMode;
  /** The instance's theme inputs for the resolved mode; undefined until the config has loaded. */
  theme: ThemeInputs | undefined;
  activeAgentName: string | undefined;
  selectAgentName(agentName: string | undefined): void;
  selectLocale(locale: LocaleCode): void;
  toggleTheme(): void;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
}

/** The pages of the Settings group "You" that the account menu leads to. */
type OwnSettingsPage = "profile" | "language-appearance";

export interface WorkspaceRouteModel {
  route: WorkspaceRoute;
  view: WorkspaceView;
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
  /** Opens a route by its value, as the command palette's "Go to" group does. */
  showRoute(route: WorkspaceRoute): void;
}

export interface WorkspaceChromeModel {
  sidebarCollapsed: boolean;
  sidebarDrawerOpen: boolean;
  composerFocusRequestId: number;
  toggleSidebarCollapsed(): void;
  openSidebarDrawer(): void;
  closeSidebarDrawer(): void;
  requestComposerFocus(): void;
}

export interface ConversationRailModel {
  /** The conversations of the active workspace the rail has loaded, latest activity first. */
  conversations: readonly ConversationListItem[];
  /** The conversation on screen as a row, once its thread is there. */
  openConversation: ConversationListItem | undefined;
  /** The workspace holds older conversations than the loaded ones. */
  hasMoreConversations: boolean;
  loadingMoreConversations: boolean;
  /** The last request for older conversations failed. The loaded ones stay. */
  loadMoreConversationsFailed: boolean;
  loadMoreConversations(): void;
  /** How the list stands: still on its first load, failed without a list to show, or there. */
  conversationsStatus: "loading" | "failed" | "ready";
  reloadConversations(): void;
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
  /** Present for a person who may decide requests or has made one: the Inbox row shows. */
  inbox: { toDecide: number } | undefined;
  view: WorkspaceView;
  creatingConversation: boolean;
  deletingConversation: boolean;
  canMoveConversation: boolean;
  startNewConversation(): void;
  selectConversation(conversationId: string): void;
  renameConversation(conversationId: string, title: string): Promise<void>;
  moveConversation(conversationId: string, title: string): void;
  deleteConversation(conversationId: string): void;
  selectWorkspaceView(view: WorkspaceView): void;
}

export interface SelectedChatModel {
  client: ApiClient;
  config: SafeConfig | undefined;
  /** The active workspace's agent list has not arrived yet. */
  agentsLoading: boolean;
  /** `config.agents` is the active workspace's list rather than the instance view. */
  agentsWorkspaceScoped: boolean;
  collaborationWorkspaceId: string | undefined;
  /** No conversation yet, and the Shared Workspace would start one as private. */
  newConversationPrivate: boolean;
  selectedConversationId: string | undefined;
  /** The open conversation's retention date, once its thread has loaded. */
  selectedConversationRetainedUntil: string | undefined;
  messages: Message[] | undefined;
  completedRunProjections: ConversationControllerState["completedRunProjections"];
  messagesLoaded: boolean;
  /** How far the selected conversation's thread is; "ready" while no conversation is selected. */
  snapshotStatus: ConversationControllerState["snapshotStatus"];
  notice: string | undefined;
  draft: string;
  composerFocusRequestId: number;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  /** The active agent's own model first, then the models users may pick instead. */
  selectableModels: AgentSelectableModel[];
  selectedModelBindingId: string | undefined;
  /** The effort a run with the selected model would use. */
  selectedReasoningEffort: ReasoningEffort | undefined;
  /** That effort when the user picked it; unset leaves the run to the model's default. */
  requestedReasoningEffort: ReasoningEffort | undefined;
  showContextIndicator: boolean;
  contextSnapshot:
    | {
        inputTokens: number;
        compactThresholdTokens: number;
      }
    | undefined;
  selectAgentName(agentName: string): void;
  selectModelBindingId(modelBindingId: string): void;
  selectReasoningEffort(modelBindingId: string, effort: ReasoningEffort): void;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  conversationRunning: boolean;
  activeRun: ConversationControllerState["activeRun"];
  sendBlock: SendBlock | undefined;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
  fileDropzone: ChatFileDropzoneController;
  changeDraft(value: string): void;
  selectFiles(files: File[]): void;
  removeDraftAttachment(attachmentId: string): void;
  retryDraftAttachment(attachmentId: string): void;
  conversationStarted(conversationId: string): void;
  messageSubmitted(conversationId: string): void;
  runStarted(response: StartConversationRunResponse): void;
  streamError(conversationId: string, message: string, viewed: boolean): void;
  cancelSelectedRun(): void;
}

export interface ToolDisplayModel {
  open: boolean;
}

export function useWorkspaceChatModel({
  administration,
  manageDocumentTitle,
  collaborationWorkspacesAvailable
}: WorkspaceChatModelInput): WorkspaceChatModel {
  const [notice, setNotice] = useState<string | undefined>();
  const [selectedAgentName, setSelectedAgentName] = useState<string | undefined>();
  // The user's default once they change it here; until then the stored one applies.
  const [changedUserModelPicks, setChangedUserModelPicks] = useState<ModelPicks | undefined>();
  const [changedConversationModelPicks, setChangedConversationModelPicks] = useState<
    Readonly<Record<string, ModelPicks>>
  >({});
  const { apiBaseUrl, client, interfaceOutdated } = useWorkspaceApiClient();
  const routeState = useWorkspaceRouteState();
  const chrome = useWorkspaceChromeState();
  const preferences = useWorkspacePreferences();
  const conversationActivity = useWorkspaceConversationActivityState();
  const draftController = useWorkspaceDraftController();
  const displayPanel = useToolDisplayPanel();
  const { route, selectedConversationId, view } = routeState;
  const activeDraft = useWorkspaceDraft({
    authScope: WORKSPACE_AUTH_SCOPE,
    conversationId: selectedConversationId
  });

  const meQuery = useWorkspaceMeQuery({ apiBaseUrl, client });
  const isAuthenticated = Boolean(meQuery.data);
  const configQuery = useWorkspaceConfigQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    localePreference: preferences.localePreference,
    enabled: isAuthenticated
  });
  const configFailure = !configQuery.error
    ? undefined
    : interfaceOutdated
      ? "outdated"
      : "unavailable";
  const { refetch: refetchConfig } = configQuery;
  const retryConfig = useCallback(() => {
    // A refetch reports its failure through the query and does not reject.
    refetchConfig().catch(() => undefined);
  }, [refetchConfig]);
  const modelPreferenceQuery = useWorkspaceModelPreferenceQuery({
    apiBaseUrl,
    client,
    enabled: isAuthenticated
  });
  const threadQuery = useWorkspaceThreadQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    conversationId: selectedConversationId,
    enabled: isAuthenticated && Boolean(selectedConversationId)
  });
  // Only a settled thread for the conversation actually on screen may decide
  // the canonical URL. A snapshot left over from another conversation, or one
  // still being refetched after a move, would redirect back to a workspace the
  // conversation has already left.
  const loadedConversation =
    threadQuery.data?.conversation.id === selectedConversationId && !threadQuery.isFetching
      ? threadQuery.data?.conversation
      : undefined;
  const collaborationWorkspace = useCollaborationWorkspaceModel({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    isAuthenticated,
    enabled: collaborationWorkspacesAvailable,
    userId: meQuery.data?.id,
    route,
    loadedConversationCollaborationWorkspaceId: loadedConversation?.collaborationWorkspaceId,
    legacyConversationUnavailable:
      route.kind === "legacy-conversation" && Boolean(threadQuery.error),
    goToCollaborationWorkspace: routeState.goToDefaultChat,
    showConversation: routeState.showConversation,
    showSettings: routeState.showSettings
  });
  const activeCollaborationWorkspaceId = collaborationWorkspace.activeCollaborationWorkspaceId;
  const railConversations = useRailConversations({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    collaborationWorkspaceId: activeCollaborationWorkspaceId,
    collaborationWorkspacesAvailable,
    enabled: isAuthenticated
  });

  const workspaceCache = useWorkspaceCacheActions({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    collaborationWorkspaceId: activeCollaborationWorkspaceId,
    collaborationWorkspacesAvailable
  });
  const configSessionEnded = apiErrorStatus(configQuery.error) === 401;
  const { invalidateCurrentUser } = workspaceCache;
  useEffect(() => {
    // The session ended between the two requests: asking who is signed in leads to sign-in.
    if (configSessionEnded) {
      invalidateCurrentUser();
    }
  }, [configSessionEnded, invalidateCurrentUser]);
  const controller = useConversationController({
    client,
    conversationId: selectedConversationId,
    enabled: isAuthenticated && Boolean(selectedConversationId),
    snapshot: threadQuery.data,
    snapshotLoading: threadQuery.isLoading,
    snapshotError: threadQuery.error,
    refreshSnapshot: workspaceCache.refreshThreadSnapshot,
    onToolCallCompleted: workspaceCache.invalidateConversationResources,
    onTerminalObservation: workspaceCache.invalidateTerminalRunObservation
  });
  const conversationsQuery = railConversations.query;
  const serverConversations = conversationsQuery.data?.conversations ?? NO_CONVERSATIONS;
  const selectedConversationRunning = Boolean(
    controller.activeRun && isLiveRunStatus(controller.activeRun.run.status)
  );
  const conversationListRefresh = useConversationListRefresh({
    enabled: isAuthenticated,
    conversations: serverConversations,
    streamedConversationId: selectedConversationRunning ? selectedConversationId : undefined,
    refresh: workspaceCache.refreshRailConversations
  });

  useEffect(() => {
    const completedBackgroundConversationIds =
      conversationActivity.syncConversationActivity(serverConversations);
    for (const conversationId of completedBackgroundConversationIds) {
      workspaceCache.removeThreadSnapshot(conversationId);
    }
  }, [
    conversationActivity.syncConversationActivity,
    serverConversations,
    workspaceCache.removeThreadSnapshot
  ]);

  useEffect(() => {
    if (selectedConversationId) {
      conversationActivity.clearUnreadConversation(selectedConversationId);
    }
  }, [conversationActivity.clearUnreadConversation, selectedConversationId]);

  const conversations = useMemo(() => {
    if (conversationActivity.locallyUnreadConversationIds.size === 0) {
      return serverConversations;
    }
    return serverConversations.map((conversation) =>
      conversationActivity.locallyUnreadConversationIds.has(conversation.id)
        ? { ...conversation, unread: true }
        : conversation
    );
  }, [conversationActivity.locallyUnreadConversationIds, serverConversations]);
  const messages = selectedConversationId ? controller.messages : [];
  const messagesLoaded = !selectedConversationId || controller.snapshotStatus === "ready";
  // The rail holds the pages a person has loaded. The open conversation may be older than
  // those, and the thread on screen already holds what its row shows.
  const openThread =
    threadQuery.data?.conversation.id === selectedConversationId ? threadQuery.data : undefined;
  const openConversation = useMemo((): ConversationListItem | undefined => {
    if (
      !openThread ||
      (collaborationWorkspacesAvailable &&
        openThread.conversation.collaborationWorkspaceId !== activeCollaborationWorkspaceId)
    ) {
      return undefined;
    }
    return {
      ...openThread.conversation,
      ...(selectedConversationRunning && controller.activeRun
        ? { activeRun: controller.activeRun.run }
        : {})
    };
  }, [
    activeCollaborationWorkspaceId,
    collaborationWorkspacesAvailable,
    controller.activeRun,
    openThread,
    selectedConversationRunning
  ]);
  const workspaceAgentsQuery = useCollaborationWorkspaceAgentsQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    collaborationWorkspaceId: activeCollaborationWorkspaceId,
    localePreference: preferences.localePreference,
    enabled: isAuthenticated && collaborationWorkspacesAvailable
  });
  const {
    config,
    agentsLoading,
    workspaceScoped: agentsWorkspaceScoped
  } = useMemo(
    () =>
      workspaceScopedConfigFor({
        config: configQuery.data,
        collaborationWorkspacesAvailable,
        workspaceAgents: workspaceAgentsQuery.data,
        instanceViewApplies:
          view !== "chat" ||
          workspaceAgentsQuery.isError ||
          collaborationWorkspace.loadFailed ||
          collaborationWorkspace.activeCollaborationWorkspace?.kind === "personal"
      }),
    [
      collaborationWorkspace.activeCollaborationWorkspace?.kind,
      collaborationWorkspace.loadFailed,
      collaborationWorkspacesAvailable,
      configQuery.data,
      view,
      workspaceAgentsQuery.data,
      workspaceAgentsQuery.isError
    ]
  );
  const attachmentsEnabled = config?.features.attachments.enabled ?? false;
  const attachmentAccept = config?.features.attachments.accept ?? "";
  const activeLocale = useWorkspaceLocale(config?.localization.locale);
  const controllerTerminalNotice = terminalRunNotice(
    controller.error,
    createTranslationContext(activeLocale).t
  );
  const visibleNotice = notice ?? controllerTerminalNotice;

  function showConversationInActiveCollaborationWorkspace(
    conversationId: string,
    options?: { replace?: boolean }
  ) {
    if (!activeCollaborationWorkspaceId) {
      return;
    }
    routeState.showConversation(activeCollaborationWorkspaceId, conversationId, options);
  }

  function goToActiveCollaborationWorkspaceChat(options?: { replace?: boolean }) {
    routeState.goToDefaultChat(activeCollaborationWorkspaceId, options);
  }

  async function ensureConversationForFiles(files: File[]): Promise<string> {
    if (selectedConversationId) {
      return selectedConversationId;
    }
    const title =
      files.length === 1 ? (files[0]?.name ?? "Attached file") : `${files.length} attached files`;
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
    showConversationInActiveCollaborationWorkspace(conversation.id, {
      replace: route.kind === "new-conversation"
    });
    setNotice(undefined);
    workspaceCache.invalidateConversations();
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
    goToActiveCollaborationWorkspaceChat({ replace: true });
  }

  const draftAttachmentController = useDraftAttachmentController({
    enabled: attachmentsEnabled,
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    selectedConversationId,
    isAuthenticated,
    ensureConversationForFiles,
    onDraftAttachmentsEmptied: returnToStartPageAfterDraftEmptied,
    onError: setNotice
  });
  const fileDropzone = useChatFileDropzone({
    enabled: attachmentsEnabled,
    onFilesSelected: draftAttachmentController.onFilesSelected
  });
  const supportedLocales =
    config?.localization.supportedLocales ?? preferences.supportedFallbackLocales;
  const { resolvedThemeMode, theme, toggleTheme, themePreference, selectThemePreference } =
    useWorkspaceTheme(config?.ui);
  const activeAgentName = activeAgentNameFor(config, selectedAgentName);
  const displayPanelOpen = Boolean(displayPanel.entry && displayPanel.open);

  function resetAuthenticatedWorkspaceState() {
    draftController.clearDrafts();
    conversationActivity.resetConversationActivity();
    clearRunCursors();
    routeState.resetRouteMemory();
    routeState.goToDefaultChat(undefined, { replace: true });
  }

  const controlPlane = useControlPlaneModel({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    administration,
    user: meQuery.data,
    config,
    collaborationWorkspaces: collaborationWorkspace.collaborationWorkspaces,
    // Without workspaces in this session there is no list to wait for.
    collaborationWorkspacesReady:
      !collaborationWorkspacesAvailable || !collaborationWorkspace.loading,
    settingsCollaborationWorkspace: collaborationWorkspace.settingsCollaborationWorkspace,
    selectSettingsCollaborationWorkspace:
      collaborationWorkspace.selectSettingsCollaborationWorkspace,
    isAuthenticated,
    route,
    view,
    supportedLocales,
    activeLocale,
    selectLocale: preferences.selectLocale,
    showContextIndicator: preferences.showContextIndicator,
    setShowContextIndicator: preferences.setShowContextIndicator,
    themePreference,
    selectThemePreference,
    goToDefaultChat: goToActiveCollaborationWorkspaceChat,
    showRoute: routeState.showRoute,
    onAccountDeleted: resetAuthenticatedWorkspaceState,
    onCollaborationWorkspaceDeleted: collaborationWorkspace.collaborationWorkspaceDeleted
  });
  const canViewAdministration = controlPlane.canViewAdministration;
  const approvalPendingCountQuery = useApprovalPendingCountQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    enabled: isAuthenticated
  });
  const inbox = inboxRailEntry(approvalPendingCountQuery.data);
  const activeAgent = config?.agents.find((agent) => agent.name === activeAgentName);
  const selectedThread =
    threadQuery.data?.conversation.id === selectedConversationId ? threadQuery.data : undefined;
  const modelPicks = conversationModelPicks({
    agent: activeAgent,
    changed: selectedConversationId
      ? changedConversationModelPicks[selectedConversationId]
      : undefined,
    latestRun: selectedThread?.modelSelection,
    userDefault: changedUserModelPicks ?? modelPreferenceQuery.data ?? NO_MODEL_PICKS
  });
  const { selectableModels, selectedModel } = agentModelSelection(
    activeAgent,
    modelPicks.modelBindingId
  );
  // A change applies to the conversation on screen and becomes the default for new ones.
  const changeModelPicks = (picks: ModelPicks) => {
    if (selectedConversationId) {
      setChangedConversationModelPicks((changed) => ({
        ...changed,
        [selectedConversationId]: picks
      }));
    }
    setChangedUserModelPicks(picks);
    void client.me.model_preference.set({ body: picks }).catch(() => undefined);
  };
  const selectedModelBindingId = selectedModel?.bindingId;
  const reasoningEffortSelection = modelReasoningEffortSelection(
    selectedModel,
    modelPicks.reasoningEfforts
  );
  const configuredCompactThresholdTokens =
    selectedModel?.compactThresholdTokens ?? activeAgent?.compactThresholdTokens;

  useEffect(() => {
    displayPanel.close();
  }, [displayPanel.close, selectedConversationId]);

  const documentTitle = config?.ui.title
    ? createEnvironmentDocumentTitle(config.ui.title, config.clientInstance.environment)
    : undefined;

  useEffect(() => {
    if (!manageDocumentTitle || !documentTitle) {
      return undefined;
    }
    const previousTitle = document.title;
    document.title = documentTitle;
    return () => {
      if (document.title === documentTitle) {
        document.title = previousTitle;
      }
    };
  }, [documentTitle, manageDocumentTitle]);

  useEffect(() => {
    if (!manageDocumentTitle) {
      return;
    }
    if (config?.ui.faviconUrl) {
      applyFavicon(config.ui.faviconUrl);
    }
  }, [config?.ui.faviconUrl, manageDocumentTitle]);

  const deleteConversationMutation = useDeleteConversationMutation({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    collaborationWorkspaceId: activeCollaborationWorkspaceId,
    selectedConversationId,
    clearConversationUploads: draftAttachmentController.clearConversationUploads,
    onDeletedActiveConversation: (nextSelectedConversationId) => {
      if (nextSelectedConversationId) {
        showConversationInActiveCollaborationWorkspace(nextSelectedConversationId, {
          replace: true
        });
        return;
      }
      goToActiveCollaborationWorkspaceChat({ replace: true });
    },
    onDeletedConversation: () => setNotice(undefined),
    onErrorMessage: setNotice
  });
  const renameConversationMutation = useRenameConversationMutation({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    collaborationWorkspaceId: activeCollaborationWorkspaceId,
    onErrorMessage: setNotice
  });
  const signOutMutation = useWorkspaceSignOutMutation({
    apiBaseUrl,
    onSignedOut: () => {
      resetAuthenticatedWorkspaceState();
    }
  });
  const cancelRunMutation = useCancelRunMutation({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    collaborationWorkspaceId: activeCollaborationWorkspaceId,
    onErrorMessage: setNotice
  });

  function cancelSelectedRun() {
    if (
      !selectedConversationId ||
      !controller.activeRun ||
      !isLiveRunStatus(controller.activeRun.run.status)
    ) {
      return;
    }
    cancelRunMutation.mutate({
      conversationId: selectedConversationId,
      runId: controller.activeRun.run.id
    });
  }

  function startNewConversation() {
    goToActiveCollaborationWorkspaceChat();
    setNotice(undefined);
    chrome.requestComposerFocus();
  }

  function conversationStarted(conversationId: string) {
    showConversationInActiveCollaborationWorkspace(conversationId, {
      replace: route.kind === "new-conversation"
    });
    setNotice(undefined);
    workspaceCache.invalidateConversationStarted(conversationId);
  }

  function messageSubmitted(conversationId: string) {
    activeDraft.clearDraft();
    draftController.clearDraft({ authScope: WORKSPACE_AUTH_SCOPE, conversationId });
    workspaceCache.clearDraftAttachments(conversationId);
    draftAttachmentController.clearConversationUploads(conversationId);
    workspaceCache.invalidateConversationResources(conversationId);
  }

  function runStarted(response: StartConversationRunResponse) {
    workspaceCache.cacheRunStarted(response);
    showConversationInActiveCollaborationWorkspace(response.conversation.id, {
      replace: route.kind === "new-conversation"
    });
    setNotice(undefined);
    conversationListRefresh.runAccepted(response);
  }

  function streamError(conversationId: string, message: string, viewed: boolean) {
    const visible = viewed || routeState.isConversationVisible(conversationId);
    if (visible) {
      setNotice(message);
    }
    workspaceCache.invalidateStreamError(conversationId);
  }

  function selectConversation(conversationId: string) {
    showConversationInActiveCollaborationWorkspace(conversationId);
    setNotice(undefined);
  }

  const personalCollaborationWorkspaceId = collaborationWorkspace.personalCollaborationWorkspaceId;

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
    auth: {
      apiBaseUrl,
      user: meQuery.data,
      loginRequired: apiErrorStatus(meQuery.error) === 401,
      sessionUnavailable: Boolean(meQuery.error),
      sessionRetrying: meQuery.isFetching,
      signingOut: signOutMutation.isPending,
      signOut: () => signOutMutation.mutate(),
      openSettings: (page) => routeState.showSettings("you", page),
      invalidateCurrentUser: workspaceCache.invalidateCurrentUser,
      retryCurrentUser: () => void meQuery.refetch()
    },
    config: {
      config,
      failure: configFailure,
      retrying: configQuery.isFetching,
      retry: retryConfig,
      activeLocale,
      localePreference: preferences.localePreference,
      supportedLocales,
      resolvedThemeMode,
      theme,
      activeAgentName,
      selectAgentName: setSelectedAgentName,
      selectLocale: preferences.selectLocale,
      toggleTheme,
      attachmentsEnabled,
      attachmentAccept
    },
    route: {
      route,
      view,
      selectedConversationId,
      canViewAdministration,
      showRoute: routeState.showRoute
    },
    chrome: {
      sidebarCollapsed: chrome.sidebarCollapsed,
      sidebarDrawerOpen: chrome.sidebarDrawerOpen,
      composerFocusRequestId: chrome.composerFocusRequestId,
      toggleSidebarCollapsed: chrome.toggleSidebarCollapsed,
      openSidebarDrawer: chrome.openSidebarDrawer,
      closeSidebarDrawer: chrome.closeSidebarDrawer,
      requestComposerFocus: chrome.requestComposerFocus
    },
    collaborationWorkspace,
    conversationRail: {
      conversations,
      openConversation,
      hasMoreConversations: railConversations.hasMore,
      loadingMoreConversations: railConversations.loadingMore,
      loadMoreConversationsFailed: railConversations.loadMoreFailed,
      loadMoreConversations: railConversations.loadMore,
      conversationsStatus:
        conversationsQuery.data !== undefined
          ? "ready"
          : conversationsQuery.isError
            ? "failed"
            : // A query that waits for its workspace is not loading yet, and shows as loading.
              "loading",
      // A reload that fails again shows in the state of the query.
      reloadConversations: () => {
        conversationsQuery.refetch().catch(() => undefined);
      },
      selectedConversationId,
      canViewAdministration,
      inbox,
      view,
      creatingConversation: false,
      deletingConversation: deleteConversationMutation.isPending,
      canMoveConversation: collaborationWorkspace.canMoveConversation,
      startNewConversation,
      selectConversation,
      renameConversation: async (conversationId, title) => {
        await renameConversationMutation.mutateAsync({ conversationId, title });
      },
      moveConversation: (conversationId) => {
        const conversation = [...conversations, openConversation].find(
          (candidate) => candidate?.id === conversationId
        );
        if (conversation) {
          collaborationWorkspace.openMoveConversationDialog(conversation);
        }
      },
      deleteConversation: (conversationId) => deleteConversationMutation.mutate(conversationId),
      selectWorkspaceView: routeState.selectWorkspaceView
    },
    selectedChat: {
      client,
      config,
      agentsLoading,
      agentsWorkspaceScoped,
      collaborationWorkspaceId: activeCollaborationWorkspaceId,
      newConversationPrivate:
        !selectedConversationId &&
        collaborationWorkspace.activeCollaborationWorkspace?.kind === "shared" &&
        collaborationWorkspace.activeCollaborationWorkspace.defaultConversationVisibility ===
          "private",
      selectedConversationId,
      selectedConversationRetainedUntil: selectedThread?.conversation.retainedUntil,
      messages,
      completedRunProjections: controller.completedRunProjections,
      messagesLoaded,
      snapshotStatus: selectedConversationId ? controller.snapshotStatus : "ready",
      notice: visibleNotice,
      draft: activeDraft.draft,
      composerFocusRequestId: chrome.composerFocusRequestId,
      locale: activeLocale,
      selectedAgentName: activeAgentName,
      selectableModels,
      selectedModelBindingId,
      selectedReasoningEffort: reasoningEffortSelection.reasoningEffort,
      requestedReasoningEffort: reasoningEffortSelection.requested,
      showContextIndicator: preferences.showContextIndicator,
      contextSnapshot: resolveContextUsage(
        messages,
        configuredCompactThresholdTokens,
        controller.activeRun?.projection
      ),
      selectAgentName: setSelectedAgentName,
      // Picking the agent's own model is not a pick: the next agent then uses its own model too.
      selectModelBindingId: (modelBindingId) =>
        changeModelPicks({
          ...(modelBindingId && modelBindingId !== selectableModels[0]?.bindingId
            ? { modelBindingId }
            : {}),
          reasoningEfforts: modelPicks.reasoningEfforts
        }),
      selectReasoningEffort: (modelBindingId, effort) =>
        changeModelPicks({
          ...modelPicks,
          reasoningEfforts: { ...modelPicks.reasoningEfforts, [modelBindingId]: effort }
        }),
      draftAttachments: draftAttachmentController.draftAttachments,
      localUploadingAttachments: draftAttachmentController.visibleUploadingAttachments,
      conversationRunning: selectedConversationRunning,
      activeRun: controller.activeRun,
      sendBlock: workspaceSendBlock({
        attachmentBlockedReason: draftAttachmentController.sendBlockedReason,
        selectedConversationId,
        collaborationWorkspacesAvailable,
        activeCollaborationWorkspaceId,
        loading: collaborationWorkspace.loading,
        loadFailed: collaborationWorkspace.loadFailed,
        workspacesListed: collaborationWorkspace.collaborationWorkspaces.length > 0,
        locale: activeLocale
      }),
      attachmentsEnabled,
      attachmentAccept,
      fileDropzone,
      changeDraft: activeDraft.setDraft,
      selectFiles: draftAttachmentController.onFilesSelected,
      removeDraftAttachment: draftAttachmentController.onRemoveDraftAttachment,
      retryDraftAttachment: draftAttachmentController.onRetryDraftAttachment,
      conversationStarted,
      messageSubmitted,
      runStarted,
      streamError,
      cancelSelectedRun
    },
    controlPlane,
    toolDisplay: {
      open: displayPanelOpen
    },
    approvalRevision: {
      currentUserId: meQuery.data?.id,
      // `getConfig` is the caller's Personal Workspace view of the agents.
      personalWorkspaceAgentName: (proposingAgentName) =>
        activeAgentNameFor(configQuery.data, proposingAgentName),
      startRevision: (input) =>
        void startApprovalRevision(input, {
          startRun: startRevisionRun,
          isConversationGone: (error) => apiErrorStatus(error) === 404,
          leaveInComposer: (conversationId, text) =>
            leaveRevisionInComposer(conversationId, text, input.failureNotice)
        }),
      agentDisplayName: (agentName) =>
        configQuery.data?.agents.find((agent) => agent.name === agentName)?.displayName,
      // The address without a workspace resolves to the conversation's own.
      openConversation: (conversationId) =>
        routeState.showRoute({ kind: "legacy-conversation", conversationId })
    }
  };
}

const NO_CONVERSATIONS: readonly ConversationListItem[] = [];

// The code a run is failed with when no worker took it within its queue limit.
const RUN_NOT_STARTED_CODE = "AGENT_RUN_NOT_STARTED";

/**
 * What the person reads above the composer when a run ended as failed or cancelled. The
 * reason of a cancellation and the message of an interruption are written for operators, so
 * the person reads a sentence in their language instead.
 */
export function terminalRunNotice(
  error: ConversationControllerState["error"],
  t: TranslationContextValue["t"]
): string | undefined {
  if (error?.class === "run_cancelled") return t("runStopped");
  if (error?.class !== "run_failed") return undefined;
  if (error.category !== "runtime_interrupted") return error.message;
  return error.code === RUN_NOT_STARTED_CODE ? t("runNotStarted") : t("runInterrupted");
}
