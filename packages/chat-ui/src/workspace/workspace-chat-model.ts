import { useEffect, useMemo, useState, type CSSProperties } from "react";
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
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import {
  useCancelRunMutation,
  useDeleteConversationMutation,
  useRenameConversationMutation,
  useWorkspaceSignOutMutation
} from "../api/workspace-mutations";
import {
  useCollaborationWorkspaceAgentsQuery,
  useWorkspaceCacheActions,
  useWorkspaceConfigQuery,
  useWorkspaceConversationsQuery,
  useWorkspaceMeQuery,
  useWorkspaceThreadQuery
} from "../api/workspace-queries";
import {
  useCollaborationWorkspaceModel,
  type CollaborationWorkspaceModel
} from "../collaboration-workspace/collaboration-workspace-model";
import type { LocalUploadingAttachment } from "../assistant/assistant-composer";
import type { ChatFileDropzoneController } from "../chat-file-dropzone";
import type { ChatShellAdminPanel } from "../chat-shell";
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
import type { WorkspaceRoute } from "./workspace-route";
import {
  apiErrorMessage,
  apiErrorStatus,
  applyFavicon,
  createEnvironmentDocumentTitle
} from "../workspace-utils";
import { agentModelSelection, type AgentSelectableModel } from "./agent-model-selection";
import { useWorkspaceDraft, useWorkspaceDraftController } from "./workspace-drafts";
import {
  useWorkspaceChromeState,
  useWorkspaceConversationActivityState,
  useWorkspaceLocale,
  useWorkspacePreferences,
  useWorkspaceRouteState,
  useWorkspaceTheme
} from "./workspace-ui-state";
import { createTranslationContext } from "../i18n";

export const WORKSPACE_AUTH_SCOPE = "standalone";

/**
 * Collaboration Workspace chrome — the rail selector, the dialogs panel and
 * the conversation move action — is opt-in per client instance. With it off
 * a first-party session keeps its `collaboration_workspace:read` scope, so
 * routing, the workspace list query and the Personal Workspace stay exactly as
 * they are and only the visible surfaces are withheld.
 */
export function collaborationWorkspaceChromeVisibleFor(input: {
  collaborationWorkspacesAvailable: boolean;
  config: SafeConfig | undefined;
}): boolean {
  return (
    input.collaborationWorkspacesAvailable &&
    (input.config?.features.collaborationWorkspaces.enabled ?? false)
  );
}

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
        agents: input.workspaceAgents.agents,
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
  adminPanel: ChatShellAdminPanel | undefined;
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
  /** False when the auth mode or the client instance config withholds the chrome. */
  collaborationWorkspaceChromeVisible: boolean;
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
  openSettings(): void;
  invalidateCurrentUser(): void;
  retryCurrentUser(): void;
}

export interface WorkspaceConfigModel {
  config: SafeConfig | undefined;
  error: string | undefined;
  activeLocale: LocaleCode;
  localePreference: LocaleCode | undefined;
  supportedLocales: LocaleCode[];
  resolvedThemeMode: ResolvedThemeMode;
  workspaceStyle: CSSProperties;
  activeAgentName: string | undefined;
  selectAgentName(agentName: string | undefined): void;
  selectLocale(locale: LocaleCode): void;
  toggleTheme(): void;
  attachmentsEnabled: boolean;
  attachmentAccept: string;
}

export interface WorkspaceRouteModel {
  route: WorkspaceRoute;
  view: WorkspaceView;
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
}

export interface WorkspaceChromeModel {
  sidebarOpen: boolean;
  composerFocusRequestId: number;
  closeSidebar(): void;
  toggleSidebar(): void;
}

