import {
  APP_ASSET_KIND,
  type AgentRunProjection,
  type ConversationListItem,
  type PlatformContext,
  type StartConversationRunResponse
} from "@work-shape/catalyst-api-client";
import { acceptStartedRun, listedOpenThread } from "../dock/dock-try";
import { dockKindOfRoute } from "../dock/subject-starters";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useControlPlaneModel } from "../../admin/control-plane/control-plane-model";
import { useApprovalPendingCountQuery } from "../../shared/api/approval-request-api";
import { useRailConversations } from "../../shared/api/rail-conversations";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import {
  useCancelRunMutation,
  useDeleteConversationMutation,
  useRenameConversationMutation,
  useWorkspaceSignOutMutation
} from "../../shared/api/workspace-mutations";
import {
  useCollaborationWorkspaceAgentsQuery,
  usePlatformContextQuery,
  useWorkspaceCacheActions,
  useWorkspaceConfigQuery,
  useWorkspaceMeQuery,
  useWorkspaceModelPreferenceQuery,
  useWorkspaceThreadQuery
} from "../../shared/api/workspace-queries";
import {
  useCollaborationWorkspaceModel,
  type BuildingWorkspace
} from "../../shared/collaboration-workspace/collaboration-workspace-model";
import { canViewUsageGovernance } from "../../shared/governance";
import { createTranslationContext } from "../../shared/i18n";
import { workspaceRoutePath } from "../../shared/routes";
import {
  apiErrorReason,
  apiErrorStatus,
  applyFavicon,
  createEnvironmentDocumentTitle
} from "../../shared/workspace-utils";
import {
  agentListStatus,
  agentsRowShown,
  buildingAgentNameFor,
  editWithBuildingAgent
} from "../../studio/agents/agents-model";
import { appsRowShown, NO_APP_RIGHTS, resolveAppRights } from "../../studio/apps/app-model";
import { inboxPlaces } from "../inbox/inbox-places";
import {
  instanceTimeZoneOf,
  resolveWorkflowRights,
  workflowsAccess,
  workflowsRowShown
} from "../../studio/workflows/workflow-model";
import { startApprovalRevision } from "../approvals/approval-revision-host";
import { resolveContextUsage } from "../assistant/context-usage";
import { isLiveRunStatus } from "../conversation/conversation-controller-state";
import { useDraftAttachmentController } from "../conversation/draft-attachment-controller";
import { useAgentOpens } from "../conversation/use-agent-opens";
import { useConversationController } from "../conversation/use-conversation-controller";
import { useFollowUpSource } from "../conversation/use-follow-up-queue";
import { useChatFileDropzone } from "../files/chat-file-dropzone";
import { inboxRailEntry } from "../inbox/inbox-model";
import { useToolDisplayPanel } from "../tools/tool-display-panel";
import {
  agentModelSelection,
  conversationModelPicks,
  modelReasoningEffortSelection,
  NO_MODEL_PICKS,
  type ModelPicks
} from "./agent-model-selection";
import { useAccountLocale } from "./account-locale";
import { useConversationListRefresh } from "./use-conversation-list-refresh";
import { useUnreadableDockConversation } from "./use-workspace-dock";
import {
  activeAgentNameFor,
  terminalRunNotice,
  WORKSPACE_AUTH_SCOPE,
  workspaceScopedConfigFor
} from "./workspace-chat-state";
import { isConversationGone } from "../conversation/conversation-gone";
import type { WorkspaceChatModel, WorkspaceChatModelInput } from "./workspace-chat-types";
import { createWorkspaceConversationActions } from "./workspace-conversation-actions";
import { useWorkspaceDraft, useWorkspaceDraftController } from "./workspace-drafts";
import { workspaceSendBlock } from "./workspace-send-block";
import {
  useWorkspaceChromeState,
  useWorkspaceConversationActivityState,
  useWorkspaceLocale,
  useWorkspacePreferences,
  useWorkspaceRouteState,
  useWorkspaceTheme
} from "./workspace-ui-state";
export {
  activeAgentNameFor,
  isAbandonedDraftConversation,
  terminalRunNotice,
  WORKSPACE_AUTH_SCOPE,
  workspaceScopedConfigFor
} from "./workspace-chat-state";
export type {
  SelectedChatModel,
  WorkspaceChatModel,
  WorkspaceChatModelInput
} from "./workspace-chat-types";

