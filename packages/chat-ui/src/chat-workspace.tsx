import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  createApiClient,
  type AdministeredUserIdentity,
  type ChangeCurrentUserPasswordRequest,
  type Conversation,
  type CreateAdministeredUserRequest,
  type Message,
  type UpdateCurrentUserRequest,
  type UpdateAdministeredUserRequest,
  type UpsertAdministeredUserIdentityRequest
} from "@agent-chat-platform/api-client";
import { AssistantChatPanel } from "./assistant-chat-panel";
import { signOut } from "./auth-client";
import type { ChatShellProps } from "./chat-shell";
import { LoginPanel } from "./login-panel";
import { createThemeStyle } from "./theme";
import { cn } from "./ui/cn";
import { UserMenu } from "./user-menu";
import { UserSettingsPanel } from "./user-settings-panel";
import { type WorkspaceView, WorkspaceRail } from "./workspace-rail";

const STANDALONE_AUTH_SOURCE = "better-auth";

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
    queryKey: ["config", apiBaseUrl, authScope],
    queryFn: client.config,
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
  const themeStyle = createThemeStyle(config?.ui);

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
    />
  );

  function onCreateConversation() {
    setSelectedConversationId(undefined);
    setView("chat");
    setNotice(undefined);
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

  function onStreamFinished() {
    setNotice(undefined);
    void queryClient.invalidateQueries({ queryKey: ["conversations", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["messages", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["usage", apiBaseUrl, authScope] });
    void queryClient.invalidateQueries({ queryKey: ["audit-events", apiBaseUrl, authScope] });
  }

  function onSelectConversation(conversationId: string) {
    setSelectedConversationId(conversationId);
    setView("chat");
    setNotice(undefined);
  }

  if (meQuery.error instanceof ApiError && meQuery.error.status === 401) {
    return (
      <LoginPanel
        apiBaseUrl={apiBaseUrl}
        manageDocumentTitle={manageDocumentTitle}
        onSignedIn={() => {
          void queryClient.invalidateQueries({ queryKey: ["me", apiBaseUrl] });
        }}
      />
    );
  }

  if (!meQuery.data) {
    return (
      <main
        className={cn(
          "grid h-dvh w-full place-items-center overflow-hidden bg-sidebar p-5 text-foreground",
          className
        )}
      >
        <div className="grid w-full max-w-[380px] gap-2 rounded-lg border bg-card p-5 text-card-foreground shadow-xs">
          <strong className="text-sm font-semibold">
            {meQuery.error ? "Could not verify your session" : "Checking session"}
          </strong>
          <p className="text-sm text-muted-foreground">
            {meQuery.error instanceof ApiError
              ? meQuery.error.message
              : "Your account is being checked before the chat loads."}
          </p>
        </div>
      </main>
    );
  }

  return (
    <main
      className={cn(
        "grid h-dvh w-full min-h-0 overflow-hidden bg-background text-foreground md:grid-cols-[minmax(230px,286px)_minmax(0,1fr)] md:grid-rows-[minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]",
        className
      )}
      style={themeStyle}
    >
      <WorkspaceRail
        config={config}
        user={meQuery.data}
        conversations={conversations}
        selectedConversationId={selectedConversationId}
        isSuperadmin={isSuperadmin}
        view={view}
        creatingConversation={false}
        deletingConversation={deleteConversation.isPending}
        onViewChange={setView}
        onCreateConversation={onCreateConversation}
        onSelectConversation={onSelectConversation}
        onDeleteConversation={(conversationId) => deleteConversation.mutate(conversationId)}
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
            resetUserPassword.mutateAsync({ userId, password }),
          headerActions: userMenu
        })
      ) : view === "settings" ? (
        <UserSettingsPanel
          user={meQuery.data}
          canChangePassword={meQuery.data?.authSource === STANDALONE_AUTH_SOURCE}
          updatingProfile={updateCurrentUser.isPending}
          changingPassword={changeCurrentUserPassword.isPending}
          onUpdateProfile={(input) => updateCurrentUser.mutateAsync(input)}
          onChangePassword={(input) => changeCurrentUserPassword.mutateAsync(input)}
          headerActions={userMenu}
        />
      ) : (
        <AssistantChatPanel
          apiBaseUrl={apiBaseUrl}
          client={client}
          config={config}
          conversations={conversations}
          selectedConversationId={selectedConversationId}
          messages={messages}
          messagesLoaded={messagesLoaded}
          notice={notice}
          draft={draft}
          headerActions={userMenu}
          onDraftChange={(value) => setDraftForKey(draftKey, value)}
          onConversationStarted={onConversationStarted}
          onStreamFinished={onStreamFinished}
          onStreamError={setNotice}
        />
      )}
    </main>
  );
}

function createDraftKey(authScope: string, conversationId: string | undefined): string {
  return `${authScope}:${conversationId ?? "new"}`;
}
