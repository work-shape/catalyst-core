import { useEffect, useState } from "react";
import { type StartConversationRunResponse } from "@vivd-catalyst/api-client";
import { useWorkspaceApiClient } from "./api/workspace-api-client";
import {
  useCancelRunMutation,
  useChangeCurrentUserPasswordMutation,
  useDeleteConversationMutation,
  useSuperadminUserMutations,
  useUpdateCurrentUserMutation,
  useWorkspaceSignOutMutation
} from "./api/workspace-mutations";
import {
  useWorkspaceAuditEventsQuery,
  useWorkspaceCacheActions,
  useWorkspaceConfigQuery,
  useWorkspaceConversationsQuery,
  useWorkspaceMeQuery,
  useWorkspaceThreadQuery,
  useWorkspaceUsageQuery,
  useWorkspaceUsersQuery
} from "./api/workspace-queries";
import { AssistantChatPanel } from "./assistant-chat-panel";
import type { ChatShellProps } from "./chat-shell";
import { ChatDropOverlay, useChatFileDropzone } from "./chat-file-dropzone";
import { clearRunCursors } from "./conversation/run-connection-manager";
import { useConversationController } from "./conversation/use-conversation-controller";
import { useDraftAttachmentController } from "./draft-attachment-controller";
import { TranslationProvider } from "./i18n";
import { LoginPanel } from "./login-panel";
import { ToolDisplayPanel, useToolDisplayPanel } from "./tool-display-panel";
import { cn } from "./ui/cn";
import { UserMenu } from "./user-menu";
import { UserSettingsPanel } from "./user-settings-panel";
import { SessionCheckPanel, WorkspaceChrome } from "./workspace-chrome";
import { type WorkspaceView, WorkspaceRail } from "./workspace-rail";
import { type WorkspaceRoute, type WorkspaceRouteChangeOptions } from "./workspace-route";
import {
  apiErrorMessage,
  apiErrorStatus,
  applyFavicon,
  STANDALONE_AUTH_SOURCE
} from "./workspace-utils";
import {
  useWorkspaceDraft,
  useWorkspaceDraftController
} from "./workspace/workspace-drafts";
import { WorkspaceProviders } from "./workspace/workspace-providers";
import {
  useWorkspaceChromeState,
  useWorkspaceLocale,
  useWorkspacePreferences,
  useWorkspaceRouteState,
  useWorkspaceTheme
} from "./workspace/workspace-ui-state";

