import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cn, SkipLink, Spinner, UiRoot, useExit } from "@work-shape/catalyst-ui";
import { DocsAddressProvider } from "@work-shape/catalyst-ui";
import { DEFAULT_THEME_INPUTS } from "@work-shape/catalyst-ui/theme";
import { startNewAgent } from "./studio/agents/agents-model";
import { AgentsPage } from "./studio/agents/agents-page";
import { ApprovalRevisionHostProvider } from "./chat/approvals/approval-revision-host";
import { AgentTryHostProvider, useAgentTry } from "./chat/dock/agent-try";
import { DockConversationPane } from "./chat/dock/dock-conversation-pane";
import { AttachmentContentProvider } from "./chat/files/attachment-content";
import { ChatDropOverlay } from "./chat/files/chat-file-dropzone";
import type { ChatShellProps } from "./chat-shell";
import { collaborationWorkspaceDisplayName } from "./shared/collaboration-workspace/collaboration-workspace-name";
import { CollaborationWorkspacePanel } from "./shared/collaboration-workspace/collaboration-workspace-panel";
import { CollaborationWorkspaceSelector } from "./shared/collaboration-workspace/collaboration-workspace-selector";
import { canManageUsers, canViewAudit } from "./shared/governance";
import { ControlPlaneRoutes } from "./admin/control-plane/control-plane-routes";
import { DockedChat, DockedPage, useChatDockView } from "./chat/dock/docked-chat";
import {
  createTranslationContext,
  TranslationProvider,
  useDocumentLanguage,
  useTranslation
} from "./shared/i18n";
import { AppsArea, isAppsRoute } from "./studio/apps/apps-area";
import { AppsHostProvider, type AppsHost } from "./studio/apps/apps-host";
import { WorkflowsArea, isWorkflowsRoute } from "./studio/workflows/workflows-area";
import {
  readsRecipientPeople,
  WorkflowsHostWithRecipients,
  type WorkflowsHost
} from "./studio/workflows/workflows-host";
import { connectionDraftHost } from "./studio/build-area/connection-draft-card";
import { ConnectionDraftHostProvider } from "./studio/build-area/connection-draft-host";
import {
  ConnectionGiveCardHostProvider,
  type ConnectionGiveCardHost
} from "./studio/build-area/connection-give-card";
import { AGENTS_BUILD_PATH, buildRouteOfLocation } from "./shared/build-route";
import { useRailApps } from "./studio/apps/rail-apps";
import { InboxArea } from "./chat/inbox";
import { ScheduledPage } from "./chat/scheduled/scheduled-page";
import { LoginPanel } from "./chat/login-panel";
import { operationRunHref, operationRunsHref } from "./shared/operations-model";
import { PageHostProvider } from "./studio/pages/page-host";
import {
  ConnectionSignInLanding,
  useSignInLanding
} from "./studio/build-area/connection-sign-in-landing";
import { CONNECTIONS_BUILD_PATH } from "./studio/build-area/connection-tools";
import {
  ResourcesPanel,
  ResourcesPanelToggle,
  useResourcesPanelState
} from "./chat/files/resources-panel";
import { isResourcesPanelAvailable } from "./chat/files/resources-panel-model";
import { announcePanelMove } from "./chat/surface/panel-move";
import { surfacePlacement } from "./chat/surface/surface-layout";
import { SurfaceSlot } from "./chat/surface/surface-slot";
import { useSplitArea } from "./chat/surface/use-split-area";
import { useSurfaceReport } from "./chat/surface/use-surface-report";
import { useToolDisplayPanel } from "./chat/tools/tool-display-panel";
import { uiLabelsFor } from "./shared/ui-labels";
import { MarkdownLinkPolicyProvider } from "./chat/markdown/markdown-text";
import { ViewPolicyProvider } from "./chat/views/view-policy";
import { agentChipDisplayFor } from "./chat/workspace/agent-selector";
import { ClientBrandingHeader } from "./chat/workspace/client-branding";
import { ConversationPalette } from "./chat/workspace/conversation-palette";
import { RouteNotFound } from "./chat/workspace/route-not-found";
import { UserMenu } from "./chat/workspace/user-menu";
import {
  ConfigCheckPanel,
  ClosedWorkspaceLinkBanner,
  OutdatedInterfaceNotice,
  SessionCheckPanel,
  StagingBanner,
  WorkspaceChrome
} from "./chat/workspace/workspace-chrome";
import { WorkspaceRail } from "./chat/workspace/workspace-rail";
import { type WorkspaceRoute, type WorkspaceRouteChangeOptions } from "./shared/workspace-route";
import { useWorkspaceChatModel, WORKSPACE_AUTH_SCOPE } from "./chat/workspace/workspace-chat-model";
import { WorkspaceProviders } from "./chat/workspace/workspace-providers";
import { useRequestLocale } from "./shared/api/workspace-api-client";
import {
  useWorkspaceShortcuts,
  workspaceShortcutLabel
} from "./chat/workspace/workspace-shortcuts";
import { DockCreationScopeProvider, DockPageChatProvider } from "./shared/dock-page-chat";

