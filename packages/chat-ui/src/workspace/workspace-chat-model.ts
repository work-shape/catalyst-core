import { useEffect, useState, type CSSProperties } from "react";
import type {
  ApiClient,
  ApiUser,
  ChangeCurrentUserPasswordRequest,
  ConversationListItem,
  DraftAttachment,
  LocaleCode,
  Message,
  SafeConfig,
  StartConversationRunResponse,
  UpdateCurrentUserRequest
} from "@vivd-catalyst/api-client";
import { useWorkspaceApiClient } from "../api/workspace-api-client";
import {
  useCancelRunMutation,
  useChangeCurrentUserPasswordMutation,
  useDeleteConversationMutation,
  useSuperadminUserMutations,
  useUpdateCurrentUserMutation,
  useWorkspaceSignOutMutation
} from "../api/workspace-mutations";
import {
  useWorkspaceAuditEventsQuery,
  useWorkspaceCacheActions,
  useWorkspaceConfigQuery,
  useWorkspaceConversationsQuery,
  useWorkspaceMeQuery,
  useWorkspaceThreadQuery,
  useWorkspaceUsageQuery,
  useWorkspaceUsersQuery
} from "../api/workspace-queries";
import type { LocalUploadingAttachment } from "../assistant-composer";
import type { ChatFileDropzoneController } from "../chat-file-dropzone";
import type { ChatShellAdminPanel } from "../chat-shell";
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
  STANDALONE_AUTH_SOURCE
} from "../workspace-utils";
import { useWorkspaceDraft, useWorkspaceDraftController } from "./workspace-drafts";
import {
  useWorkspaceChromeState,
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
  isSuperadmin: boolean;
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
  isSuperadmin: boolean;
  view: WorkspaceView;
  creatingConversation: boolean;
  deletingConversation: boolean;
  startNewConversation(): void;
  selectConversation(conversationId: string): void;
  deleteConversation(conversationId: string): void;
  selectWorkspaceView(view: WorkspaceView): void;
}

export interface SelectedChatModel {
  client: ApiClient;
  config: SafeConfig | undefined;
  selectedConversationId: string | undefined;
  messages: Message[] | undefined;
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
  conversationStarted(conversationId: string, messages?: Message[]): void;
  messageSubmitted(conversationId: string): void;
  runStarted(response: StartConversationRunResponse): void;
  streamFinished(conversationId: string, viewed: boolean): void;
  streamError(conversationId: string, message: string, viewed: boolean): void;
  cancelSelectedRun(): void;
}

export interface ControlPlaneModel {
  settings: SettingsModel;
  superadmin: SuperadminModel;
}

export interface SettingsModel {
  user: ApiUser | undefined;
  canChangePassword: boolean;
  updatingProfile: boolean;
  changingPassword: boolean;
  locales: LocaleCode[];
  locale: LocaleCode;
  updateProfile(input: UpdateCurrentUserRequest): Promise<ApiUser>;
  changePassword(input: ChangeCurrentUserPasswordRequest): Promise<unknown>;
  selectLocale(locale: LocaleCode): void;
}

export interface SuperadminModel {
  shouldRender: boolean;
  panelInput: SuperadminPanelInput;
}

