import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelLeft } from "lucide-react";
import {
  ApiError,
  createApiClient,
  type AdministeredUserIdentity,
  type ChangeCurrentUserPasswordRequest,
  type Conversation,
  type CreateAdministeredUserRequest,
  type LocaleCode,
  type Message,
  type SafeConfig,
  type UpdateCurrentUserRequest,
  type UpdateAdministeredUserRequest,
  type UpsertAdministeredUserIdentityRequest
} from "@vivd-catalyst/api-client";
import { AgentSelector } from "./agent-selector";
import { AssistantChatPanel } from "./assistant-chat-panel";
import { signOut } from "./auth-client";
import type { ChatShellProps } from "./chat-shell";
import { ChatDropOverlay, useChatFileDropzone } from "./chat-file-dropzone";
import {
  draftAttachmentsQueryKey,
  useDraftAttachmentController
} from "./draft-attachment-controller";
import { readBrowserLocale, TranslationProvider, useTranslation } from "./i18n";
import { LoginPanel } from "./login-panel";
import {
  createThemeStyle,
  readSystemThemeMode,
  resolveThemeModePreference,
  type ResolvedThemeMode
} from "./theme";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "./ui/cn";
import { UserMenu } from "./user-menu";
import { UserSettingsPanel } from "./user-settings-panel";
import { type WorkspaceView, WorkspaceRail } from "./workspace-rail";

const STANDALONE_AUTH_SOURCE = "better-auth";
const THEME_STORAGE_KEY = "vivd-catalyst:theme";
const LOCALE_STORAGE_KEY = "vivd-catalyst:locale";
const DEFAULT_LOCALES: LocaleCode[] = ["en", "de"];

