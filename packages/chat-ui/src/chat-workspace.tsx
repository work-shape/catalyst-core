import { lazy, Suspense, useEffect, useState } from "react";
import { cn, SkipLink, Spinner, UiRoot } from "@vivd-catalyst/ui";
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
import { SurfaceSlot } from "./surface/surface-slot";
import { useToolDisplayPanel } from "./tool-display-panel";
import { uiLabelsFor } from "./ui-labels";
import { ViewPolicyProvider } from "./view-policy";
import { agentChipDisplayFor } from "./workspace/agent-selector";
import { ClientBrandingHeader } from "./workspace/client-branding";
import { ConversationPalette } from "./workspace/conversation-palette";
import { UserMenu } from "./workspace/user-menu";
import {
  ConfigCheckPanel,
  OutdatedInterfaceNotice,
  SessionCheckPanel,
  StagingBanner,
  WorkspaceChrome
} from "./workspace/workspace-chrome";
import { WorkspaceRail } from "./workspace/workspace-rail";
import { type WorkspaceRoute, type WorkspaceRouteChangeOptions } from "./workspace/workspace-route";
import { useWorkspaceChatModel, WORKSPACE_AUTH_SCOPE } from "./workspace/workspace-chat-model";
import { WorkspaceProviders } from "./workspace/workspace-providers";
import { useWorkspaceShortcuts } from "./workspace/workspace-shortcuts";

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
 * surface is first-party only and the widget stays fixed-context: no selector,
 * no workspace panel, no workspace list query.
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
  administration,
  labelOverrides,
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
        labelOverrides={labelOverrides}
        administration={administration}
        manageDocumentTitle={manageDocumentTitle}
        onThemeModeChange={onThemeModeChange}
        className={className}
        collaborationWorkspacesAvailable={workspacesAvailable}
      />
    </WorkspaceProviders>
  );
}

