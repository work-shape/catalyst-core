import { lazy, Suspense, useEffect, useState } from "react";
import { cn, Spinner, UiRoot } from "@vivd-catalyst/ui";
import { ApprovalRevisionHostProvider } from "./approvals/approval-revision-host";
import { ApprovalsView } from "./approvals/approvals-view";
import { AssistantRuntimePanel } from "./assistant/assistant-runtime-panel";
import { AttachmentContentProvider } from "./attachment-content";
import { ChatDropOverlay } from "./chat-file-dropzone";
import type { ChatShellProps } from "./chat-shell";
import { CollaborationWorkspacePanel } from "./collaboration-workspace/collaboration-workspace-panel";
import { CollaborationWorkspaceSelector } from "./collaboration-workspace/collaboration-workspace-selector";
import { ControlPlaneRoutes } from "./control-plane/control-plane-routes";
import { TranslationProvider, useTranslation } from "./i18n";
import { LoginPanel } from "./login-panel";
import { ResourcesPanel, ResourcesPanelToggle, useResourcesPanelState } from "./resources-panel";
import { isResourcesPanelAvailable } from "./resources-panel-model";
import { ToolDisplayPanel, useToolDisplayPanel } from "./tool-display-panel";
import { uiLabelsFor } from "./ui-labels";
import { ViewPolicyProvider } from "./view-policy";
import { agentChipDisplayFor } from "./workspace/agent-selector";
import { ClientBrandingHeader } from "./workspace/client-branding";
import { UserMenu } from "./workspace/user-menu";
import {
  ConfigCheckPanel,
  OutdatedInterfaceNotice,
  SessionCheckPanel,
  WorkspaceChrome
} from "./workspace/workspace-chrome";
import { WorkspaceRail } from "./workspace/workspace-rail";
import { type WorkspaceRoute, type WorkspaceRouteChangeOptions } from "./workspace/workspace-route";
import { useWorkspaceChatModel, WORKSPACE_AUTH_SCOPE } from "./workspace/workspace-chat-model";
import { WorkspaceProviders } from "./workspace/workspace-providers";

// The gallery of the shared UI library is its own chunk, loaded only when its route is opened.
const UiGallery = lazy(async () => {
  const { UiGallery: Gallery } = await import("@vivd-catalyst/ui/gallery");
  return { default: Gallery };
});

interface ChatWorkspaceProps extends ChatShellProps {
  route: WorkspaceRoute;
  onRouteChange(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
}

/**
 * An embedded session authenticates with a host-issued token whose scope is
 * capped below `collaboration_workspace:read`, so every Collaboration Workspace
 * surface is first-party only and the widget stays fixed-context.
 *
 * This is the auth-mode half of the decision: it drives the workspace list
 * query and its cache dimension. Whether a first-party session also *shows* the
 * chrome is `collaborationWorkspaceChromeVisibleFor`, which adds the config
 * feature flag on top.
 */
export function collaborationWorkspacesAvailableFor(
  auth: Pick<ChatShellProps, "token" | "getToken">
): boolean {
  return !auth.token && !auth.getToken;
}

export function ChatWorkspace({
  apiBaseUrl,
  token,
  getToken,
  adminPanel,
  manageDocumentTitle,
  onThemeModeChange,
  className,
  route,
  onRouteChange
}: ChatWorkspaceProps) {
  const workspacesAvailable = collaborationWorkspacesAvailableFor({ token, getToken });

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
        onThemeModeChange={onThemeModeChange}
        className={className}
        collaborationWorkspacesAvailable={workspacesAvailable}
      />
    </WorkspaceProviders>
  );
}

