import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type {
  ApiClient,
  ApiUser,
  ConversationListItem,
  DraftAttachment,
  LocaleCode,
  Message,
  SafeConfig,
  StartConversationRunResponse
} from "@vivd-catalyst/api-client";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import {
  useCancelRunMutation,
  useDeleteConversationMutation,
  useRenameConversationMutation,
  useWorkspaceSignOutMutation
} from "../api/workspace-mutations";
import {
  useWorkspaceCacheActions,
  useWorkspaceConfigQuery,
  useWorkspaceConversationsQuery,
  useWorkspaceMeQuery,
  useWorkspaceThreadQuery
} from "../api/workspace-queries";
import type { LocalUploadingAttachment } from "../assistant-composer";
import type { ChatFileDropzoneController } from "../chat-file-dropzone";
import type { ChatShellAdminPanel } from "../chat-shell";
import {
  useControlPlaneModel,
  type ControlPlaneModel
} from "../control-plane/control-plane-model";
import { clearRunCursors } from "../conversation/run-connection-manager";
import {
  isLiveRunStatus,
  type ConversationControllerState
} from "../conversation/conversation-controller-state";
import { useConversationController } from "../conversation/use-conversation-controller";
import { useDraftAttachmentController } from "../draft-attachment-controller";
import { useChatFileDropzone } from "../chat-file-dropzone";
import { useToolDisplayPanel } from "../tool-display-panel";
import type { ResolvedThemeMode } from "../theme";
import type { WorkspaceView } from "../workspace-rail";
import type { WorkspaceRoute } from "../workspace-route";
import {
  apiErrorMessage,
  apiErrorStatus,
  applyFavicon,
  createEnvironmentDocumentTitle
} from "../workspace-utils";
import { useWorkspaceDraft, useWorkspaceDraftController } from "./workspace-drafts";
import {
  useWorkspaceChromeState,
  useWorkspaceConversationActivityState,
  useWorkspaceLocale,
  useWorkspacePreferences,
  useWorkspaceRouteState,
  useWorkspaceTheme
} from "./workspace-ui-state";

const WORKSPACE_AUTH_SCOPE = "standalone";

export interface WorkspaceChatModelInput {
  adminPanel: ChatShellAdminPanel | undefined;
  manageDocumentTitle: boolean | undefined;
}

export interface WorkspaceChatModel {
  auth: WorkspaceAuthModel;
  config: WorkspaceConfigModel;
  route: WorkspaceRouteModel;
  chrome: WorkspaceChromeModel;
  conversationRail: ConversationRailModel;
  selectedChat: SelectedChatModel;
  controlPlane: ControlPlaneModel;
  toolDisplay: ToolDisplayModel;
}

export interface WorkspaceAuthModel {
  apiBaseUrl: string;
  user: ApiUser | undefined;
  loginRequired: boolean;
  sessionError: string | undefined;
  signingOut: boolean;
  signOut(): void;
  openSettings(): void;
  invalidateCurrentUser(): void;
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
  view: WorkspaceView;
  creatingConversation: boolean;
  deletingConversation: boolean;
  startNewConversation(): void;
  selectConversation(conversationId: string): void;
  renameConversation(conversationId: string, title: string): Promise<void>;
  deleteConversation(conversationId: string): void;
  selectWorkspaceView(view: WorkspaceView): void;
}