export function ChatWorkspace({
  apiBaseUrl,
  token,
  getToken,
  adminPanel,
  manageDocumentTitle,
  className
}: ChatShellProps) {
  const queryClient = useQueryClient();
  const [selectedConversationId, setSelectedConversationId] = useState<string | undefined>();
  const [draftsByTarget, setDraftsByTarget] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | undefined>();
  const [view, setView] = useState<WorkspaceView>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [composerFocusRequestId, setComposerFocusRequestId] = useState(0);
  const [selectedAgentName, setSelectedAgentName] = useState<string | undefined>();
  const [browserLocale] = useState<LocaleCode | undefined>(() => readBrowserLocale());
  const [localePreference, setLocalePreference] = useState<LocaleCode | undefined>(() => readStoredLocale());
  const [themeOverride, setThemeOverride] = useState<ResolvedThemeMode | undefined>(() =>
    readStoredThemeMode()
  );
  const [systemThemeMode, setSystemThemeMode] = useState<ResolvedThemeMode>(() => readSystemThemeMode());
  const authScope = "standalone";
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

  const meQuery = useQuery({
    queryKey: ["me", apiBaseUrl],
    queryFn: client.me,
    retry: false
  });
  const isAuthenticated = Boolean(meQuery.data);
  const configQuery = useQuery({
    queryKey: ["config", apiBaseUrl, authScope, localePreference ?? "auto"],
    queryFn: () => client.config(localePreference),
    enabled: isAuthenticated
  });
  const conversationsQuery = useQuery({
    queryKey: ["conversations", apiBaseUrl, authScope],
    queryFn: client.conversations,
    enabled: isAuthenticated
  });
  const messagesQuery = useQuery({
    queryKey: ["messages", apiBaseUrl, authScope, selectedConversationId],
    queryFn: () => client.messages(selectedConversationId ?? ""),
    enabled: isAuthenticated && Boolean(selectedConversationId)
  });
  const isSuperadmin = adminPanel?.canView(meQuery.data) ?? false;
  const usageQuery = useQuery({
    queryKey: ["usage", apiBaseUrl, authScope],
    queryFn: client.usageSummary,
    enabled: isSuperadmin && view === "superadmin"
  });
  const auditQuery = useQuery({
    queryKey: ["audit-events", apiBaseUrl, authScope],
    queryFn: client.auditEvents,
    enabled: isSuperadmin && view === "superadmin"
  });
  const usersQuery = useQuery({
    queryKey: ["superadmin-users", apiBaseUrl, authScope],
    queryFn: client.users,
    enabled: isSuperadmin && view === "superadmin"
  });

  const deleteConversation = useMutation({
    mutationFn: (conversationId: string) => client.deleteConversation(conversationId),
    onSuccess: (deletedConversation) => {
      let nextSelectedConversationId: string | undefined;
      queryClient.setQueryData<Conversation[]>(
        ["conversations", apiBaseUrl, authScope],
        (currentConversations = []) => {
          const remainingConversations = currentConversations.filter(
            (conversation) => conversation.id !== deletedConversation.id
          );
          nextSelectedConversationId =
            !selectedConversationId || selectedConversationId === deletedConversation.id
              ? remainingConversations[0]?.id
              : selectedConversationId;
          return remainingConversations;
        }
      );
      queryClient.removeQueries({ queryKey: ["messages", apiBaseUrl, authScope, deletedConversation.id] });
      queryClient.removeQueries({
        queryKey: draftAttachmentsQueryKey(apiBaseUrl, authScope, deletedConversation.id)
      });
      draftAttachmentController.clearConversationUploads(deletedConversation.id);
      setSelectedConversationId(nextSelectedConversationId);
      setNotice(undefined);
      void queryClient.invalidateQueries({ queryKey: ["conversations", apiBaseUrl, authScope] });
    },
    onError: (error) => {
      setNotice(error instanceof ApiError ? error.message : "Delete failed");
    }
  });

  const conversations = conversationsQuery.data ?? [];
  const messages = selectedConversationId ? messagesQuery.data : [];
  const messagesLoaded = !selectedConversationId || messagesQuery.data !== undefined;
  const config = configQuery.data;
  const attachmentsEnabled = config?.features.attachments.enabled ?? false;
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
    setSelectedConversationId(conversation.id);
    setView("chat");
    setNotice(undefined);
    void queryClient.invalidateQueries({ queryKey: ["conversations", apiBaseUrl, authScope] });
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

  const signOutMutation = useMutation({
    mutationFn: () => signOut(apiBaseUrl),
    onSuccess: () => {
      setSelectedConversationId(undefined);
      setDraftsByTarget({});
      setView("chat");
      void queryClient.clear();
      void queryClient.invalidateQueries({ queryKey: ["me", apiBaseUrl] });
    }
  });
  const updateCurrentUser = useMutation({
    mutationFn: (input: UpdateCurrentUserRequest) => client.updateMe(input),
    onSuccess: (updatedUser) => {
      queryClient.setQueryData(["me", apiBaseUrl], updatedUser);
      void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
    }
  });
  const changeCurrentUserPassword = useMutation({
    mutationFn: (input: ChangeCurrentUserPasswordRequest) => client.changeMyPassword(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
    }
  });
  const createUser = useMutation({
    mutationFn: (input: CreateAdministeredUserRequest) => client.createUser(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["superadmin-users", apiBaseUrl, authScope] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
    }
  });
  const updateUser = useMutation({
    mutationFn: (input: { userId: string; update: UpdateAdministeredUserRequest }) =>
      client.updateUser(input.userId, input.update),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["superadmin-users", apiBaseUrl, authScope] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
    }
  });
  const upsertUserIdentity = useMutation({
    mutationFn: (input: { userId: string; identity: UpsertAdministeredUserIdentityRequest }) =>
      client.upsertUserIdentity(input.userId, input.identity),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["superadmin-users", apiBaseUrl, authScope] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
    }
  });
  const deleteUserIdentity = useMutation({
    mutationFn: (input: { userId: string; identity: AdministeredUserIdentity }) =>
      client.deleteUserIdentity(input.userId, input.identity.authSource, input.identity.externalUserId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["superadmin-users", apiBaseUrl, authScope] });
      void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
    }
  });
  const resetUserPassword = useMutation({
    mutationFn: (input: { userId: string; password: string }) =>
      client.resetUserPassword(input.userId, { password: input.password }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
    }
  });
  const userMenu = (
    <UserMenu
      user={meQuery.data}
      signingOut={signOutMutation.isPending}
      onOpenSettings={() => setView("settings")}
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

  function onCreateConversation() {
    setSelectedConversationId(undefined);
    setView("chat");
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

  function onConversationStarted(conversationId: string, startedMessages?: Message[]) {
    if (startedMessages) {
      queryClient.setQueryData(["messages", apiBaseUrl, authScope, conversationId], startedMessages);
    }
    setSelectedConversationId(conversationId);
    setView("chat");
    setNotice(undefined);
    void queryClient.invalidateQueries({ queryKey: ["conversations", apiBaseUrl, authScope] });
  }

  function onMessageSubmitted(conversationId: string) {
    setDraftForKey(createDraftKey(authScope, conversationId), "");
    queryClient.setQueryData(draftAttachmentsQueryKey(apiBaseUrl, authScope, conversationId), []);
    draftAttachmentController.clearConversationUploads(conversationId);
  }

  function onChatRequestAccepted(conversationId: string) {
    void client
      .generateConversationTitle(conversationId)
      .then((updatedConversation) => {
        queryClient.setQueryData<Conversation[]>(
          ["conversations", apiBaseUrl, authScope],
          (currentConversations = []) => {
            if (currentConversations.some((conversation) => conversation.id === updatedConversation.id)) {
              return currentConversations.map((conversation) =>
                conversation.id === updatedConversation.id ? updatedConversation : conversation
              );
            }
            return [updatedConversation, ...currentConversations];
          }
        );
      })
      .catch(() => {
        void queryClient.invalidateQueries({ queryKey: ["conversations", apiBaseUrl, authScope] });
      });
  }

  function onStreamFinished() {
    setNotice(undefined);
    void queryClient.invalidateQueries({ queryKey: ["conversations", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["messages", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["draft-attachments", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["usage", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
  }

  function onStreamError(message: string) {
    setNotice(message);
    void queryClient.invalidateQueries({ queryKey: ["conversations", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["messages", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["draft-attachments", apiBaseUrl, authScope] });
  }

  function onSelectConversation(conversationId: string) {
    setSelectedConversationId(conversationId);
    setView("chat");
    setNotice(undefined);
  }

  if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
    return (
      <TranslationProvider locale={activeLocale}>
        <LoginPanel
          apiBaseUrl={apiBaseUrl}
          localePreference={localePreference}
          fallbackLocale={activeLocale}
          onLocaleChange={onSelectLocale}
          manageDocumentTitle={manageDocumentTitle}
          onSignedIn={() => {
            void queryClient.invalidateQueries({ queryKey: ["me", apiBaseUrl] });
          }}
        />
      </TranslationProvider>
    );
  }

  if (!meQuery.data) {
    return (
      <TranslationProvider locale={activeLocale}>
        <SessionCheckPanel
          className={className}
          error={meQuery.error instanceof ApiError ? meQuery.error.message : undefined}
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
            onViewChange={setView}
            onCreateConversation={onCreateConversation}
            onSelectConversation={onSelectConversation}
            onDeleteConversation={(conversationId) => deleteConversation.mutate(conversationId)}
          />
        </div>
      ) : null}

      <WorkspaceChrome
        agents={config?.agents ?? []}
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
            usageQuery.error instanceof ApiError
              ? usageQuery.error.message
              : auditQuery.error instanceof ApiError
                ? auditQuery.error.message
                : undefined,
          usersError: usersQuery.error instanceof ApiError ? usersQuery.error.message : undefined,
          usersMutating:
            createUser.isPending ||
            updateUser.isPending ||
            upsertUserIdentity.isPending ||
            deleteUserIdentity.isPending ||
            resetUserPassword.isPending,
          onCreateUser: (input) => createUser.mutateAsync(input),
          onUpdateUser: (userId, update) => updateUser.mutateAsync({ userId, update }),
          onUpsertUserIdentity: (userId, identity) =>
            upsertUserIdentity.mutateAsync({ userId, identity }),
          onDeleteUserIdentity: (userId, identity) =>
            deleteUserIdentity.mutateAsync({ userId, identity }),
          onResetUserPassword: (userId, password) =>
            resetUserPassword.mutateAsync({ userId, password })
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
        <section
          className="relative h-full min-h-0 min-w-0"
          onDragEnter={fileDropzone.onChatDragEnter}
          onDragOver={fileDropzone.onChatDragOver}
          onDragLeave={fileDropzone.onChatDragLeave}
          onDrop={fileDropzone.onChatDrop}
        >
          <AssistantChatPanel
            apiBaseUrl={apiBaseUrl}
            client={client}
            config={config}
            selectedConversationId={selectedConversationId}
            messages={messages}
            messagesLoaded={messagesLoaded}
            notice={notice}
            draft={draft}
            composerFocusRequestId={composerFocusRequestId}
            locale={activeLocale}
            selectedAgentName={activeAgentName}
            draftAttachments={draftAttachmentController.draftAttachments}
            localUploadingAttachments={draftAttachmentController.visibleUploadingAttachments}
            sendBlockedReason={draftAttachmentController.sendBlockedReason}
            attachmentsEnabled={attachmentsEnabled}
            onDraftChange={(value) => setDraftForKey(draftKey, value)}
            onFilesSelected={draftAttachmentController.onFilesSelected}
            onRemoveDraftAttachment={draftAttachmentController.onRemoveDraftAttachment}
            onRetryDraftAttachment={draftAttachmentController.onRetryDraftAttachment}
            onConversationStarted={onConversationStarted}
            onMessageSubmitted={onMessageSubmitted}
            onChatRequestAccepted={onChatRequestAccepted}
            onStreamFinished={onStreamFinished}
            onStreamError={onStreamError}
          />
          {fileDropzone.draggingFiles ? <ChatDropOverlay /> : null}
        </section>
      )}
      </main>
    </TranslationProvider>
  );
}

function SessionCheckPanel({
  className,
  error
}: {
  className: string | undefined;
  error: string | undefined;
}) {
  const { t } = useTranslation();

  return (
    <main
      className={cn(
        "grid h-dvh w-full place-items-center overflow-hidden bg-sidebar p-5 text-foreground",
        className
      )}
    >
      <div className="grid w-full max-w-[380px] gap-2 rounded-lg border bg-card p-5 text-card-foreground shadow-xs">
        <strong className="text-sm font-semibold">
          {error ? t("couldNotVerifySession") : t("checkingSession")}
        </strong>
        <p className="text-sm text-muted-foreground">{error ?? t("sessionCheckingDescription")}</p>
      </div>
    </main>
  );
}

function WorkspaceChrome({
  agents,
  sidebarOpen,
  selectedAgentName,
  themeMode,
  onSelectAgent,
  onToggleSidebar,
  onToggleTheme
}: {
  agents: SafeConfig["agents"];
  sidebarOpen: boolean;
  selectedAgentName: string | undefined;
  themeMode: ResolvedThemeMode;
  onSelectAgent: (agentName: string) => void;
  onToggleSidebar: () => void;
  onToggleTheme: () => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute left-4 top-3 z-50 flex min-w-0 items-center gap-2 transition-[left] duration-200",
          sidebarOpen && "max-md:hidden md:left-[19rem]"
        )}
      >
        {!sidebarOpen ? (
          <button
            type="button"
            className={cn(
              "pointer-events-auto inline-flex size-10 shrink-0 items-center justify-center rounded-md bg-background/95 text-muted-foreground shadow-sm backdrop-blur transition-colors outline-none",
              "hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40"
            )}
            aria-label={t("openSidebar")}
            title={t("openSidebar")}
            aria-pressed="false"
            onClick={onToggleSidebar}
          >
            <PanelLeft size={17} aria-hidden="true" />
          </button>
        ) : null}
        {agents.length > 0 ? (
          <div className="pointer-events-auto min-w-0">
            <AgentSelector
              agents={agents}
              selectedAgentName={selectedAgentName}
              onSelectAgent={onSelectAgent}
            />
          </div>
        ) : null}
      </div>

      <div className="pointer-events-none absolute right-4 top-3 z-50 flex items-center gap-2">
        <div className="pointer-events-auto">
          <ThemeToggle mode={themeMode} onToggle={onToggleTheme} />
        </div>
      </div>
    </>
  );
}

function createDraftKey(authScope: string, conversationId: string | undefined): string {
  return `${authScope}:${conversationId ?? "new"}`;
}

function readStoredThemeMode(): ResolvedThemeMode | undefined {
  const storedThemeMode = window.localStorage.getItem(THEME_STORAGE_KEY);
  return storedThemeMode === "dark" || storedThemeMode === "light" ? storedThemeMode : undefined;
}

function writeStoredThemeMode(themeMode: ResolvedThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
}

function readStoredLocale(): LocaleCode | undefined {
  const storedLocale = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return storedLocale === "en" || storedLocale === "de" ? storedLocale : undefined;
}

function writeStoredLocale(locale: LocaleCode): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

function applyFavicon(href: string): void {
  const selector = "link[rel~='icon'][data-vivd-favicon='true']";
  const existing =
    document.head.querySelector<HTMLLinkElement>(selector) ??
    document.head.querySelector<HTMLLinkElement>("link[rel~='icon']");
  const link = existing ?? document.createElement("link");
  link.rel = "icon";
  link.type = href.endsWith(".svg") ? "image/svg+xml" : "image/png";
  link.href = href;
  link.dataset.vivdFavicon = "true";
  if (!existing) {
    document.head.appendChild(link);
  }
}