function ChatWorkspaceContent({
  adminPanel,
  manageDocumentTitle,
  onThemeModeChange,
  className,
  collaborationWorkspacesAvailable
}: Pick<
  ChatWorkspaceProps,
  "adminPanel" | "manageDocumentTitle" | "onThemeModeChange" | "className"
> & {
  collaborationWorkspacesAvailable: boolean;
}) {
  const model = useWorkspaceChatModel({
    adminPanel,
    manageDocumentTitle,
    collaborationWorkspacesAvailable
  });
  const onStartPage = model.route.view === "chat" && !model.route.selectedConversationId;
  const [displayPanelWidth, setDisplayPanelWidth] = useState(0);
  const [passwordSetupToken, setPasswordSetupToken] = useState(readPasswordSetupToken);

  function clearPasswordSetupToken() {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setPasswordSetupToken(undefined);
  }
  const resourcesEnabled = model.config.config?.features.resources.enabled ?? false;
  const resourcesConversationId = model.route.selectedConversationId;
  const resourcesAvailable = isResourcesPanelAvailable({
    enabled: resourcesEnabled,
    conversationId: resourcesConversationId
  });
  const resourcesPanel = useResourcesPanelState({
    conversationId: resourcesConversationId,
    enabled: resourcesAvailable
  });
  const displayPanel = useToolDisplayPanel();
  const resourcesVisible = resourcesPanel.open && !displayPanel.open;
  const showsLogin = model.auth.loginRequired || Boolean(passwordSetupToken);
  const themeMode = model.config.resolvedThemeMode;
  const uiLabels = uiLabelsFor(model.config.activeLocale);

  // The login panel resolves its own mode from the public branding and reports that instead.
  useEffect(() => {
    if (!showsLogin) {
      onThemeModeChange?.(themeMode);
    }
  }, [onThemeModeChange, showsLogin, themeMode]);

  if (showsLogin) {
    return (
      <TranslationProvider locale={model.config.activeLocale}>
        <LoginPanel
          apiBaseUrl={model.auth.apiBaseUrl}
          localePreference={model.config.localePreference}
          fallbackLocale={model.config.activeLocale}
          onLocaleChange={model.config.selectLocale}
          manageDocumentTitle={manageDocumentTitle}
          passwordSetupToken={passwordSetupToken}
          onPasswordSetupClosed={clearPasswordSetupToken}
          onThemeModeChange={onThemeModeChange}
          onSignedIn={model.auth.invalidateCurrentUser}
        />
      </TranslationProvider>
    );
  }

  if (!model.auth.user) {
    return (
      <TranslationProvider locale={model.config.activeLocale}>
        <UiRoot mode={themeMode} labels={uiLabels}>
          <OutdatedInterfaceNotice />
          <SessionCheckPanel
            className={className}
            unavailable={model.auth.sessionUnavailable}
            retrying={model.auth.sessionRetrying}
            onRetry={model.auth.retryCurrentUser}
          />
        </UiRoot>
      </TranslationProvider>
    );
  }

  if (!model.config.config) {
    return (
      <TranslationProvider locale={model.config.activeLocale}>
        <UiRoot mode={themeMode} labels={uiLabels}>
          <OutdatedInterfaceNotice />
          <ConfigCheckPanel className={className} error={model.config.error} />
        </UiRoot>
      </TranslationProvider>
    );
  }

  if (model.controlPlane.showUiLibrary) {
    return (
      <Suspense
        fallback={
          <UiRoot
            as="main"
            theme={model.config.theme}
            mode={themeMode}
            labels={uiLabels}
            className="grid h-dvh w-full place-items-center bg-background text-muted-foreground"
            role="status"
            aria-label={uiLabels.loading}
          >
            <Spinner size="lg" />
          </UiRoot>
        }
      >
        <UiGallery initialMode={themeMode} initialLanguage={model.config.activeLocale} />
      </Suspense>
    );
  }

  const userMenu = (
    <UserMenu
      user={model.auth.user}
      signingOut={model.auth.signingOut}
      onOpenSettings={model.auth.openSettings}
      onSignOut={model.auth.signOut}
      placement="top"
      align="start"
    />
  );
  const chat = model.selectedChat;
  const isStaging = model.config.config.clientInstance.environment === "staging";
  const collaborationWorkspace = model.collaborationWorkspace;
  const approvals = model.conversationRail.approvals;
  const userLabel = model.auth.user.displayLabel || (model.auth.user.email ?? "");
  const collaborationWorkspaceSelector = model.collaborationWorkspaceChromeVisible ? (
    <CollaborationWorkspaceSelector
      collaborationWorkspaces={collaborationWorkspace.collaborationWorkspaces}
      activeCollaborationWorkspaceId={collaborationWorkspace.activeCollaborationWorkspaceId}
      userLabel={userLabel}
      loading={collaborationWorkspace.loading}
      loadFailed={collaborationWorkspace.loadFailed}
      clientBrandingHeader={<ClientBrandingHeader config={model.config.config} />}
      onSelectCollaborationWorkspace={collaborationWorkspace.selectCollaborationWorkspace}
      onOpenCollaborationWorkspaceSettings={collaborationWorkspace.openSettingsDialog}
      onBrowseCollaborationWorkspaces={collaborationWorkspace.openBrowseDialog}
      onCreateCollaborationWorkspace={collaborationWorkspace.openCreateDialog}
    />
  ) : undefined;

  const workspace = (
    <TranslationProvider locale={model.config.activeLocale}>
      <UiRoot
        as="main"
        theme={model.config.theme}
        mode={themeMode}
        labels={uiLabels}
        className={cn(
          "relative grid h-dvh w-full min-h-0 overflow-hidden bg-background text-foreground transition-colors md:grid-rows-[minmax(0,1fr)] max-md:grid-cols-1",
          model.chrome.sidebarOpen
            ? "md:grid-cols-[20rem_minmax(0,1fr)]"
            : "md:grid-cols-[minmax(0,1fr)]",
          isStaging && "pt-6",
          className
        )}
      >
        <OutdatedInterfaceNotice />
        {model.chrome.sidebarOpen ? <SidebarBackdrop onClose={model.chrome.closeSidebar} /> : null}

        {model.chrome.sidebarOpen ? (
          <div
            className={cn(
              "fixed bottom-0 left-0 z-50 w-[min(20rem,calc(100vw-2rem))] min-w-0 translate-x-0 transition-[top,transform] duration-200 md:static md:z-50 md:w-auto md:translate-x-0",
              isStaging ? "top-6" : "top-0"
            )}
          >
            <WorkspaceRail
              config={model.config.config}
              collaborationWorkspaceSelector={collaborationWorkspaceSelector}
              conversations={model.conversationRail.conversations}
              selectedConversationId={model.conversationRail.selectedConversationId}
              canViewAdministration={model.conversationRail.canViewAdministration}
              approvals={approvals}
              view={model.conversationRail.view}
              creatingConversation={model.conversationRail.creatingConversation}
              deletingConversation={model.conversationRail.deletingConversation}
              canMoveConversation={model.conversationRail.canMoveConversation}
              userMenu={userMenu}
              onToggleSidebar={model.chrome.closeSidebar}
              onViewChange={model.conversationRail.selectWorkspaceView}
              onCreateConversation={model.conversationRail.startNewConversation}
              onSelectConversation={model.conversationRail.selectConversation}
              onRenameConversation={model.conversationRail.renameConversation}
              onMoveConversation={model.conversationRail.moveConversation}
              onDeleteConversation={model.conversationRail.deleteConversation}
            />
          </div>
        ) : null}

        <WorkspaceChrome
          agents={model.config.config.agents}
          agentDisplay={agentChipDisplayFor(model.config.config.ui)}
          displayPanelOpen={model.toolDisplay.open}
          displayPanelWidth={displayPanelWidth}
          environment={model.config.config.clientInstance.environment}
          sidebarOpen={model.chrome.sidebarOpen}
          selectedAgentName={model.config.activeAgentName}
          showAgentSelector={!onStartPage}
          themeMode={themeMode}
          onSelectAgent={model.config.selectAgentName}
          onToggleSidebar={model.chrome.toggleSidebar}
          onToggleTheme={model.config.toggleTheme}
        />

        {model.collaborationWorkspaceChromeVisible ? (
          <CollaborationWorkspacePanel
            apiBaseUrl={model.auth.apiBaseUrl}
            authScope={WORKSPACE_AUTH_SCOPE}
            client={chat.client}
            currentUserId={model.auth.user.id}
            userLabel={userLabel}
            collaborationWorkspaces={collaborationWorkspace.collaborationWorkspaces}
            activeCollaborationWorkspaceId={collaborationWorkspace.activeCollaborationWorkspaceId}
            dialog={collaborationWorkspace.dialog}
            onClose={collaborationWorkspace.closeDialog}
            onCollaborationWorkspaceCreated={collaborationWorkspace.selectCollaborationWorkspace}
            onConversationMoved={collaborationWorkspace.conversationMoved}
            onCollaborationWorkspaceDeleted={collaborationWorkspace.collaborationWorkspaceDeleted}
          />
        ) : null}

        <ApprovalRevisionHostProvider value={model.approvalRevision}>
          <ControlPlaneRoutes
            adminPanel={adminPanel}
            controlPlane={model.controlPlane}
            approvalsView={
              approvals && model.route.view === "approvals" ? (
                <ApprovalsView pendingCount={approvals.pendingCount} />
              ) : undefined
            }
          >
            <section className="relative h-full min-h-0 min-w-0">
              <AttachmentContentProvider
                client={chat.client}
                selectedConversationId={chat.selectedConversationId}
              >
                <div className="flex h-full min-h-0 min-w-0">
                  <div
                    className={cn(
                      "relative h-full min-h-0 min-w-0 flex-1 transition-[width] duration-300 ease-out",
                      // 23.5rem = panel width (22rem) + its right-6 offset, so the
                      // thread centers with equal gaps to sidebar and panel edge
                      resourcesVisible && "lg:[--resources-inset:23.5rem]"
                    )}
                    onDragEnter={chat.fileDropzone.onChatDragEnter}
                    onDragOver={chat.fileDropzone.onChatDragOver}
                    onDragLeave={chat.fileDropzone.onChatDragLeave}
                    onDrop={chat.fileDropzone.onChatDrop}
                  >
                    <AssistantRuntimePanel chat={chat} />
                    {chat.fileDropzone.draggingFiles ? <ChatDropOverlay /> : null}
                    {resourcesAvailable &&
                    resourcesConversationId &&
                    resourcesPanel.hasResources ? (
                      resourcesVisible ? (
                        <ResourcesPanel
                          client={resourcesPanel.client}
                          conversationId={resourcesConversationId}
                          error={resourcesPanel.error}
                          loading={resourcesPanel.loading}
                          onClose={resourcesPanel.close}
                          open
                          resources={resourcesPanel.resources}
                        />
                      ) : (
                        <ResourcesPanelToggle
                          onOpen={() => {
                            displayPanel.close();
                            resourcesPanel.openExplicitly();
                          }}
                        />
                      )
                    ) : null}
                  </div>
                  <ToolDisplayPanel onWidthChange={setDisplayPanelWidth} />
                </div>
              </AttachmentContentProvider>
            </section>
          </ControlPlaneRoutes>
        </ApprovalRevisionHostProvider>
      </UiRoot>
    </TranslationProvider>
  );
  // Every generated view below is shown under the instance's view policy of today.
  return (
    <ViewPolicyProvider allowedScriptSrc={model.config.config.views.allowedScriptSrc}>
      {workspace}
    </ViewPolicyProvider>
  );
}

const PASSWORD_SETUP_HASH_PREFIX = "#password-setup=";

/** Emailed links carry their token in the URL fragment so it never reaches the server. */
function readPasswordSetupToken(): string | undefined {
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  return hash.startsWith(PASSWORD_SETUP_HASH_PREFIX)
    ? hash.slice(PASSWORD_SETUP_HASH_PREFIX.length) || undefined
    : undefined;
}

/** Covers the chat beside the open sidebar on small screens; a click on it closes the sidebar. */
function SidebarBackdrop({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="fixed inset-0 z-30 bg-black/35 backdrop-blur-[1px] md:hidden"
      aria-label={t("closeSidebar")}
      onClick={onClose}
    />
  );
}