export type SuperadminPanelInput = Parameters<ChatShellAdminPanel["renderPanel"]>[0];

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
  const isSuperadmin = adminPanel?.canView(meQuery.data) ?? false;
  const usageQuery = useWorkspaceUsageQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    enabled: isSuperadmin && view === "superadmin"
  });
  const auditQuery = useWorkspaceAuditEventsQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    enabled: isSuperadmin && view === "superadmin"
  });
  const usersQuery = useWorkspaceUsersQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    enabled: isSuperadmin && view === "superadmin"
  });

  const workspaceCache = useWorkspaceCacheActions({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    selectedConversationId
  });
  const controller = useConversationController({
    client,
    conversationId: selectedConversationId,
    enabled: isAuthenticated && Boolean(selectedConversationId),
    snapshot: threadQuery.data,
    snapshotLoading: threadQuery.isLoading,
    snapshotError: threadQuery.error,
    refreshSnapshot: workspaceCache.refreshSelectedThreadSnapshot,
    onTerminalObservation: workspaceCache.invalidateTerminalRunObservation
  });
  const conversations = conversationsQuery.data ?? [];
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

  useEffect(() => {
    displayPanel.close();
  }, [displayPanel.close, selectedConversationId]);

  useEffect(() => {
    if (isAuthenticated && route.kind === "superadmin" && !isSuperadmin) {
      routeState.goToDefaultChat({ replace: true });
    }
  }, [isAuthenticated, isSuperadmin, route.kind, routeState]);

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

  useEffect(() => {
    if (!manageDocumentTitle || !config?.ui.title) {
      return undefined;
    }
    const previousTitle = document.title;
    document.title = config.ui.title;
    return () => {
      if (document.title === config.ui.title) {
        document.title = previousTitle;
      }
    };
  }, [config?.ui.title, manageDocumentTitle]);

  useEffect(() => {
    if (!manageDocumentTitle) {
      return;
    }
    applyFavicon(config?.ui.faviconUrl ?? "/favicon.svg");
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
  const signOutMutation = useWorkspaceSignOutMutation({
    apiBaseUrl,
    onSignedOut: () => {
      draftController.clearDrafts();
      clearRunCursors();
      routeState.resetRouteMemory();
      routeState.goToDefaultChat({ replace: true });
    }
  });
  const cancelRunMutation = useCancelRunMutation({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    onErrorMessage: setNotice
  });
  const updateCurrentUser = useUpdateCurrentUserMutation({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client
  });
  const changeCurrentUserPassword = useChangeCurrentUserPasswordMutation({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client
  });
  const superadminUserMutations = useSuperadminUserMutations({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client
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
    conversationStarted(response.conversation.id);
    chatRequestAccepted(response.conversation.id);
  }

  function chatRequestAccepted(conversationId: string) {
    workspaceCache.handleChatRequestAccepted(conversationId);
  }

  function streamFinished(conversationId: string) {
    setNotice(undefined);
    workspaceCache.invalidateStreamFinished(conversationId);
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
      isSuperadmin
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
      isSuperadmin,
      view,
      creatingConversation: false,
      deletingConversation: deleteConversationMutation.isPending,
      startNewConversation,
      selectConversation,
      deleteConversation: (conversationId) => deleteConversationMutation.mutate(conversationId),
      selectWorkspaceView: routeState.selectWorkspaceView
    },
    selectedChat: {
      client,
      config,
      selectedConversationId,
      messages,
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
      streamFinished,
      streamError,
      cancelSelectedRun
    },
    controlPlane: {
      settings: {
        user: meQuery.data,
        canChangePassword: meQuery.data?.authSource === STANDALONE_AUTH_SOURCE,
        updatingProfile: updateCurrentUser.isPending,
        changingPassword: changeCurrentUserPassword.isPending,
        locales: supportedLocales,
        locale: activeLocale,
        updateProfile: (input) => updateCurrentUser.mutateAsync(input),
        changePassword: (input) => changeCurrentUserPassword.mutateAsync(input),
        selectLocale: preferences.selectLocale
      },
      superadmin: {
        shouldRender: view === "superadmin" && isSuperadmin,
        panelInput: {
          usage: usageQuery.data,
          auditEvents: auditQuery.data ?? [],
          users: usersQuery.data ?? [],
          loading: usageQuery.isLoading || auditQuery.isLoading,
          usersLoading: usersQuery.isLoading,
          error: usageQuery.error
            ? apiErrorMessage(usageQuery.error, undefined)
            : auditQuery.error
              ? apiErrorMessage(auditQuery.error, undefined)
              : undefined,
          usersError: usersQuery.error ? apiErrorMessage(usersQuery.error, undefined) : undefined,
          usersMutating: superadminUserMutations.isPending,
          onCreateUser: (input) => superadminUserMutations.createUser.mutateAsync(input),
          onUpdateUser: (userId, update) =>
            superadminUserMutations.updateUser.mutateAsync({ userId, update }),
          onUpsertUserIdentity: (userId, identity) =>
            superadminUserMutations.upsertUserIdentity.mutateAsync({ userId, identity }),
          onDeleteUserIdentity: (userId, identity) =>
            superadminUserMutations.deleteUserIdentity.mutateAsync({ userId, identity }),
          onResetUserPassword: (userId, password) =>
            superadminUserMutations.resetUserPassword.mutateAsync({ userId, password }),
          selectedTab: route.kind === "superadmin" ? route.tab : "usage",
          onSelectTab: routeState.showSuperadmin
        }
      }
    },
    toolDisplay: {
      open: displayPanelOpen
    }
  };
}

function isVisibleTerminalControllerError(errorClass: string | undefined): boolean {
  return errorClass === "run_failed" || errorClass === "run_cancelled";
}