// The Workflow screens on sample data: a page for whoever may open the UI library, loaded
// only when it is opened.
const WorkflowSamples = lazy(async () => {
  const { WorkflowSamples: Samples } = await import("./studio/workflows/samples/workflow-samples");
  return { default: Samples };
});
// The gallery of the shared UI library is its own chunk, loaded only when its route is opened.
const UiGallery = lazy(async () => {
  const { UiGallery: Gallery } = await import("@work-shape/catalyst-ui/gallery");
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
  chat,
  viewTransitions = false,
  onRouteChange
}: ChatWorkspaceProps) {
  const workspacesAvailable = collaborationWorkspacesAvailableFor({ token, getToken });

  return (
    <WorkspaceProviders
      apiBaseUrl={apiBaseUrl}
      token={token}
      getToken={getToken}
      route={route}
      chat={chat}
      onRouteChange={onRouteChange}
    >
      <ChatWorkspaceContent
        labelOverrides={labelOverrides}
        administration={administration}
        manageDocumentTitle={manageDocumentTitle}
        onThemeModeChange={onThemeModeChange}
        className={className}
        viewTransitions={viewTransitions}
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
  viewTransitions,
  collaborationWorkspacesAvailable
}: Pick<
  ChatWorkspaceProps,
  "administration" | "labelOverrides" | "manageDocumentTitle" | "onThemeModeChange" | "className"
> & {
  /** The host plays the dock's movement as a view transition. */
  viewTransitions: boolean;
  collaborationWorkspacesAvailable: boolean;
}) {
  const model = useWorkspaceChatModel({
    administration,
    manageDocumentTitle,
    collaborationWorkspacesAvailable
  });
  const onChatRoute = model.route.view === "chat";
  const onStartPage = onChatRoute && !model.route.selectedConversationId;
  const dock = model.route.dock;
  // What the surface beside the conversation reports of itself; the Inbox's reading side
  // reports the same of itself.
  const chatSurface = useSurfaceReport();
  const inboxSurface = useSurfaceReport();
  const dockView = useChatDockView({
    dock,
    route: model.route.route,
    onChatRoute,
    viewTransitions
  });
  // Build and Try in the dock on an agent's page.
  const agentTry = useAgentTry({ client: model.selectedChat.client, dock });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [passwordSetupToken, setPasswordSetupToken] = useState(readPasswordSetupToken);
  // A tab an OAuth sign-in of a Connection came back to shows its outcome alone.
  const [signInLanding, leaveSignInLanding] = useSignInLanding();

  function clearPasswordSetupToken() {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
    setPasswordSetupToken(undefined);
  }
  // The Resources card belongs to the chat route: the dock is too narrow to hold it beside.
  const resourcesEnabled =
    onChatRoute && (model.config.config?.features.resources.enabled ?? false);
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
  // An address of the Workflows shows nothing until the instance has said whether the area is
  // there for this person: the model leads a closed one to the chat.
  const workflowsRoute = isWorkflowsRoute(model.route.route) ? model.route.route : undefined;
  const scheduledRoute = model.route.route.kind === "scheduled" ? model.route.route : undefined;
  // The published Apps of the open workspace, under the Apps row of the rail.
  const railAppsWorkspaceId = model.collaborationWorkspace.activeCollaborationWorkspaceId;
  const railApps = useRailApps({
    enabled: model.apps.enabled,
    userId: model.auth.user?.id,
    workspaceId: railAppsWorkspaceId,
    openApp: appsRoute?.kind === "app" ? appsRoute.app : undefined
  });
  const chatCovered = onChatRoute && chatSurface.covering && displayPanel.open;
  // The header's button that opens the sidebar leaves the tab order where a surface covers it.
  const headerCovered = inboxRoute
    ? inboxSurface.covering && inboxRoute.kind === "inbox-item"
    : onChatRoute && chatCovered;
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

  useDocumentLanguage(model.config.activeLocale, manageDocumentTitle);
  useRequestLocale(model.config.activeLocale);

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
            disabled={model.auth.accountDisabled}
            retrying={model.auth.sessionRetrying}
            signingOut={model.auth.signingOut}
            onRetry={model.auth.retryCurrentUser}
            onSignOut={model.auth.signOut}
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

  if (signInLanding) {
    return (
      <TranslationProvider locale={model.config.activeLocale} labelOverrides={labelOverrides}>
        <UiRoot as="main" theme={model.config.theme} mode={themeMode} labels={uiLabels}>
          <ConnectionSignInLanding
            landing={signInLanding}
            onOpen={(connection) => {
              leaveSignInLanding();
              model.route.showRoute(
                connection === undefined
                  ? { kind: "build-kind", assetKind: CONNECTIONS_BUILD_PATH }
                  : { kind: "build-asset", assetKind: CONNECTIONS_BUILD_PATH, name: connection }
              );
            }}
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
        {model.route.route.kind === "workflow-samples" ? (
          <WorkflowSamples
            theme={model.config.theme}
            mode={themeMode}
            locale={model.config.activeLocale}
          />
        ) : (
          <UiGallery initialMode={themeMode} initialLanguage={model.config.activeLocale} />
        )}
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
  const { selectedChat: chat, collaborationWorkspace, conversationRail: rail } = model;
  const userLabel = model.auth.user.displayLabel || (model.auth.user.email ?? "");
  const collaborationWorkspaceSelector = collaborationWorkspacesAvailable ? (
    <CollaborationWorkspaceSelector
      collaborationWorkspaces={collaborationWorkspace.collaborationWorkspaces}
      activeCollaborationWorkspaceId={collaborationWorkspace.activeCollaborationWorkspaceId}
      buildingCollaborationWorkspace={collaborationWorkspace.buildingCollaborationWorkspace}
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

  const dockConversationId = dock.conversationId;
  // The dock names its conversation by the loaded thread, and by its row until then.
  const dockTitle =
    chat.selectedConversationTitle ||
    rail.conversations.find(({ id }) => id === dockConversationId)?.title;
  const dockAgent = model.config.config.agents.find(
    ({ name }) => name === model.config.activeAgentName
  )?.displayName;

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
    // A Builder who is no member opens an App draft of the workspace, and nothing else of it.
    workspace:
      activeWorkspace && activeWorkspaceName !== undefined
        ? { id: activeWorkspace.id, name: activeWorkspaceName, emoji: activeWorkspace.emoji }
        : collaborationWorkspace.buildingCollaborationWorkspace && {
            id: collaborationWorkspace.buildingCollaborationWorkspace.id,
            name: collaborationWorkspace.buildingCollaborationWorkspace.name
          },
    showRoute: model.route.showRoute,
    startChat: model.apps.startChat,
    editWithAgent: model.apps.editWithAgent,
    ...(model.apps.startNew ? { startNew: model.apps.startNew } : {}),
    ...(canViewAudit(model.auth.user)
      ? { operations: { href: operationRunsHref(), runHref: operationRunHref } }
      : {})
  };
  const workflowsHost: WorkflowsHost | undefined =
    model.workflows.access === "open"
      ? {
          rights: model.workflows.rights,
          ...(model.workflows.instanceTimeZone
            ? { instanceTimeZone: model.workflows.instanceTimeZone }
            : {}),
          viewerId: model.auth.user.id,
          workspace: activeWorkspace
            ? { id: activeWorkspace.id, name: activeWorkspace.name }
            : undefined,
          showRoute: model.route.showRoute,
          editWithAgent: model.workflows.editWithAgent,
          ...(model.workflows.startNew ? { startNew: model.workflows.startNew } : {})
        }
      : undefined;
  const connectionDraft = connectionDraftHost({
    client: chat.client,
    apiBaseUrl: model.auth.apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    mayWriteConnections: model.controlPlane.mayWriteConnections,
    // The dialog or page opens with the conversation of the card docked beside it.
    showRoute: chat.openRoute,
    ownsConversation:
      chat.selectedConversationOwnerId !== undefined &&
      chat.selectedConversationOwnerId === model.auth.user.id,
    tellConversation: chat.tellConversation,
    ...(chat.selectedConversationId === undefined
      ? {}
      : {
          from: {
            conversationId: chat.selectedConversationId,
            ...(chat.selectedAgentName === undefined ? {} : { agentName: chat.selectedAgentName })
          }
        })
  });
  // The agent's offer of a Connection's tools: its card gives them to an agent the person may
  // publish, with the person's own rights.
  const connectionGive: ConnectionGiveCardHost = {
    client: chat.client,
    viewerId: model.auth.user.id,
    apiBaseUrl: model.auth.apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    openAgent: (name) =>
      model.route.showRoute(buildRouteOfLocation({ kindPath: AGENTS_BUILD_PATH, name }))
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
          // Beside a page the keys open the dock, and close it again; the chat route has none.
          onChat={() => {
            if (onChatRoute) return;
            setPaletteOpen(false);
            if (dock.open) {
              dock.close();
            } else {
              model.dockChat.open();
            }
          }}
        />
        <SkipLink target={CONTENT_ID}>
          <SkipLinkLabel />
        </SkipLink>
        <OutdatedInterfaceNotice />
        <StagingBanner environment={model.config.config.clientInstance.environment} />
        {model.collaborationWorkspace.closedLink ? (
          <ClosedWorkspaceLinkBanner
            administrators={model.collaborationWorkspace.closedLink.administrators}
            onDismiss={model.collaborationWorkspace.dismissClosedLink}
          />
        ) : null}
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
            workflows={rail.workflows}
            scheduled={rail.scheduled}
            publishedApps={railApps.apps}
            morePublishedApps={railApps.more}
            openAppName={appsRoute?.kind === "app" ? appsRoute.app : undefined}
            onOpenApp={(app) => {
              if (railAppsWorkspaceId) {
                closeDrawer();
                model.route.showRoute({
                  kind: "app",
                  collaborationWorkspaceId: railAppsWorkspaceId,
                  app
                });
              }
            }}
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
            ref={dockView.measure}
            tabIndex={-1}
            // Clipped, not hidden: a panel on its way in or out reaches past the edge, and
            // nothing that takes the focus there may scroll the frame sideways.
            className="group/workspace-content relative flex min-w-0 flex-1 overflow-clip outline-none"
          >
            <WorkspaceChrome
              agents={model.config.config.agents}
              agentDisplay={agentChipDisplayFor(model.config.config.ui)}
              // An App takes the whole main area, and so do a Workflow and a Studio page: the
              // band gives way to the pinned head they stand under, which it would cover, and so
              // does it to a sub-rail that names its area. In a narrow window a list scrolls
              // under the band like a conversation; from 768 px up a page has no band.
              conversation={onChatRoute}
              // Only beside a conversation does a surface share the main area with the band.
              surfaceBesideWidth={onChatRoute ? chatSurface.besideWidth : 0}
              covered={headerCovered}
              selectedAgentName={model.config.activeAgentName}
              // Only a conversation has an agent to choose: no other area has one.
              showAgentSelector={onChatRoute && !onStartPage}
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
                {/* Around every area: a Data Store's page in Studio links to the Workflows
                    that use the store. */}
                <WorkflowsHostWithRecipients
                  value={workflowsHost}
                  api={{
                    apiBaseUrl: model.auth.apiBaseUrl,
                    authScope: WORKSPACE_AUTH_SCOPE,
                    client: chat.client
                  }}
                  viewer={{ id: model.auth.user.id, name: userLabel }}
                  workspaces={collaborationWorkspace.collaborationWorkspaces.map((workspace) => ({
                    id: workspace.id,
                    name: collaborationWorkspaceDisplayName(workspace, userLabel, t)
                  }))}
                  readsPeople={readsRecipientPeople(
                    model.route.route,
                    canManageUsers(model.auth.user)
                  )}
                >
                  <ConnectionDraftHostProvider value={connectionDraft}>
                    <ConnectionGiveCardHostProvider value={connectionGive}>
                      <AgentTryHostProvider value={agentTry.host}>
                        {dockView.mode === undefined ? null : (
                          <DockedChat
                            view={{ ...dockView, mode: dockView.mode }}
                            dock={dock}
                            title={dockTitle}
                            agent={dockAgent}
                            {...(agentTry.view === undefined ? {} : { agentTry: agentTry.view })}
                            onOpenFullChat={
                              dockConversationId === undefined
                                ? undefined
                                : () => openConversation(dockConversationId)
                            }
                            onNewChat={model.dockChat.newChat}
                          >
                            <section className="relative h-full min-h-0 min-w-0">
                              <AttachmentContentProvider
                                client={chat.client}
                                selectedConversationId={chat.selectedConversationId}
                              >
                                <PageHostProvider
                                  conversationId={chat.selectedConversationId}
                                  {...pageHost}
                                >
                                  <div
                                    ref={setSplitAreaElement}
                                    className="flex h-full min-h-0 min-w-0"
                                  >
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
                                      <DockConversationPane chat={chat} agentTry={agentTry.pane} />
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
                                    {/* Beside a page the dock's surfaces cover the page instead. */}
                                    {onChatRoute ? (
                                      <SurfaceSlot
                                        onBesideWidthChange={chatSurface.reportBesideWidth}
                                        onCoveringChange={chatSurface.reportCovering}
                                      />
                                    ) : null}
                                  </div>
                                  {/* Placed in the main area, not in the conversation: it keeps its
                                place when a surface takes room from the conversation. */}
                                  {resourcesExit.held ? (
                                    <ResourcesPanel
                                      client={resourcesPanel.client}
                                      conversationId={resourcesExit.held}
                                      {...resourcesPanel.contents}
                                      onClose={resourcesPanel.close}
                                      open
                                      leaving={resourcesExit.leaving}
                                      covered={displayPanel.open}
                                      onAnimationEnd={resourcesExit.onAnimationEnd}
                                    />
                                  ) : null}
                                </PageHostProvider>
                              </AttachmentContentProvider>
                            </section>
                          </DockedChat>
                        )}
                        {onChatRoute ? null : (
                          // What the dock's conversation opens covers the page beside it, an App
                          // or a Page among it: that surface is told who looks at it, as it is
                          // beside the conversation, or the App waits for an answer to `ready`.
                          <PageHostProvider
                            conversationId={chat.selectedConversationId}
                            {...pageHost}
                          >
                            <DockedPage
                              view={dockView}
                              dock={dock}
                              running={chat.conversationRunning}
                              shortcut={workspaceShortcutLabel("chat")}
                              onChat={model.dockChat.open}
                            >
                              <DockPageChatProvider value={model.dockChat.offerPageChat}>
                                <DockCreationScopeProvider
                                  value={model.dockChat.offerCreationScope}
                                >
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
                                          newAgent={
                                            model.controlPlane.agentCreation
                                              ? {
                                                  ...model.controlPlane.agentCreation,
                                                  startsIn: {
                                                    workspace:
                                                      activeWorkspace?.kind === "shared"
                                                        ? {
                                                            id: activeWorkspace.id,
                                                            name: activeWorkspace.name
                                                          }
                                                        : undefined,
                                                    mayChooseAll:
                                                      model.controlPlane.agentCreation.mayChooseAll
                                                  },
                                                  onStart: (start) =>
                                                    startNewAgent(model.route.showRoute, start)
                                                }
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
                                    workflowsArea={
                                      workflowsRoute ? (
                                        model.workflows.access === "open" ? (
                                          <WorkflowsArea route={workflowsRoute} />
                                        ) : (
                                          <div className="h-full bg-background" />
                                        )
                                      ) : undefined
                                    }
                                    scheduledArea={
                                      scheduledRoute ? (
                                        <ScheduledPage
                                          key={scheduledRoute.collaborationWorkspaceId}
                                          workspaceId={scheduledRoute.collaborationWorkspaceId}
                                          agents={model.config.config.agents}
                                          defaultAgentName={model.config.config.defaultAgentName}
                                          {...(model.controlPlane.canViewBuild
                                            ? {
                                                connectionsRoute: {
                                                  kind: "build-kind",
                                                  assetKind: CONNECTIONS_BUILD_PATH
                                                }
                                              }
                                            : {})}
                                          onOpenRoute={model.route.showRoute}
                                        />
                                      ) : undefined
                                    }
                                    inboxArea={
                                      inboxRoute ? (
                                        <InboxArea
                                          itemId={
                                            inboxRoute.kind === "inbox-item"
                                              ? inboxRoute.itemId
                                              : undefined
                                          }
                                          onOpenItem={(itemId) =>
                                            model.route.showRoute({ kind: "inbox-item", itemId })
                                          }
                                          onCloseItem={() =>
                                            model.route.showRoute({ kind: "inbox" })
                                          }
                                          onBesideWidthChange={inboxSurface.reportBesideWidth}
                                          onCoveringChange={inboxSurface.reportCovering}
                                        />
                                      ) : undefined
                                    }
                                  >
                                    {model.route.view === "not-found" ? (
                                      <RouteNotFound onOpenChat={startNewChat} />
                                    ) : null}
                                  </ControlPlaneRoutes>
                                </DockCreationScopeProvider>
                              </DockPageChatProvider>
                            </DockedPage>
                          </PageHostProvider>
                        )}
                      </AgentTryHostProvider>
                    </ConnectionGiveCardHostProvider>
                  </ConnectionDraftHostProvider>
                </WorkflowsHostWithRecipients>
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
  // Every generated view below is shown under the instance's view policy of today, every
  // link in a reply or Markdown preview under its link hosts, and every link into the
  // documentation starts from the instance's docs address.
  return (
    <ViewPolicyProvider allowedScriptSrc={model.config.config.views.allowedScriptSrc}>
      <MarkdownLinkPolicyProvider
        allowedLinkHosts={model.config.config.replies.allowedLinkHosts}
        ownOrigins={instanceOrigins(model.auth.apiBaseUrl)}
      >
        <DocsAddressProvider address={model.config.config.ui.docsUrl}>
          {workspace}
        </DocsAddressProvider>
      </MarkdownLinkPolicyProvider>
    </ViewPolicyProvider>
  );
}

/** The page's origin and the API's, which may be another host of the same instance. */
function instanceOrigins(apiBaseUrl: string): string[] {
  const pageOrigin = window.location.origin;
  const apiOrigin = new URL(apiBaseUrl, window.location.href).origin;
  return apiOrigin === pageOrigin ? [pageOrigin] : [pageOrigin, apiOrigin];
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
  onNewChat,
  onChat
}: {
  paletteOpen: boolean;
  onTogglePalette(): void;
  onNewChat(): void;
  onChat(): void;
}) {
  useWorkspaceShortcuts(
    { search: onTogglePalette, newChat: onNewChat, chat: onChat },
    () => !paletteOpen && document.querySelector("dialog:modal") !== null
  );
  return null;
}