function ChatWorkspaceContent({
  administration,
  labelOverrides,
  manageDocumentTitle,
  onThemeModeChange,
  className,
  collaborationWorkspacesAvailable
}: Pick<
  ChatWorkspaceProps,
  "administration" | "labelOverrides" | "manageDocumentTitle" | "onThemeModeChange" | "className"
> & {
  collaborationWorkspacesAvailable: boolean;
}) {
  const model = useWorkspaceChatModel({
    administration,
    manageDocumentTitle,
    collaborationWorkspacesAvailable
  });
  const onStartPage = model.route.view === "chat" && !model.route.selectedConversationId;
  // What the surface takes of the main area beside the conversation; 0 when it does not.
  const [surfaceBesideWidth, setSurfaceBesideWidth] = useState(0);
  const [surfaceCovering, setSurfaceCovering] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
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
  // The slot reports its placement a render late; a surface that has closed covers nothing at once.
  const chatCovered = surfaceCovering && displayPanel.open;
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
      <TranslationProvider locale={model.config.activeLocale} labelOverrides={labelOverrides}>
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
      <TranslationProvider locale={model.config.activeLocale} labelOverrides={labelOverrides}>
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
      <TranslationProvider locale={model.config.activeLocale} labelOverrides={labelOverrides}>
        <UiRoot mode={themeMode} labels={uiLabels}>
          {/* A failed load says it in the panel; the notice above it would say it twice. */}
          {model.config.failure ? null : <OutdatedInterfaceNotice />}
          <ConfigCheckPanel
            className={className}
            failure={model.config.failure}
            retrying={model.config.retrying}
            onRetry={model.config.retry}
            onReload={() => window.location.reload()}
          />
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

  const accountMenu = (
    <UserMenu
      user={model.auth.user}
      signingOut={model.auth.signingOut}
      themeMode={themeMode}
      onOpenProfile={() => {
        model.chrome.closeSidebarDrawer();
        model.auth.openSettings("profile");
      }}
      onOpenLanguageAppearance={() => {
        model.chrome.closeSidebarDrawer();
        model.auth.openSettings("language-appearance");
      }}
      onToggleTheme={model.config.toggleTheme}
      onSignOut={model.auth.signOut}
    />
  );
  const chat = model.selectedChat;
  const collaborationWorkspace = model.collaborationWorkspace;
  const approvals = model.conversationRail.approvals;
  const userLabel = model.auth.user.displayLabel || (model.auth.user.email ?? "");
  const collaborationWorkspaceSelector = collaborationWorkspacesAvailable ? (
    <CollaborationWorkspaceSelector
      collaborationWorkspaces={collaborationWorkspace.collaborationWorkspaces}
      activeCollaborationWorkspaceId={collaborationWorkspace.activeCollaborationWorkspaceId}
      userLabel={userLabel}
      loading={collaborationWorkspace.loading}
      loadFailed={collaborationWorkspace.loadFailed}
      clientBrandingHeader={<ClientBrandingHeader config={model.config.config} />}
      onSelectCollaborationWorkspace={collaborationWorkspace.selectCollaborationWorkspace}
      onOpenCollaborationWorkspaceSettings={collaborationWorkspace.openSettings}
      onBrowseCollaborationWorkspaces={collaborationWorkspace.openBrowseDialog}
      onCreateCollaborationWorkspace={collaborationWorkspace.openCreateDialog}
    />
  ) : undefined;

  const rail = model.conversationRail;
  const closeDrawer = model.chrome.closeSidebarDrawer;
  const startNewChat = () => {
    closeDrawer();
    rail.startNewConversation();
  };
  // A conversation opened from the rail or the palette puts the focus in the composer.
  const openConversation = (conversationId: string) => {
    closeDrawer();
    rail.selectConversation(conversationId);
    model.chrome.requestComposerFocus();
  };

  const workspace = (
    <TranslationProvider locale={model.config.activeLocale} labelOverrides={labelOverrides}>
      <UiRoot
        as="main"
        theme={model.config.theme}
        mode={themeMode}
        labels={uiLabels}
        className={cn(
          "flex h-dvh w-full min-h-0 flex-col overflow-hidden bg-background text-foreground",
          className
        )}
      >
        <WorkspaceShortcuts
          paletteOpen={paletteOpen}
          onTogglePalette={() => setPaletteOpen((open) => !open)}
          // The shortcut also works over the open palette, which would otherwise stay in front.
          onNewChat={() => {
            setPaletteOpen(false);
            startNewChat();
          }}
        />
        <SkipLink target={CONTENT_ID}>
          <SkipLinkLabel />
        </SkipLink>
        <OutdatedInterfaceNotice />
        <StagingBanner environment={model.config.config.clientInstance.environment} />
        <div className="flex min-h-0 flex-1">
          <WorkspaceRail
            config={model.config.config}
            collaborationWorkspaceSelector={collaborationWorkspaceSelector}
            conversations={rail.conversations}
            conversationsStatus={rail.conversationsStatus}
            selectedConversationId={rail.selectedConversationId}
            canViewAdministration={rail.canViewAdministration}
            canViewBuild={model.controlPlane.canViewBuild}
            approvals={approvals}
            view={rail.view}
            deletingConversation={rail.deletingConversation}
            canMoveConversation={rail.canMoveConversation}
            accountMenu={accountMenu}
            collapsed={model.chrome.sidebarCollapsed}
            drawerOpen={model.chrome.sidebarDrawerOpen}
            onDrawerClose={closeDrawer}
            onToggleCollapsed={model.chrome.toggleSidebarCollapsed}
            onOpenSearch={() => {
              closeDrawer();
              setPaletteOpen(true);
            }}
            onViewChange={(view) => {
              closeDrawer();
              rail.selectWorkspaceView(view);
            }}
            onCreateConversation={startNewChat}
            onSelectConversation={openConversation}
            onReloadConversations={rail.reloadConversations}
            onRenameConversation={rail.renameConversation}
            onMoveConversation={rail.moveConversation}
            onDeleteConversation={rail.deleteConversation}
          />

          <div id={CONTENT_ID} tabIndex={-1} className="relative min-w-0 flex-1 outline-none">
            <WorkspaceChrome
              agents={model.config.config.agents}
              agentDisplay={agentChipDisplayFor(model.config.config.ui)}
              surfaceBesideWidth={surfaceBesideWidth}
              covered={chatCovered}
              selectedAgentName={model.config.activeAgentName}
              showAgentSelector={!onStartPage}
              onSelectAgent={model.config.selectAgentName}
              onOpenSidebar={model.chrome.openSidebarDrawer}
            />

            {collaborationWorkspacesAvailable ? (
              <CollaborationWorkspacePanel
                apiBaseUrl={model.auth.apiBaseUrl}
                authScope={WORKSPACE_AUTH_SCOPE}
                client={chat.client}
                userLabel={userLabel}
                collaborationWorkspaces={collaborationWorkspace.collaborationWorkspaces}
                activeCollaborationWorkspaceId={
                  collaborationWorkspace.activeCollaborationWorkspaceId
                }
                dialog={collaborationWorkspace.dialog}
                onClose={collaborationWorkspace.closeDialog}
                onCollaborationWorkspaceCreated={
                  collaborationWorkspace.selectCollaborationWorkspace
                }
                onConversationMoved={collaborationWorkspace.conversationMoved}
              />
            ) : null}

            <ApprovalRevisionHostProvider value={model.approvalRevision}>
              <ControlPlaneRoutes
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
                          "relative h-full min-h-0 min-w-0 flex-1",
                          // 23.5rem = panel width (22rem) + its right-6 offset, so the
                          // thread centers with equal gaps to sidebar and panel edge
                          resourcesVisible && "lg:[--resources-inset:23.5rem]"
                        )}
                        // Under a surface that covers it the chat leaves the tab order.
                        inert={chatCovered}
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
                      <SurfaceSlot
                        onBesideWidthChange={setSurfaceBesideWidth}
                        onCoveringChange={setSurfaceCovering}
                      />
                    </div>
                  </AttachmentContentProvider>
                </section>
              </ControlPlaneRoutes>
            </ApprovalRevisionHostProvider>
          </div>
        </div>
        <ConversationPalette
          open={paletteOpen}
          apiBaseUrl={model.auth.apiBaseUrl}
          authScope={WORKSPACE_AUTH_SCOPE}
          client={chat.client}
          collaborationWorkspaceId={collaborationWorkspace.activeCollaborationWorkspaceId}
          collaborationWorkspacesAvailable={collaborationWorkspacesAvailable}
          searchedWorkspace={collaborationWorkspace.activeCollaborationWorkspace}
          recentConversations={rail.conversations}
          goToTargets={model.controlPlane.goToTargets}
          onNewChat={startNewChat}
          onSelectConversation={openConversation}
          onGoTo={(targetId) => {
            const target = model.controlPlane.goToTargets.find(({ id }) => id === targetId);
            if (target) {
              model.route.showRoute(target.route);
            }
          }}
          onClose={() => setPaletteOpen(false)}
        />
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

/** The id of the main area, where the skip link puts the focus. */
const CONTENT_ID = "workspace-content";

function SkipLinkLabel() {
  return useTranslation().t("nav.skipToContent");
}

/** The frame's shortcuts. They rest while a dialog other than the palette holds the window. */
function WorkspaceShortcuts({
  paletteOpen,
  onTogglePalette,
  onNewChat
}: {
  paletteOpen: boolean;
  onTogglePalette(): void;
  onNewChat(): void;
}) {
  useWorkspaceShortcuts(
    { search: onTogglePalette, newChat: onNewChat },
    () => !paletteOpen && document.querySelector("dialog:modal") !== null
  );
  return null;
}