export interface SelectedChatModel {
  client: ApiClient;
  config: SafeConfig | undefined;
  selectedConversationId: string | undefined;
  messages: Message[] | undefined;
  completedRunProjections: ConversationControllerState["completedRunProjections"];
  messagesLoaded: boolean;
  notice: string | undefined;
  draft: string;
  composerFocusRequestId: number;
  locale: LocaleCode;
  selectedAgentName: string | undefined;
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
  manageDocumentTitle
}: WorkspaceChatModelInput): WorkspaceChatModel {
  const [notice, setNotice] = useState<string | undefined>();
  const [selectedAgentName, setSelectedAgentName] = useState<string | undefined>();
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
  const conversationsQuery = useWorkspaceConversationsQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
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

  const workspaceCache = useWorkspaceCacheActions({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client
  });
  const controller = useConversationController({
    client,
    conversationId: selectedConversationId,
    enabled: isAuthenticated && Boolean(selectedConversationId),
    snapshot: threadQuery.data,
    snapshotLoading: threadQuery.isLoading,
    snapshotError: threadQuery.error,
    refreshSnapshot: workspaceCache.refreshThreadSnapshot,
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
  const controllerTerminalNotice = isVisibleTerminalControllerError(controller.error?.class)
    ? controller.error?.message
    : undefined;
  const visibleNotice = notice ?? controllerTerminalNotice;
  const config = configQuery.data;
  const attachmentsEnabled = config?.features.attachments.enabled ?? false;
  const attachmentAccept = config?.features.attachments.accept ?? "";
  const activeLocale = useWorkspaceLocale(config?.localization.locale);

  async function ensureConversationForFiles(files: File[]): Promise<string> {
    if (selectedConversationId) {
      return selectedConversationId;
    }
    const title =
      files.length === 1 ? files[0]?.name ?? "Attached file" : `${files.length} attached files`;
    const conversation = await client.createConversation({
      title,
      locale: activeLocale
    });
    draftController.moveDraft({
      authScope: WORKSPACE_AUTH_SCOPE,
      fromConversationId: undefined,
      toConversationId: conversation.id
    });
    routeState.showConversation(conversation.id, { replace: route.kind === "new-conversation" });
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
  const activeAgentName = selectedAgentName ?? config?.defaultAgentName ?? config?.agents[0]?.name;
  const displayPanelOpen = Boolean(displayPanel.entry && displayPanel.open);

  function resetAuthenticatedWorkspaceState() {
    draftController.clearDrafts();
    conversationActivity.resetConversationActivity();
    clearRunCursors();
    routeState.resetRouteMemory();
    routeState.goToDefaultChat({ replace: true });
  }

  const controlPlane = useControlPlaneModel({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    adminPanel,
    user: meQuery.data,
    configAssetManagement: config?.features.configAssets,
    isAuthenticated,
    route,
    view,
    supportedLocales,
    activeLocale,
    selectLocale: preferences.selectLocale,
    goToDefaultChat: routeState.goToDefaultChat,
    onAccountDeleted: resetAuthenticatedWorkspaceState,
    showSuperadmin: routeState.showSuperadmin
  });
  const canViewAdministration = controlPlane.canViewAdministration;

  useEffect(() => {
    displayPanel.close();
  }, [displayPanel.close, selectedConversationId]);

  useEffect(() => {
    if (!config?.agents.length) {
      return;
    }

    setSelectedAgentName((currentAgentName) => {
      if (currentAgentName && config.agents.some((agent) => agent.name === currentAgentName)) {
        return currentAgentName;
      }
      return config.agents.find((agent) => agent.name === config.defaultAgentName)?.name ?? config.agents[0]?.name;
    });
  }, [config]);

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
    selectedConversationId,
    clearConversationUploads: draftAttachmentController.clearConversationUploads,
    onDeletedActiveConversation: (nextSelectedConversationId) => {
      if (nextSelectedConversationId) {
        routeState.showConversation(nextSelectedConversationId, { replace: true });
        return;
      }
      routeState.goToDefaultChat({ replace: true });
    },
    onDeletedConversation: () => setNotice(undefined),
    onErrorMessage: setNotice
  });
  const renameConversationMutation = useRenameConversationMutation({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
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
    onErrorMessage: setNotice
  });

  function cancelSelectedRun() {
    if (!selectedConversationId || !controller.activeRun || !isLiveRunStatus(controller.activeRun.run.status)) {
      return;
    }
    cancelRunMutation.mutate({
      conversationId: selectedConversationId,
      runId: controller.activeRun.run.id
    });
  }

  function startNewConversation() {
    routeState.goToDefaultChat();
    setNotice(undefined);
    chrome.requestComposerFocus();
  }

  function conversationStarted(conversationId: string) {
    routeState.showConversation(conversationId, { replace: route.kind === "new-conversation" });
    setNotice(undefined);
    workspaceCache.invalidateConversationStarted(conversationId);
  }

  function messageSubmitted(conversationId: string) {
    activeDraft.clearDraft();
    draftController.clearDraft({ authScope: WORKSPACE_AUTH_SCOPE, conversationId });
    workspaceCache.clearDraftAttachments(conversationId);
    draftAttachmentController.clearConversationUploads(conversationId);
  }

  function runStarted(response: StartConversationRunResponse) {
    workspaceCache.cacheRunStarted(response);
    routeState.showConversation(response.conversation.id, { replace: route.kind === "new-conversation" });
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
    routeState.showConversation(conversationId);
    setNotice(undefined);
  }

  return {
    auth: {
      apiBaseUrl,
      user: meQuery.data,
      loginRequired: apiErrorStatus(meQuery.error) === 401,
      sessionError: meQuery.error ? apiErrorMessage(meQuery.error, undefined) : undefined,
      signingOut: signOutMutation.isPending,
      signOut: () => signOutMutation.mutate(),
      openSettings: routeState.showSettings,
      invalidateCurrentUser: workspaceCache.invalidateCurrentUser
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
    conversationRail: {
      conversations,
      selectedConversationId,
      canViewAdministration,
      view,
      creatingConversation: false,
      deletingConversation: deleteConversationMutation.isPending,
      startNewConversation,
      selectConversation,
      renameConversation: async (conversationId, title) => {
        await renameConversationMutation.mutateAsync({ conversationId, title });
      },
      deleteConversation: (conversationId) => deleteConversationMutation.mutate(conversationId),
      selectWorkspaceView: routeState.selectWorkspaceView
    },
    selectedChat: {
      client,
      config,
      selectedConversationId,
      messages,
      completedRunProjections: controller.completedRunProjections,
      messagesLoaded,
      notice: visibleNotice,
      draft: activeDraft.draft,
      composerFocusRequestId: chrome.composerFocusRequestId,
      locale: activeLocale,
      selectedAgentName: activeAgentName,
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
    }
  };
}

function isVisibleTerminalControllerError(errorClass: string | undefined): boolean {
  return errorClass === "run_failed" || errorClass === "run_cancelled";
}
