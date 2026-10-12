import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn, DocsAddressProvider, SkipLink, Spinner, UiRoot, useExit } from "@vivd-catalyst/ui";
import { DEFAULT_THEME_INPUTS } from "@vivd-catalyst/ui/theme";
import { AgentsPage } from "./agents/agents-page";
import { ApprovalRevisionHostProvider } from "./approvals/approval-revision-host";
import { AssistantRuntimePanel } from "./assistant/assistant-runtime-panel";
import { AttachmentContentProvider } from "./attachment-content";
import { ChatDropOverlay } from "./chat-file-dropzone";
import type { ChatShellProps } from "./chat-shell";
import { collaborationWorkspaceDisplayName } from "./collaboration-workspace/collaboration-workspace-name";
import { CollaborationWorkspacePanel } from "./collaboration-workspace/collaboration-workspace-panel";
import { CollaborationWorkspaceSelector } from "./collaboration-workspace/collaboration-workspace-selector";
import { canViewAudit } from "./control-plane/governance";
import { ControlPlaneRoutes } from "./control-plane/control-plane-routes";
import { createTranslationContext, TranslationProvider, useTranslation } from "./i18n";
import { AppsArea, isAppsRoute } from "./apps/apps-area";
import { AppsHostProvider, type AppsHost } from "./apps/apps-host";
import { InboxArea } from "./inbox";
import { LoginPanel } from "./login-panel";
import { operationRunHref, operationRunsHref } from "./operations/operations-model";
import { PageHostProvider } from "./pages/page-host";
import { ResourcesPanel, ResourcesPanelToggle, useResourcesPanelState } from "./resources-panel";
import { isResourcesPanelAvailable } from "./resources-panel-model";
import { announcePanelMove } from "./surface/panel-move";
import { surfacePlacement } from "./surface/surface-layout";
import { SurfaceSlot } from "./surface/surface-slot";
import { useSplitArea } from "./surface/use-split-area";
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
  // The main area the conversation shares with what opens at its right: the surface and the
  // Resources card stand beside it by one rule.
  const [splitAreaElement, setSplitAreaElement] = useState<HTMLDivElement | null>(null);
  const splitArea = useSplitArea(splitAreaElement, "self");
  const roomBeside = surfacePlacement(splitArea.mainWidth, splitArea.splitMin) === "beside";
  const resourcesPanel = useResourcesPanelState({
    conversationId: resourcesConversationId,
    enabled: resourcesAvailable,
    roomBeside
  });
  const displayPanel = useToolDisplayPanel();
  // The slot reports its placement a render late; a surface that has closed covers nothing at once.
  const inboxRoute = model.route.view === "inbox" ? model.route.route : undefined;
  const agentsRoute = model.route.route.kind === "agents" ? model.route.route : undefined;
  // With the module off the model leads an Apps address to the chat; nothing shows meanwhile.
  const appsRoute =
    model.apps.enabled && isAppsRoute(model.route.route) ? model.route.route : undefined;
  const chatCovered =
    surfaceCovering && (inboxRoute ? inboxRoute.kind === "inbox-item" : displayPanel.open);
  const resourcesShown =
    resourcesPanel.open && resourcesPanel.hasResources && Boolean(resourcesConversationId);
  // The card stays where it is while a surface is open: the surface comes in over it and
  // uncovers it again, so the right-hand column never closes and reopens in between.
  const resourcesExit = useExit(resourcesShown ? resourcesConversationId : undefined);
  // The thread keeps room for the card where the card stands beside it. Under a surface the
  // surface's own width is that room; over a narrow conversation the card takes none.
  const resourcesInset = resourcesShown && roomBeside && !displayPanel.open;
  const resourcesInsetBefore = useRef(resourcesInset);
  useLayoutEffect(() => {
    if (resourcesInsetBefore.current !== resourcesInset) {
      resourcesInsetBefore.current = resourcesInset;
      announcePanelMove(resourcesInset ? "open" : "close");
    }
  }, [resourcesInset]);
  const showsLogin = model.auth.loginRequired || Boolean(passwordSetupToken);
  const themeMode = model.config.resolvedThemeMode;
  const uiLabels = uiLabelsFor(model.config.activeLocale);
  // This component sets the translations up for what it renders, so it reads them directly.
  const { t } = useMemo(
    () => createTranslationContext(model.config.activeLocale, labelOverrides),
    [model.config.activeLocale, labelOverrides]
  );

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
      platform={model.controlPlane.platform}
      docsUrl={model.config.config.ui.docsUrl}
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

  const activeWorkspace = collaborationWorkspace.activeCollaborationWorkspace;
  // The Personal Workspace is named after its owner, here and wherever a surface names it.
  const activeWorkspaceName = activeWorkspace
    ? collaborationWorkspaceDisplayName(activeWorkspace, userLabel, t)
    : undefined;
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

  const pageHost = {
    viewer: { kind: "member" as const, id: model.auth.user.id, displayName: userLabel },
    workspace:
      activeWorkspace && activeWorkspaceName !== undefined
        ? { id: activeWorkspace.id, name: activeWorkspaceName }
        : null,
    theme: model.config.theme ?? DEFAULT_THEME_INPUTS[themeMode],
    mode: themeMode
  };
  const appsHost: AppsHost = {
    enabled: model.apps.enabled,
    rights: model.apps.rights,
    workspace:
      activeWorkspace && activeWorkspaceName !== undefined
        ? { id: activeWorkspace.id, name: activeWorkspaceName, emoji: activeWorkspace.emoji }
        : undefined,
    showRoute: model.route.showRoute,
    startChat: model.apps.startChat,
    ...(canViewAudit(model.auth.user)
      ? { operations: { href: operationRunsHref(), runHref: operationRunHref } }
      : {})
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
            openConversation={rail.openConversation}
            hasMoreConversations={rail.hasMoreConversations}
            loadingMoreConversations={rail.loadingMoreConversations}
            loadMoreConversationsFailed={rail.loadMoreConversationsFailed}
            onLoadMoreConversations={rail.loadMoreConversations}
            conversationsStatus={rail.conversationsStatus}
            selectedConversationId={rail.selectedConversationId}
            canViewAdministration={rail.canViewAdministration}
            canViewBuild={model.controlPlane.canViewBuild}
            inbox={rail.inbox}
            agents={rail.agents}
            apps={rail.apps}
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

          <div
            id={CONTENT_ID}
            tabIndex={-1}
            // Clipped, not hidden: a panel on its way in or out reaches past the edge, and
            // nothing that takes the focus there may scroll the frame sideways.
            className="relative min-w-0 flex-1 overflow-clip outline-none"
          >
            <WorkspaceChrome
              agents={model.config.config.agents}
              agentDisplay={agentChipDisplayFor(model.config.config.ui)}
              // An App takes the whole main area: the surface of the conversation it was opened
              // from stands beside nothing there, so the header is no band over the App's head.
              // The Inbox and the Agents page have a page title where the band would stand: the
              // band would cover it.
              surfaceBesideWidth={appsRoute || inboxRoute || agentsRoute ? 0 : surfaceBesideWidth}
              covered={chatCovered}
              selectedAgentName={model.config.activeAgentName}
              // Only a conversation has an agent to choose: not the Inbox, the Agents page, Apps,
              // Build or Settings.
              showAgentSelector={
                !onStartPage &&
                !inboxRoute &&
                !agentsRoute &&
                !appsRoute &&
                !model.controlPlane.build &&
                !model.controlPlane.settings
              }
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
              <AppsHostProvider value={appsHost}>
                <ControlPlaneRoutes
                  controlPlane={model.controlPlane}
                  agentsArea={
                    agentsRoute ? (
                      <AgentsPage
                        agents={model.config.config.agents}
                        defaultAgentName={model.config.config.defaultAgentName}
                        status={model.agents.status}
                        onRetry={model.agents.retry}
                        onStartChat={model.agents.startChat}
                        onOpenStudio={
                          model.controlPlane.canOpenAgentsInBuild
                            ? model.route.showRoute
                            : undefined
                        }
                      />
                    ) : undefined
                  }
                  appsArea={
                    appsRoute ? (
                      // An App is told who looks at it and how the interface looks, as a Page is.
                      <PageHostProvider conversationId={undefined} {...pageHost}>
                        <AppsArea route={appsRoute} />
                      </PageHostProvider>
                    ) : undefined
                  }
                  inboxArea={
                    inboxRoute ? (
                      <InboxArea
                        itemId={inboxRoute.kind === "inbox-item" ? inboxRoute.itemId : undefined}
                        onOpenItem={(itemId) =>
                          model.route.showRoute({ kind: "inbox-item", itemId })
                        }
                        onCloseItem={() => model.route.showRoute({ kind: "inbox" })}
                        onBesideWidthChange={setSurfaceBesideWidth}
                        onCoveringChange={setSurfaceCovering}
                      />
                    ) : undefined
                  }
                >
                  <section className="relative h-full min-h-0 min-w-0">
                    <AttachmentContentProvider
                      client={chat.client}
                      selectedConversationId={chat.selectedConversationId}
                    >
                      <PageHostProvider conversationId={chat.selectedConversationId} {...pageHost}>
                        <div ref={setSplitAreaElement} className="flex h-full min-h-0 min-w-0">
                          <div
                            className={cn(
                              "relative h-full min-h-0 min-w-0 flex-1",
                              // The card's width of 22rem and its gap of 1.5rem to the edge,
                              // so the thread centres with equal gaps to the sidebar and to
                              // the card. It is less than the split minimum: a card that has
                              // room beside the conversation leaves it its minimum too.
                              resourcesInset && "[--resources-inset:23.5rem]"
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
                            resourcesPanel.hasResources &&
                            !resourcesShown ? (
                              <ResourcesPanelToggle
                                onOpen={() => {
                                  displayPanel.close();
                                  resourcesPanel.openExplicitly();
                                }}
                              />
                            ) : null}
                          </div>
                          <SurfaceSlot
                            onBesideWidthChange={setSurfaceBesideWidth}
                            onCoveringChange={setSurfaceCovering}
                          />
                        </div>
                        {/* Placed in the main area, not in the conversation: it keeps its
                            place when a surface takes room from the conversation. */}
                        {resourcesExit.held ? (
                          <ResourcesPanel
                            client={resourcesPanel.client}
                            conversationId={resourcesExit.held}
                            error={resourcesPanel.error}
                            loading={resourcesPanel.loading}
                            onClose={resourcesPanel.close}
                            open
                            leaving={resourcesExit.leaving}
                            covered={displayPanel.open}
                            onAnimationEnd={resourcesExit.onAnimationEnd}
                            resources={resourcesPanel.resources}
                          />
                        ) : null}
                      </PageHostProvider>
                    </AttachmentContentProvider>
                  </section>
                </ControlPlaneRoutes>
              </AppsHostProvider>
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
          searchedWorkspaceName={activeWorkspaceName}
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
  // Every generated view below is shown under the instance's view policy of today, and every
  // link into the documentation starts from the instance's docs address.
  return (
    <ViewPolicyProvider allowedScriptSrc={model.config.config.views.allowedScriptSrc}>
      <DocsAddressProvider address={model.config.config.ui.docsUrl}>
        {workspace}
      </DocsAddressProvider>
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
