import { AssistantChatPanel } from "./assistant-chat-panel";
import { ChatDropOverlay } from "./chat-file-dropzone";
import type { ChatShellProps } from "./chat-shell";
import { ControlPlaneRoutes } from "./control-plane/control-plane-routes";
import { TranslationProvider } from "./i18n";
import { LoginPanel } from "./login-panel";
import { ToolDisplayPanel } from "./tool-display-panel";
import { ThemeToggle } from "./theme-toggle";
import { cn } from "./ui/cn";
import { UserMenu } from "./user-menu";
import { ConfigCheckPanel, SessionCheckPanel, WorkspaceChrome } from "./workspace-chrome";
import { WorkspaceRail } from "./workspace-rail";
import { type WorkspaceRoute, type WorkspaceRouteChangeOptions } from "./workspace-route";
import { useWorkspaceChatModel } from "./workspace/workspace-chat-model";
import { WorkspaceProviders } from "./workspace/workspace-providers";

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
  const model = useWorkspaceChatModel({ adminPanel, manageDocumentTitle });

  if (model.auth.loginRequired) {
    return (
      <TranslationProvider locale={model.config.activeLocale}>
        <LoginPanel
          apiBaseUrl={model.auth.apiBaseUrl}
          localePreference={model.config.localePreference}
          fallbackLocale={model.config.activeLocale}
          onLocaleChange={model.config.selectLocale}
          manageDocumentTitle={manageDocumentTitle}
          onSignedIn={model.auth.invalidateCurrentUser}
        />
      </TranslationProvider>
    );
  }

  if (!model.auth.user) {
    return (
      <TranslationProvider locale={model.config.activeLocale}>
        <SessionCheckPanel className={className} error={model.auth.sessionError} />
      </TranslationProvider>
    );
  }

  if (!model.config.config) {
    return (
      <TranslationProvider locale={model.config.activeLocale}>
        <ConfigCheckPanel className={className} error={model.config.error} />
      </TranslationProvider>
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

  return (
    <TranslationProvider locale={model.config.activeLocale}>
      <main
        className={cn(
          "relative grid h-dvh w-full min-h-0 overflow-hidden bg-background text-foreground transition-colors md:grid-rows-[minmax(0,1fr)] max-md:grid-cols-1",
          model.chrome.sidebarOpen ? "md:grid-cols-[20rem_minmax(0,1fr)]" : "md:grid-cols-[minmax(0,1fr)]",
          isStaging && "pt-6",
          model.config.resolvedThemeMode === "dark" && "dark",
          className
        )}
        style={model.config.workspaceStyle}
      >
        {model.chrome.sidebarOpen ? (
          <button
            type="button"
            className="fixed inset-0 z-30 bg-black/35 backdrop-blur-[1px] md:hidden"
            aria-label="Close sidebar"
            onClick={model.chrome.closeSidebar}
          />
        ) : null}

        {model.chrome.sidebarOpen ? (
          <div
            className={cn(
              "fixed bottom-0 left-0 z-50 w-[min(20rem,calc(100vw-2rem))] min-w-0 translate-x-0 transition-[top,transform] duration-200 md:static md:z-50 md:w-auto md:translate-x-0",
              isStaging ? "top-6" : "top-0"
            )}
          >
            <WorkspaceRail
              config={model.config.config}
              conversations={model.conversationRail.conversations}
              selectedConversationId={model.conversationRail.selectedConversationId}
              canViewAdministration={model.conversationRail.canViewAdministration}
              view={model.conversationRail.view}
              creatingConversation={model.conversationRail.creatingConversation}
              deletingConversation={model.conversationRail.deletingConversation}
              userMenu={userMenu}
              onToggleSidebar={model.chrome.closeSidebar}
              onViewChange={model.conversationRail.selectWorkspaceView}
              onCreateConversation={model.conversationRail.startNewConversation}
              onSelectConversation={model.conversationRail.selectConversation}
              onDeleteConversation={model.conversationRail.deleteConversation}
            />
          </div>
        ) : null}

        <WorkspaceChrome
          agents={model.config.config.agents}
          contextLabel={
            model.config.config.ui.clientName ??
            model.config.config.clientInstance.displayName
          }
          displayPanelOpen={model.toolDisplay.open}
          environment={model.config.config.clientInstance.environment}
          sidebarOpen={model.chrome.sidebarOpen}
          selectedAgentName={model.config.activeAgentName}
          themeMode={model.config.resolvedThemeMode}
          onSelectAgent={model.config.selectAgentName}
          onToggleSidebar={model.chrome.toggleSidebar}
          onToggleTheme={model.config.toggleTheme}
        />

        <ControlPlaneRoutes adminPanel={adminPanel} controlPlane={model.controlPlane}>
          <section className="relative h-full min-h-0 min-w-0">
            <div className="flex h-full min-h-0 min-w-0">
              <div
                className="relative h-full min-h-0 min-w-0 flex-1 transition-[width] duration-300 ease-out"
                onDragEnter={chat.fileDropzone.onChatDragEnter}
                onDragOver={chat.fileDropzone.onChatDragOver}
                onDragLeave={chat.fileDropzone.onChatDragLeave}
                onDrop={chat.fileDropzone.onChatDrop}
              >
                <AssistantChatPanel chat={chat} />
                {chat.fileDropzone.draggingFiles ? <ChatDropOverlay /> : null}
              </div>
              <ToolDisplayPanel
                headerAction={
                  <ThemeToggle
                    mode={model.config.resolvedThemeMode}
                    onToggle={model.config.toggleTheme}
                  />
                }
              />
            </div>
          </section>
        </ControlPlaneRoutes>
      </main>
    </TranslationProvider>
  );
}