export function useWorkspaceChatModel({
  administration,
  manageDocumentTitle,
  collaborationWorkspacesAvailable
}: WorkspaceChatModelInput): WorkspaceChatModel {
  const [notice, setNotice] = useState<string | undefined>();
  // The run whose notice the person answered by picking another model.
  const [answeredRunId, setAnsweredRunId] = useState<string | undefined>();
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
  const { route, selectedConversationId, view, dock } = routeState;
  // Off the chat route the conversation is the dock's: a conversation shown or dropped there
  // stays in the dock of the page.
  const docked = view !== "chat";
  const activeDraft = useWorkspaceDraft({
    authScope: WORKSPACE_AUTH_SCOPE,
    conversationId: selectedConversationId
  });

  const meQuery = useWorkspaceMeQuery({ apiBaseUrl, client });
  const isAuthenticated = Boolean(meQuery.data);
  const { localePreference, selectLocale } = useAccountLocale({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    account: meQuery.data,
    stored: preferences.localePreference,
    selectStored: preferences.selectLocale,
    onErrorMessage: setNotice
  });
  const configQuery = useWorkspaceConfigQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    localePreference,
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
  const { moveDraft } = draftController;
  const keepUnreadableDraft = useCallback(
    (conversationId: string) =>
      moveDraft({
        authScope: WORKSPACE_AUTH_SCOPE,
        fromConversationId: conversationId,
        toConversationId: undefined
      }),
    [moveDraft]
  );
  useUnreadableDockConversation({
    dock,
    docked,
    error: threadQuery.error,
    keepDraft: keepUnreadableDraft
  });
  // Only a settled thread for the conversation actually on screen may decide
  // the canonical URL. A snapshot left over from another conversation, or one
  // still being refetched after a move, would redirect back to a workspace the
  // conversation has already left.
  const loadedConversation =
    threadQuery.data?.conversation.id === selectedConversationId && !threadQuery.isFetching
      ? threadQuery.data?.conversation
      : undefined;
  // The modules are the instance's, so they are read from its own configuration: the
  // workspace's view of it is not there yet while the workspace's agents load.
  const instanceModules = configQuery.data?.modules;
  const appsEnabled = collaborationWorkspacesAvailable && instanceModules?.apps?.enabled === true;
  const platformContextQuery = usePlatformContextQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    enabled:
      isAuthenticated &&
      (appsEnabled ||
        (collaborationWorkspacesAvailable && instanceModules?.workflows?.enabled === true))
  });
  // Where the person builds without being a member: an App draft there opens. Known once the
  // instance's configuration said whether Apps are on, and where they are, once it said where.
  const buildingContext =
    configQuery.isError ||
    platformContextQuery.isError ||
    (configQuery.data !== undefined && !appsEnabled)
      ? NO_CONTEXT_WORKSPACES
      : platformContextQuery.data;
  const buildingWorkspaces = useMemo(
    () => buildingWorkspacesOf(buildingContext),
    [buildingContext]
  );
  const collaborationWorkspace = useCollaborationWorkspaceModel({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    isAuthenticated,
    enabled: collaborationWorkspacesAvailable,
    userId: meQuery.data?.id,
    route,
    buildingWorkspaces,
    loadedConversationCollaborationWorkspaceId: loadedConversation?.collaborationWorkspaceId,
    legacyConversationUnavailable:
      route.kind === "legacy-conversation" && Boolean(threadQuery.error),
    goToCollaborationWorkspace: routeState.goToDefaultChat,
    showConversation: routeState.showConversation,
    showSettings: routeState.showSettings
  });
  const activeCollaborationWorkspaceId = collaborationWorkspace.activeCollaborationWorkspaceId;
  // The workspace whose next new conversation starts private, after "Continue privately".
  const [privateStartIn, setPrivateStartIn] = useState<string | undefined>();
  const startsPrivate =
    privateStartIn !== undefined && privateStartIn === activeCollaborationWorkspaceId;
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
  const followUpSource = useFollowUpSource({
    followUps: controller.followUps,
    currentUserId: meQuery.data?.id,
    refreshThread: workspaceCache.refreshThreadSnapshot
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
  // those, and the thread on screen already holds what its row shows. Try's is in no list.
  const openThread = listedOpenThread(threadQuery.data, selectedConversationId, dock);
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
    localePreference,
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
  const activeLocale = useWorkspaceLocale(config?.localization.locale, localePreference);
  const controllerTerminalNotice = terminalRunNotice(
    controller.error,
    createTranslationContext(activeLocale).t,
    { seesRateCard: canViewUsageGovernance(meQuery.data) }
  );
  // A notice of an ended run goes when another model is picked. The next run is another run,
  // so its notice shows again.
  const endedRunId = controller.activeRun?.run.id;
  const visibleNotice =
    notice ??
    (endedRunId !== undefined && endedRunId === answeredRunId
      ? undefined
      : controllerTerminalNotice);

  const {
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
    leaveRevisionInComposer
  } = createWorkspaceConversationActions({
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
    selectedConversationAbout:
      threadQuery.data !== undefined && threadQuery.data.conversation.id === selectedConversationId
        ? {
            subject: threadQuery.data.conversation.subject,
            collaborationWorkspaceId: threadQuery.data.conversation.collaborationWorkspaceId
          }
        : undefined,
    activeCollaborationWorkspaceId,
    personalCollaborationWorkspaceId: collaborationWorkspace.personalCollaborationWorkspaceId,
    messagesLoaded,
    messages,
    selectedConversationRunning,
    setNotice,
    startsPrivate,
    setPrivateStartIn
  });

  const draftAttachmentController = useDraftAttachmentController({
    enabled: attachmentsEnabled,
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    selectedConversationId,
    collaborationWorkspaceId: activeCollaborationWorkspaceId,
    isAuthenticated,
    createConversationForFiles,
    showConversationForFiles,
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
  // A first save creates only in a conversation of the person's own. Where the open workspace
  // starts conversations its members read, a New button makes a private one first (E3).
  const openWorkspace = collaborationWorkspace.activeCollaborationWorkspace;
  const ownConversations =
    openWorkspace !== undefined &&
    (openWorkspace.kind === "personal" ||
      openWorkspace.defaultConversationVisibility === "private");
  const buildingAgentName =
    openWorkspace === undefined
      ? undefined
      : buildingAgentNameFor(config?.agents ?? [], activeAgentName);
  // The list page a New button opened the dock on, until the dock's first message is sent.
  const newStartedFrom = useRef<string | undefined>(undefined);

  /**
   * "New" on a list (NAV-2): the dock opens on the page with a new conversation with an agent
   * that builds assets and this text in its composer. Nothing is created: the agent's first save
   * creates the asset and takes the person to its page.
   */
  function startBuilding(prompt: string) {
    if (buildingAgentName === undefined) {
      return;
    }
    setSelectedAgentName(buildingAgentName);
    const startedFrom = workspaceRoutePath(route);
    if (!ownConversations) {
      // The members would read a new conversation here: the build starts in a private one.
      startPrivateConversationWith(prompt, true)
        .then((conversationId) => agentOpens.startedFrom(conversationId, startedFrom))
        .catch(() =>
          setNotice(createTranslationContext(activeLocale).t("conversationPrivateStartFailed"))
        );
      return;
    }
    draftController.setDraft(
      { authScope: WORKSPACE_AUTH_SCOPE, conversationId: undefined },
      prompt
    );
    newStartedFrom.current = startedFrom;
    dock.show(undefined);
    setNotice(undefined);
    chrome.requestComposerFocus();
  }
  const buildWithAgent = buildingAgentName === undefined ? undefined : startBuilding;
  const editWithAgent = editWithBuildingAgent(
    buildingAgentName,
    setSelectedAgentName,
    (subject, workspaceId) => startConversationAbout(subject, undefined, workspaceId)
  );
  const displayPanelOpen = Boolean(displayPanel.entry && displayPanel.open);

  // The shell forgets everything else of the person, as it starts a new session.
  function leaveSignedOutSession() {
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
    activeCollaborationWorkspace: collaborationWorkspace.activeCollaborationWorkspace,
    isAuthenticated,
    route,
    view,
    supportedLocales,
    activeLocale,
    selectLocale,
    showContextIndicator: preferences.showContextIndicator,
    setShowContextIndicator: preferences.setShowContextIndicator,
    themePreference,
    selectThemePreference,
    goToDefaultChat: goToActiveCollaborationWorkspaceChat,
    showRoute: routeState.showRoute,
    onAccountDeleted: leaveSignedOutSession,
    onCollaborationWorkspaceDeleted: collaborationWorkspace.collaborationWorkspaceDeleted,
    agentActions: {
      ...(buildWithAgent === undefined ? {} : { buildWithAgent }),
      ...(editWithAgent === undefined ? {} : { editWithAgent }),
      startDockedChat
    }
  });
  const canViewAdministration = controlPlane.canViewAdministration;
  const approvalPendingCountQuery = useApprovalPendingCountQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    enabled: isAuthenticated
  });
  const inbox = inboxRailEntry(approvalPendingCountQuery.data);
  const appRights = useMemo(
    () =>
      appsEnabled
        ? resolveAppRights(platformContextQuery.data, activeCollaborationWorkspaceId)
        : NO_APP_RIGHTS,
    [appsEnabled, platformContextQuery.data, activeCollaborationWorkspaceId]
  );
  const workflowsOpen = workflowsAccess({
    modules: instanceModules,
    workspaces: collaborationWorkspacesAvailable,
    context: platformContextQuery.data
  });
  const instanceTimeZone = instanceTimeZoneOf(platformContextQuery.data);
  const workflowRights = useMemo(
    () =>
      resolveWorkflowRights(
        workflowsOpen === "open" ? platformContextQuery.data : undefined,
        activeCollaborationWorkspaceId
      ),
    [workflowsOpen, platformContextQuery.data, activeCollaborationWorkspaceId]
  );
  // With its module off, an address of the Apps or the Workflows area leads to the chat; so does
  // an address of the Workflows for a person who may read none.
  const areaClosed =
    (view === "apps" && instanceModules !== undefined && !appsEnabled) ||
    (view === "workflows" && workflowsOpen === "closed");
  const { goToDefaultChat } = routeState;
  useEffect(() => {
    if (areaClosed) {
      goToDefaultChat(activeCollaborationWorkspaceId, { replace: true });
    }
  }, [activeCollaborationWorkspaceId, areaClosed, goToDefaultChat]);
  const activeAgent = config?.agents.find((agent) => agent.name === activeAgentName);
  const selectedThread =
    threadQuery.data?.conversation.id === selectedConversationId ? threadQuery.data : undefined;
  const agentOpens = useAgentOpens({
    activeRun: controller.activeRun,
    messages,
    completedRunProjections: controller.completedRunProjections ?? NO_RUN_PROJECTIONS,
    conversationId: selectedConversationId,
    storedSubject: selectedThread?.conversation.subject,
    workspaceId: activeCollaborationWorkspaceId,
    route,
    dock,
    client,
    onSubjectChanged: workspaceCache.invalidateConversationStarted,
    onError: setNotice
  });
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

  // A layout effect: it runs before the effects of the thread, so what the next conversation
  // opens opens after this close and not before it. A conversation that goes into the dock
  // leaves what stood beside it too: the page takes that room.
  useLayoutEffect(() => {
    displayPanel.close();
  }, [displayPanel.close, selectedConversationId, docked]);

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
      if (docked) {
        // The dock does not take another conversation in the place of one that is gone.
        dock.forget();
        return;
      }
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
    onSignedOut: leaveSignedOutSession
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

  function conversationStarted(conversationId: string) {
    showConversationInActiveCollaborationWorkspace(conversationId, {
      replace: route.kind === "new-conversation"
    });
    setNotice(undefined);
    setPrivateStartIn(undefined);
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
    agentOpens.sent(response.run.id);
    // The first message of a dock a New button opened: the list stays where its opens move on.
    const startedFrom = newStartedFrom.current;
    if (startedFrom !== undefined && selectedConversationId === undefined) {
      agentOpens.startedFrom(response.conversation.id, startedFrom);
    }
    newStartedFrom.current = undefined;
    // A Try run stays out of Recent and the address, whatever the dock shows by now.
    acceptStartedRun(response, {
      cache: (listed) => workspaceCache.cacheRunStarted(response, { listed }),
      show: () =>
        showCreatedConversation(response.conversation, {
          replace: route.kind === "new-conversation"
        }),
      list: () => conversationListRefresh.runAccepted(response)
    });
    setNotice(undefined);
    setPrivateStartIn(undefined);
  }

  function streamError(conversationId: string, message: string, viewed: boolean) {
    const visible = viewed || routeState.isConversationVisible(conversationId);
    if (visible) {
      setNotice(message);
    }
    workspaceCache.invalidateStreamError(conversationId);
  }

  return {
    auth: {
      apiBaseUrl,
      user: meQuery.data,
      loginRequired: apiErrorStatus(meQuery.error) === 401,
      sessionUnavailable: Boolean(meQuery.error),
      accountDisabled: apiErrorReason(meQuery.error) === "user_disabled",
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
      localePreference,
      supportedLocales,
      resolvedThemeMode,
      theme,
      activeAgentName,
      selectAgentName: setSelectedAgentName,
      selectLocale,
      toggleTheme,
      attachmentsEnabled,
      attachmentAccept
    },
    route: {
      route,
      view,
      selectedConversationId,
      dock,
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
      // The rail marks the conversation of the chat route; beside a page, the page's row is the
      // current one, and the dock's conversation is only in the dock.
      selectedConversationId: docked ? undefined : selectedConversationId,
      canViewAdministration,
      inbox,
      agents: agentsRowShown(collaborationWorkspacesAvailable, workspaceAgentsQuery.data),
      apps: appsRowShown(appsEnabled, workspaceAgentsQuery.data),
      workflows: workflowsRowShown(workflowsOpen, platformContextQuery.data),
      scheduled: collaborationWorkspacesAvailable,
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
      selectWorkspaceView: (nextView) => {
        // The agents, the Apps, the Workflows and the scheduled prompts of the open workspace:
        // the row has no address without one.
        if (
          (nextView === "agents" ||
            nextView === "apps" ||
            nextView === "workflows" ||
            nextView === "scheduled") &&
          activeCollaborationWorkspaceId
        ) {
          routeState.showRoute({
            kind: nextView,
            collaborationWorkspaceId: activeCollaborationWorkspaceId
          });
          return;
        }
        routeState.selectWorkspaceView(nextView);
      }
    },
    agents: {
      status: agentListStatus({
        // While another workspace's list stands in, this workspace's has not arrived.
        loaded: workspaceAgentsQuery.data !== undefined && !workspaceAgentsQuery.isPlaceholderData,
        failed: workspaceAgentsQuery.isError
      }),
      // A reload that fails again shows in the state of the query.
      retry: () => {
        workspaceAgentsQuery.refetch().catch(() => undefined);
      },
      startChat: (agentName) => {
        setSelectedAgentName(agentName);
        startNewConversation();
      }
    },
    apps: {
      enabled: appsEnabled,
      rights: appRights,
      startChat: startNewConversationWith,
      editWithAgent: (app) =>
        startConversationAbout({ kind: APP_ASSET_KIND, name: app }, undefined),
      ...(buildWithAgent !== undefined && appRights.write ? { startNew: buildWithAgent } : {})
    },
    workflows: {
      access: workflowsOpen,
      rights: workflowRights,
      ...(instanceTimeZone === undefined ? {} : { instanceTimeZone }),
      editWithAgent: (workflow, prompt) =>
        startConversationAbout({ kind: WORKFLOW_ASSET_KIND, name: workflow }, prompt),
      // A new Workflow is made among the instance's own, the one owner the instance takes.
      ...(buildWithAgent !== undefined && workflowRights.instance.write
        ? { startNew: buildWithAgent }
        : {})
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
      selectedConversationSubject: selectedThread?.conversation.subject,
      selectedConversationTitle: selectedThread?.conversation.title,
      // On its own route a conversation that is gone says so; the dock opens empty instead.
      conversationGone:
        !docked && selectedConversationId !== undefined && isConversationGone(threadQuery.error),
      startNewConversation,
      docked,
      dockKind: docked ? dockKindOfRoute(route) : undefined,
      agentOpens,
      // A page the conversation links to opens with the conversation in the dock beside it.
      openRoute: (target) =>
        selectedConversationId === undefined
          ? routeState.showRoute(target)
          : dock.openPage(target, selectedConversationId),
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
      selectModelBindingId: (modelBindingId) => {
        if (modelBindingId !== selectedModelBindingId) {
          setNotice(undefined);
          setAnsweredRunId(endedRunId);
        }
        changeModelPicks({
          ...(modelBindingId && modelBindingId !== selectableModels[0]?.bindingId
            ? { modelBindingId }
            : {}),
          reasoningEfforts: modelPicks.reasoningEfforts
        });
      },
      selectReasoningEffort: (modelBindingId, effort) =>
        changeModelPicks({
          ...modelPicks,
          reasoningEfforts: { ...modelPicks.reasoningEfforts, [modelBindingId]: effort }
        }),
      draftAttachments: draftAttachmentController.draftAttachments,
      localUploadingAttachments: draftAttachmentController.visibleUploadingAttachments,
      conversationRunning: selectedConversationRunning,
      activeRun: controller.activeRun,
      followUpSource,
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
      sendStagedFiles: draftAttachmentController.sendStagedFiles,
      removeDraftAttachment: draftAttachmentController.onRemoveDraftAttachment,
      retryDraftAttachment: draftAttachmentController.onRetryDraftAttachment,
      conversationStarted,
      messageSubmitted,
      runStarted,
      streamError,
      cancelSelectedRun,
      continuePrivately: async (prompt: string) => {
        try {
          continuePrivatelyWith(prompt);
        } catch {
          setNotice(createTranslationContext(activeLocale).t("conversationPrivateStartFailed"));
        }
      },
      startsPrivate
    },
    controlPlane,
    toolDisplay: {
      open: displayPanelOpen
    },
    approvalRevision: {
      currentUserId: meQuery.data?.id,
      instanceAdminName: meQuery.data?.instanceAdminName,
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
        routeState.showRoute({ kind: "legacy-conversation", conversationId }),
      openInboxItem: (itemId) => routeState.showRoute({ kind: "inbox-item", itemId }),
      openRoute: (route) => routeState.showRoute(route),
      places: inboxPlaces({
        context: platformContextQuery.data,
        workspaces: collaborationWorkspace.collaborationWorkspaces,
        ownerLabel: meQuery.data && (meQuery.data.displayLabel || meQuery.data.email),
        appsOpen: appsEnabled,
        workflowsOpen: workflowsOpen === "open"
      })
    }
  };
}

const NO_CONVERSATIONS: readonly ConversationListItem[] = [];
const NO_RUN_PROJECTIONS: Readonly<Record<string, AgentRunProjection>> = {};

const NO_CONTEXT_WORKSPACES: Pick<PlatformContext, "workspaces"> = { workspaces: [] };

/** The Shared Workspaces of the context the person is no member of; undefined until read. */
function buildingWorkspacesOf(
  context: Pick<PlatformContext, "workspaces"> | undefined
): BuildingWorkspace[] | undefined {
  return context?.workspaces.filter(
    (workspace) => workspace.kind === "shared" && !workspace.member
  );
}