export interface ConversationRailModel {
  conversations: ConversationListItem[];
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
  /** Present only for users who may review Approval Requests. */
  approvals: { pendingCount: number } | undefined;
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
  messages: Message[] | undefined;
  completedRunProjections: ConversationControllerState["completedRunProjections"];
  messagesLoaded: boolean;
  notice: string | undefined;
  draft: string;
  composerFocusRequestId: number;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
  /** The active agent's own model first, then the models users may pick instead. */
  selectableModels: AgentSelectableModel[];
  selectedModelBindingId: string | undefined;
  showContextIndicator: boolean;
  contextSnapshot:
    | {
        inputTokens: number;
        compactThresholdTokens: number;
      }
    | undefined;
  selectAgentName(agentName: string): void;
  selectModelBindingId(modelBindingId: string): void;
  draftAttachments: DraftAttachment[];
  localUploadingAttachments: LocalUploadingAttachment[];
  conversationRunning: boolean;
  activeRun: ConversationControllerState["activeRun"];
  sendBlockedReason: string | undefined;
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
  adminPanel,
  manageDocumentTitle,
  collaborationWorkspacesAvailable
}: WorkspaceChatModelInput): WorkspaceChatModel {
  const [notice, setNotice] = useState<string | undefined>();
  const [selectedAgentName, setSelectedAgentName] = useState<string | undefined>();
  const [pickedModelBindingId, setPickedModelBindingId] = useState<string | undefined>();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
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
    showConversation: routeState.showConversation
  });
  const activeCollaborationWorkspaceId = collaborationWorkspace.activeCollaborationWorkspaceId;
  const conversationsQuery = useWorkspaceConversationsQuery({
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
  const serverConversations = conversationsQuery.data ?? [];
  const hasListedActiveRun = serverConversations.some((conversation) => conversation.activeRun);

  useEffect(() => {
    if (!isAuthenticated || !hasListedActiveRun) {
      return undefined;
    }
    const intervalId = window.setInterval(() => {
      workspaceCache.invalidateConversations();
    }, 1_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [hasListedActiveRun, isAuthenticated, workspaceCache.invalidateConversations]);

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
  const selectedConversationRunning = Boolean(
    controller.activeRun && isLiveRunStatus(controller.activeRun.run.status)
  );
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
  const collaborationWorkspaceChromeVisible = collaborationWorkspaceChromeVisibleFor({
    collaborationWorkspacesAvailable,
    config
  });
  const activeLocale = useWorkspaceLocale(config?.localization.locale);
  const controllerTerminalNotice = isVisibleTerminalControllerError(controller.error?.class)
    ? controller.error?.category === "runtime_interrupted"
      ? createTranslationContext(activeLocale).t("runInterrupted")
      : controller.error?.message
    : undefined;
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
      title,
      locale: activeLocale,
      ...(activeCollaborationWorkspaceId
        ? { collaborationWorkspaceId: activeCollaborationWorkspaceId }
        : {})
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

  const draftAttachmentController = useDraftAttachmentController({
    enabled: attachmentsEnabled,
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    selectedConversationId,
    isAuthenticated,
    ensureConversationForFiles,
    onError: setNotice
  });
  const fileDropzone = useChatFileDropzone({
    enabled: attachmentsEnabled,
    onFilesSelected: draftAttachmentController.onFilesSelected
  });
  const supportedLocales =
    config?.localization.supportedLocales ?? preferences.supportedFallbackLocales;
  const { resolvedThemeMode, workspaceStyle, toggleTheme } = useWorkspaceTheme(config?.ui);
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
    adminPanel,
    user: meQuery.data,
    configAssetManagement: config?.features.configAssets,
    userInvitationsEnabled: config?.features.userInvitations.enabled ?? false,
    isAuthenticated,
    route,
    view,
    supportedLocales,
    activeLocale,
    selectLocale: preferences.selectLocale,
    showContextIndicator: preferences.showContextIndicator,
    setShowContextIndicator: preferences.setShowContextIndicator,
    goToDefaultChat: goToActiveCollaborationWorkspaceChat,
    onAccountDeleted: resetAuthenticatedWorkspaceState,
    showSuperadmin: routeState.showSuperadmin
  });
  const canViewAdministration = controlPlane.canViewAdministration;
  const approvalPendingCountQuery = useApprovalPendingCountQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    enabled: isAuthenticated
  });
  const approvals = approvalPendingCountQuery.data?.canReview
    ? { pendingCount: approvalPendingCountQuery.data.count }
    : undefined;
  const approvalReviewUnavailable =
    approvalPendingCountQuery.isError || approvalPendingCountQuery.data?.canReview === false;

  // Mirrors the administration route guard: a deep link to the review queue
  // falls back to chat once it is known that this user may not review.
  useEffect(() => {
    if (isAuthenticated && route.kind === "approvals" && approvalReviewUnavailable) {
      goToActiveCollaborationWorkspaceChat({ replace: true });
    }
  }, [
    approvalReviewUnavailable,
    goToActiveCollaborationWorkspaceChat,
    isAuthenticated,
    route.kind
  ]);
  const activeAgent = config?.agents.find((agent) => agent.name === activeAgentName);
  const { selectableModels, selectedModel } = agentModelSelection(
    activeAgent,
    pickedModelBindingId
  );
  const selectedModelBindingId = selectedModel?.bindingId;
  const configuredCompactThresholdTokens =
    selectedModel?.compactThresholdTokens ?? activeAgent?.compactThresholdTokens;

  useEffect(() => {
    displayPanel.close();
  }, [displayPanel.close, selectedConversationId]);

  // A pick the active agent does not offer is dropped, so it does not return with a later agent.
  useEffect(() => {
    if (activeAgent && pickedModelBindingId && selectedModelBindingId !== pickedModelBindingId) {
      setPickedModelBindingId(undefined);
    }
  }, [activeAgent, pickedModelBindingId, selectedModelBindingId]);

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
    runRequestAccepted(response.conversation.id);
  }

  function runRequestAccepted(conversationId: string) {
    workspaceCache.handleRunRequestAccepted(conversationId);
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
    runRequestAccepted(response.conversation.id);
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
      openSettings: routeState.showSettings,
      invalidateCurrentUser: workspaceCache.invalidateCurrentUser,
      retryCurrentUser: () => void meQuery.refetch()
    },
    config: {
      config,
      error: configQuery.error ? (apiErrorMessage(configQuery.error, undefined) ?? "") : undefined,
      activeLocale,
      localePreference: preferences.localePreference,
      supportedLocales,
      resolvedThemeMode,
      workspaceStyle,
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
      canViewAdministration
    },
    chrome: {
      sidebarOpen: chrome.sidebarOpen,
      composerFocusRequestId: chrome.composerFocusRequestId,
      closeSidebar: chrome.closeSidebar,
      toggleSidebar: chrome.toggleSidebar
    },
    collaborationWorkspace,
    collaborationWorkspaceChromeVisible,
    conversationRail: {
      conversations,
      selectedConversationId,
      canViewAdministration,
      approvals,
      view,
      creatingConversation: false,
      deletingConversation: deleteConversationMutation.isPending,
      canMoveConversation:
        collaborationWorkspaceChromeVisible && collaborationWorkspace.canMoveConversation,
      startNewConversation,
      selectConversation,
      renameConversation: async (conversationId, title) => {
        await renameConversationMutation.mutateAsync({ conversationId, title });
      },
      moveConversation: (conversationId) => {
        const conversation = conversations.find((candidate) => candidate.id === conversationId);
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
        collaborationWorkspaceChromeVisible &&
        collaborationWorkspace.activeCollaborationWorkspace?.kind === "shared" &&
        collaborationWorkspace.activeCollaborationWorkspace.defaultConversationVisibility ===
          "private",
      selectedConversationId,
      messages,
      completedRunProjections: controller.completedRunProjections,
      messagesLoaded,
      notice: visibleNotice,
      draft: activeDraft.draft,
      composerFocusRequestId: chrome.composerFocusRequestId,
      locale: activeLocale,
      selectedAgentName: activeAgentName,
      selectableModels,
      selectedModelBindingId,
      showContextIndicator: preferences.showContextIndicator,
      contextSnapshot: resolveContextUsage(
        messages,
        configuredCompactThresholdTokens,
        controller.activeRun?.projection
      ),
      selectAgentName: setSelectedAgentName,
      // Picking the agent's own model is not a pick: the next agent then uses its own model too.
      selectModelBindingId: (modelBindingId) =>
        setPickedModelBindingId(
          modelBindingId && modelBindingId !== selectableModels[0]?.bindingId
            ? modelBindingId
            : undefined
        ),
      draftAttachments: draftAttachmentController.draftAttachments,
      localUploadingAttachments: draftAttachmentController.visibleUploadingAttachments,
      conversationRunning: selectedConversationRunning,
      activeRun: controller.activeRun,
      sendBlockedReason: draftAttachmentController.sendBlockedReason,
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
        })
    }
  };
}

function isVisibleTerminalControllerError(errorClass: string | undefined): boolean {
  return errorClass === "run_failed" || errorClass === "run_cancelled";
}