interface ChatWorkspaceProps extends ChatShellProps {
  route: WorkspaceRoute;
  onRouteChange(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
}

export function ChatWorkspace({
  apiBaseUrl,
  token,
  getToken,
  adminPanel,
  manageDocumentTitle,
  className,
  route,
  onRouteChange
}: ChatWorkspaceProps) {
  return (
    <WorkspaceProviders
      apiBaseUrl={apiBaseUrl}
      token={token}
      getToken={getToken}
      route={route}
      onRouteChange={onRouteChange}
    >
      <ChatWorkspaceContent
        adminPanel={adminPanel}
        manageDocumentTitle={manageDocumentTitle}
        className={className}
      />
    </WorkspaceProviders>
  );
}

function ChatWorkspaceContent({
  adminPanel,
  manageDocumentTitle,
  className
}: Pick<ChatWorkspaceProps, "adminPanel" | "manageDocumentTitle" | "className">) {
  const [notice, setNotice] = useState<string | undefined>();
  const [selectedAgentName, setSelectedAgentName] = useState<string | undefined>();
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const routeState = useWorkspaceRouteState();
  const chrome = useWorkspaceChromeState();
  const preferences = useWorkspacePreferences();
  const draftController = useWorkspaceDraftController();
  const displayPanel = useToolDisplayPanel();
  const authScope = "standalone";
  const { route, selectedConversationId, view } = routeState;
  const activeDraft = useWorkspaceDraft({ authScope, conversationId: selectedConversationId });

  const meQuery = useWorkspaceMeQuery({ apiBaseUrl, client });
  const isAuthenticated = Boolean(meQuery.data);
  const configQuery = useWorkspaceConfigQuery({
    apiBaseUrl,
    authScope,
    client,
    localePreference: preferences.localePreference,
    enabled: isAuthenticated
  });
  const conversationsQuery = useWorkspaceConversationsQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: isAuthenticated
  });
  const threadQuery = useWorkspaceThreadQuery({
    apiBaseUrl,
    authScope,
    client,
    conversationId: selectedConversationId,
    enabled: isAuthenticated && Boolean(selectedConversationId)
  });
  const isSuperadmin = adminPanel?.canView(meQuery.data) ?? false;
  const usageQuery = useWorkspaceUsageQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: isSuperadmin && view === "superadmin"
  });
  const auditQuery = useWorkspaceAuditEventsQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: isSuperadmin && view === "superadmin"
  });
  const usersQuery = useWorkspaceUsersQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: isSuperadmin && view === "superadmin"
  });

  const workspaceCache = useWorkspaceCacheActions({
    apiBaseUrl,
    authScope,
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
    controller.activeRun && isActiveRunStatus(controller.activeRun.run.status)
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
    const title = files.length === 1 ? files[0]?.name ?? "Attached file" : `${files.length} attached files`;
    const conversation = await client.createConversation({
      title,
      locale: activeLocale
    });
    draftController.moveDraft({
      authScope,
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
    authScope,
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
  const supportedLocales = config?.localization.supportedLocales ?? preferences.supportedFallbackLocales;
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

  const deleteConversation = useDeleteConversationMutation({
    apiBaseUrl,
    authScope,
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
    authScope,
    client,
    onErrorMessage: setNotice
  });
  const updateCurrentUser = useUpdateCurrentUserMutation({
    apiBaseUrl,
    authScope,
    client
  });
  const changeCurrentUserPassword = useChangeCurrentUserPasswordMutation({
    apiBaseUrl,
    authScope,
    client
  });
  const superadminUserMutations = useSuperadminUserMutations({
    apiBaseUrl,
    authScope,
    client
  });
  const userMenu = (
    <UserMenu
      user={meQuery.data}
      signingOut={signOutMutation.isPending}
      onOpenSettings={routeState.showSettings}
      onSignOut={() => signOutMutation.mutate()}
      placement="top"
      align="start"
    />
  );

  function onCancelSelectedRun() {
    if (!selectedConversationId || !controller.activeRun || !isActiveRunStatus(controller.activeRun.run.status)) {
      return;
    }
    cancelRunMutation.mutate({
      conversationId: selectedConversationId,
      runId: controller.activeRun.run.id
    });
  }

  function onCreateConversation() {
    routeState.goToDefaultChat();
    setNotice(undefined);
    chrome.requestComposerFocus();
  }

  function onConversationStarted(conversationId: string) {
    routeState.showConversation(conversationId, { replace: route.kind === "new-conversation" });
    setNotice(undefined);
    workspaceCache.invalidateConversationStarted(conversationId);
  }

  function onMessageSubmitted(conversationId: string) {
    activeDraft.clearDraft();
    draftController.clearDraft({ authScope, conversationId });
    workspaceCache.clearDraftAttachments(conversationId);
    draftAttachmentController.clearConversationUploads(conversationId);
  }

  function onRunStarted(response: StartConversationRunResponse) {
    workspaceCache.cacheRunStarted(response);
    onConversationStarted(response.conversation.id);
    onChatRequestAccepted(response.conversation.id);
  }

  function onChatRequestAccepted(conversationId: string) {
    workspaceCache.handleChatRequestAccepted(conversationId);
  }

  function onStreamFinished(conversationId: string) {
    setNotice(undefined);
    workspaceCache.invalidateStreamFinished(conversationId);
  }

  function onStreamError(conversationId: string, message: string, viewed: boolean) {
    const visible = viewed || routeState.isConversationVisible(conversationId);
    if (visible) {
      setNotice(message);
    }
    workspaceCache.invalidateStreamError(conversationId);
  }

  function onSelectConversation(conversationId: string) {
    routeState.showConversation(conversationId);
    setNotice(undefined);
  }

  function onWorkspaceViewChange(nextView: WorkspaceView) {
    routeState.selectWorkspaceView(nextView);
  }

  if (apiErrorStatus(meQuery.error) === 401) {
    return (
      <TranslationProvider locale={activeLocale}>
        <LoginPanel
          apiBaseUrl={apiBaseUrl}
          localePreference={preferences.localePreference}
          fallbackLocale={activeLocale}
          onLocaleChange={preferences.selectLocale}
          manageDocumentTitle={manageDocumentTitle}
          onSignedIn={workspaceCache.invalidateCurrentUser}
        />
      </TranslationProvider>
    );
  }

  if (!meQuery.data) {
    return (
      <TranslationProvider locale={activeLocale}>
        <SessionCheckPanel
          className={className}
          error={meQuery.error ? apiErrorMessage(meQuery.error, undefined) : undefined}
        />
      </TranslationProvider>
    );
  }

  return (
    <TranslationProvider locale={activeLocale}>
      <main
        className={cn(
          "relative grid h-dvh w-full min-h-0 overflow-hidden bg-background text-foreground transition-colors md:grid-rows-[minmax(0,1fr)] max-md:grid-cols-1",
          chrome.sidebarOpen ? "md:grid-cols-[18rem_minmax(0,1fr)]" : "md:grid-cols-[minmax(0,1fr)]",
          resolvedThemeMode === "dark" && "dark",
          className
        )}
        style={workspaceStyle}
      >
      {chrome.sidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/35 backdrop-blur-[1px] md:hidden"
          aria-label="Close sidebar"
          onClick={chrome.closeSidebar}
        />
      ) : null}

      {chrome.sidebarOpen ? (
        <div className="fixed inset-y-0 left-0 z-40 w-[min(18rem,calc(100vw-2rem))] min-w-0 translate-x-0 transition-transform duration-200 md:static md:z-auto md:w-auto md:translate-x-0">
            <WorkspaceRail
              config={config}
              conversations={conversations}
              selectedConversationId={selectedConversationId}
            isSuperadmin={isSuperadmin}
            view={view}
            creatingConversation={false}
            deletingConversation={deleteConversation.isPending}
            userMenu={userMenu}
            onToggleSidebar={chrome.closeSidebar}
            onViewChange={onWorkspaceViewChange}
            onCreateConversation={onCreateConversation}
            onSelectConversation={onSelectConversation}
            onDeleteConversation={(conversationId) => deleteConversation.mutate(conversationId)}
          />
        </div>
      ) : null}

      <WorkspaceChrome
        agents={config?.agents ?? []}
        displayPanelOpen={displayPanelOpen}
        sidebarOpen={chrome.sidebarOpen}
        selectedAgentName={activeAgentName}
        themeMode={resolvedThemeMode}
        onSelectAgent={setSelectedAgentName}
        onToggleSidebar={chrome.toggleSidebar}
        onToggleTheme={toggleTheme}
      />

      {view === "superadmin" && isSuperadmin ? (
        adminPanel?.renderPanel({
          usage: usageQuery.data,
          auditEvents: auditQuery.data ?? [],
          users: usersQuery.data ?? [],
          loading: usageQuery.isLoading || auditQuery.isLoading,
          usersLoading: usersQuery.isLoading,
          error:
            usageQuery.error
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
          onSelectTab: (tab) => routeState.showSuperadmin(tab)
        })
      ) : view === "settings" ? (
        <UserSettingsPanel
          user={meQuery.data}
          canChangePassword={meQuery.data?.authSource === STANDALONE_AUTH_SOURCE}
          updatingProfile={updateCurrentUser.isPending}
          changingPassword={changeCurrentUserPassword.isPending}
          locales={supportedLocales}
          locale={activeLocale}
          onUpdateProfile={(input) => updateCurrentUser.mutateAsync(input)}
          onChangePassword={(input) => changeCurrentUserPassword.mutateAsync(input)}
          onSelectLocale={preferences.selectLocale}
        />
      ) : (
        <section className="relative h-full min-h-0 min-w-0">
          <div className="flex h-full min-h-0 min-w-0">
            <div
              className="relative h-full min-h-0 min-w-0 flex-1 transition-[width] duration-300 ease-out"
              onDragEnter={fileDropzone.onChatDragEnter}
              onDragOver={fileDropzone.onChatDragOver}
              onDragLeave={fileDropzone.onChatDragLeave}
              onDrop={fileDropzone.onChatDrop}
            >
              <AssistantChatPanel
                client={client}
                config={config}
                selectedConversationId={selectedConversationId}
                messages={messages}
                messagesLoaded={messagesLoaded}
                notice={visibleNotice}
                draft={activeDraft.draft}
                composerFocusRequestId={chrome.composerFocusRequestId}
                locale={activeLocale}
                selectedAgentName={activeAgentName}
                draftAttachments={draftAttachmentController.draftAttachments}
                localUploadingAttachments={draftAttachmentController.visibleUploadingAttachments}
                conversationRunning={selectedConversationRunning}
                activeRun={controller.activeRun}
                sendBlockedReason={draftAttachmentController.sendBlockedReason}
                attachmentsEnabled={attachmentsEnabled}
                attachmentAccept={attachmentAccept}
                onDraftChange={activeDraft.setDraft}
                onFilesSelected={draftAttachmentController.onFilesSelected}
                onRemoveDraftAttachment={draftAttachmentController.onRemoveDraftAttachment}
                onRetryDraftAttachment={draftAttachmentController.onRetryDraftAttachment}
                onConversationStarted={onConversationStarted}
                onMessageSubmitted={onMessageSubmitted}
                onRunStarted={onRunStarted}
                onStreamFinished={onStreamFinished}
                onStreamError={onStreamError}
                onCancelRun={onCancelSelectedRun}
              />
              {fileDropzone.draggingFiles ? <ChatDropOverlay /> : null}
            </div>
            <ToolDisplayPanel />
          </div>
        </section>
      )}
      </main>
    </TranslationProvider>
  );
}

function isActiveRunStatus(status: string): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_permission" ||
    status === "cancelling"
  );
}

function isVisibleTerminalControllerError(errorClass: string | undefined): boolean {
  return errorClass === "run_failed" || errorClass === "run_cancelled";
}
