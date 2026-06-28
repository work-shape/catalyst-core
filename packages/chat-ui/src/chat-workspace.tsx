import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  createApiClient,
  type LocaleCode,
  type StartConversationRunResponse
} from "@vivd-catalyst/api-client";
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
import {
  clearRunCursors,
  useConversationController
} from "./conversation-controller";
import { useDraftAttachmentController } from "./draft-attachment-controller";
import { readBrowserLocale, TranslationProvider } from "./i18n";
import { LoginPanel } from "./login-panel";
import {
  createThemeStyle,
  readSystemThemeMode,
  resolveThemeModePreference,
  type ResolvedThemeMode
} from "./theme";
import { ToolDisplayPanel, useToolDisplayPanel } from "./tool-display-panel";
import { cn } from "./ui/cn";
import { UserMenu } from "./user-menu";
import { UserSettingsPanel } from "./user-settings-panel";
import { SessionCheckPanel, WorkspaceChrome } from "./workspace-chrome";
import { type WorkspaceView, WorkspaceRail } from "./workspace-rail";
import {
  defaultWorkspaceRoute,
  workspaceRouteView,
  type WorkspaceRoute,
  type WorkspaceRouteChangeOptions
} from "./workspace-route";
import {
  apiErrorMessage,
  apiErrorStatus,
  applyFavicon,
  createDraftKey,
  DEFAULT_LOCALES,
  readStoredLocale,
  readStoredThemeMode,
  STANDALONE_AUTH_SOURCE,
  writeStoredLocale,
  writeStoredThemeMode
} from "./workspace-utils";

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
  const selectedConversationIdRef = useRef<string | undefined>(undefined);
  const lastChatRouteRef = useRef<WorkspaceRoute>(defaultWorkspaceRoute());
  const [draftsByTarget, setDraftsByTarget] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | undefined>();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const [selectedAgentName, setSelectedAgentName] = useState<string | undefined>();
  const [browserLocale] = useState<LocaleCode | undefined>(() => readBrowserLocale());
  const [localePreference, setLocalePreference] = useState<LocaleCode | undefined>(() => readStoredLocale());
  const [themeOverride, setThemeOverride] = useState<ResolvedThemeMode | undefined>(() =>
    readStoredThemeMode()
  );
  const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(() => readSystemThemeMode());
  const displayPanel = useToolDisplayPanel();
  const authScope = "standalone";
  const selectedConversationId = route.kind === "conversation" ? route.conversationId : undefined;
  const view = workspaceRouteView(route);
  const draftKey = createDraftKey(authScope, selectedConversationId);
  const draft = draftsByTarget[draftKey] ?? "";

  const client = useMemo(
    () =>
      createApiClient({
        baseUrl: apiBaseUrl,
        getToken: getToken ?? (() => token)
      }),
    [apiBaseUrl, getToken, token]
  );

  const meQuery = useWorkspaceMeQuery({ apiBaseUrl, client });
  const isAuthenticated = Boolean(meQuery.data);
  const configQuery = useWorkspaceConfigQuery({
    apiBaseUrl,
    authScope,
    client,
    localePreference,
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
  const activeLocale = config?.localization.locale ?? localePreference ?? browserLocale ?? "en";
  async function ensureConversationForFiles(files: File[]): Promise<string> {
    if (selectedConversationId) {
      return selectedConversationId;
    }
    const title = files.length === 1 ? files[0]?.name ?? "Attached file" : `${files.length} attached files`;
    const conversation = await client.createConversation({
      title,
      locale: activeLocale
    });
    setDraftsByTarget((currentDrafts) => {
      const nextDrafts = { ...currentDrafts };
      const currentDraft = nextDrafts[draftKey];
      delete nextDrafts[draftKey];
      if (currentDraft) {
        nextDrafts[createDraftKey(authScope, conversation.id)] = currentDraft;
      }
      return nextDrafts;
    });
    onRouteChange(
      { kind: "conversation", conversationId: conversation.id },
      { replace: route.kind === "new-conversation" }
    );
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
  const supportedLocales = config?.localization.supportedLocales ?? DEFAULT_LOCALES;
  const resolvedThemeMode =
    themeOverride ?? resolveThemeModePreference(config?.ui.defaultThemeMode, systemThemeMode);
  const themeStyle = createThemeStyle(config?.ui, resolvedThemeMode);
  const workspaceStyle = {
    ...(themeStyle ?? {})
  } as CSSProperties;
  const activeAgentName = selectedAgentName ?? config?.defaultAgentName ?? config?.agents[0]?.name;
  const displayPanelOpen = Boolean(displayPanel.entry && displayPanel.open);

  useEffect(() => {
    displayPanel.close();
  }, [displayPanel.close, selectedConversationId]);

  useEffect(() => {
    selectedConversationIdRef.current = selectedConversationId;
    if (route.kind === "new-conversation" || route.kind === "conversation") {
      lastChatRouteRef.current = route;
    }
  }, [route, selectedConversationId]);

  useEffect(() => {
    if (isAuthenticated && route.kind === "superadmin" && !isSuperadmin) {
      onRouteChange(defaultWorkspaceRoute(), { replace: true });
    }
  }, [isAuthenticated, isSuperadmin, onRouteChange, route.kind]);

  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) {
      return undefined;
    }

    function onChange(event: MediaQueryListEvent) {
      setSystemThemeMode(event.matches ? "dark" : "light");
    }

    media.addEventListener("change", onChange);
    return () => {
      media.removeEventListener("change", onChange);
    };
  }, []);

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
      onRouteChange(
        nextSelectedConversationId
          ? { kind: "conversation", conversationId: nextSelectedConversationId }
          : defaultWorkspaceRoute(),
        { replace: true }
      );
    },
    onDeletedConversation: () => setNotice(undefined),
    onErrorMessage: setNotice
  });
  const signOutMutation = useWorkspaceSignOutMutation({
    apiBaseUrl,
    onSignedOut: () => {
      setDraftsByTarget({});
      clearRunCursors();
      lastChatRouteRef.current = defaultWorkspaceRoute();
      onRouteChange(defaultWorkspaceRoute(), { replace: true });
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
      onOpenSettings={() => onRouteChange({ kind: "settings" })}
      onSignOut={() => signOutMutation.mutate()}
      placement="top"
      align="start"
    />
  );

  function onToggleTheme() {
    const nextThemeMode = resolvedThemeMode === "dark" ? "light" : "dark";
    setThemeOverride(nextThemeMode);
    writeStoredThemeMode(nextThemeMode);
  }

  function onSelectLocale(locale: LocaleCode) {
    setLocalePreference(locale);
    writeStoredLocale(locale);
  }

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
    onRouteChange(defaultWorkspaceRoute());
    setNotice(undefined);
    setComposerFocusRequestId((currentRequestId) => currentRequestId + 1);
  }

  function setDraftForKey(key: string, value: string) {
    setDraftsByTarget((currentDrafts) => {
      if (value.length === 0) {
        const remainingDrafts = { ...currentDrafts };
        delete remainingDrafts[key];
        return remainingDrafts;
      }
      return {
        ...currentDrafts,
        [key]: value
      };
    });
  }

  function onConversationStarted(conversationId: string) {
    onRouteChange(
      { kind: "conversation", conversationId },
      { replace: route.kind === "new-conversation" }
    );
    setNotice(undefined);
    workspaceCache.invalidateConversationStarted(conversationId);
  }

  function onMessageSubmitted(conversationId: string) {
    setDraftForKey(draftKey, "");
    setDraftForKey(createDraftKey(authScope, conversationId), "");
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
    const visible = viewed || selectedConversationIdRef.current === conversationId;
    if (visible) {
      setNotice(message);
    }
    workspaceCache.invalidateStreamError(conversationId);
  }

  function onSelectConversation(conversationId: string) {
    onRouteChange({ kind: "conversation", conversationId });
    setNotice(undefined);
  }

  function onWorkspaceViewChange(nextView: WorkspaceView) {
    if (nextView === "settings") {
      onRouteChange({ kind: "settings" });
      return;
    }
    if (nextView === "superadmin") {
      onRouteChange({ kind: "superadmin", tab: "usage" });
      return;
    }
    onRouteChange(lastChatRouteRef.current);
  }

  if (apiErrorStatus(meQuery.error) === 401) {
    return (
      <TranslationProvider locale={activeLocale}>
        <LoginPanel
          apiBaseUrl={apiBaseUrl}
          localePreference={localePreference}
          fallbackLocale={activeLocale}
          onLocaleChange={onSelectLocale}
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
          sidebarOpen ? "md:grid-cols-[18rem_minmax(0,1fr)]" : "md:grid-cols-[minmax(0,1fr)]",
          resolvedThemeMode === "dark" && "dark",
          className
        )}
        style={workspaceStyle}
      >
      {sidebarOpen ? (
        <button
          type="button"
          className="fixed inset-0 z-30 bg-black/35 backdrop-blur-[1px] md:hidden"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      ) : null}

      {sidebarOpen ? (
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
            onToggleSidebar={() => setSidebarOpen(false)}
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
        sidebarOpen={sidebarOpen}
        selectedAgentName={activeAgentName}
        themeMode={resolvedThemeMode}
        onSelectAgent={setSelectedAgentName}
        onToggleSidebar={() => setSidebarOpen((currentOpen) => !currentOpen)}
        onToggleTheme={onToggleTheme}
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
          onSelectTab: (tab) => onRouteChange({ kind: "superadmin", tab })
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
          onSelectLocale={onSelectLocale}
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
                draft={draft}
                composerFocusRequestId={composerFocusRequestId}
                locale={activeLocale}
                selectedAgentName={activeAgentName}
                draftAttachments={draftAttachmentController.draftAttachments}
                localUploadingAttachments={draftAttachmentController.visibleUploadingAttachments}
                conversationRunning={selectedConversationRunning}
                activeRun={controller.activeRun}
                sendBlockedReason={draftAttachmentController.sendBlockedReason}
                attachmentsEnabled={attachmentsEnabled}
                attachmentAccept={attachmentAccept}
                onDraftChange={(value) => setDraftForKey(draftKey, value)}
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
