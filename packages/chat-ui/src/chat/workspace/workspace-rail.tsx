import {
  Blocks,
  ChevronRight,
  Folder,
  Lock,
  PanelLeft,
  Plus,
  Search,
  Settings,
  SquarePen
} from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import type {
  ConversationListItem,
  ProjectView,
  SafeConfig
} from "@work-shape/catalyst-api-client";
import {
  Avatar,
  Button,
  EmptyState,
  IconButton,
  NavGroup,
  NavItem,
  RegistryIcon,
  Sidebar,
  Skeleton,
  useSidebarCollapsed
} from "@work-shape/catalyst-ui";
import { RAIL_APPS_LIMIT, useRailAppsOpen, type RailApp } from "../../studio/apps/rail-apps";
import { ConversationButton } from "../conversation/conversation-button";
import { useTranslation } from "../../shared/i18n";
import { ClientBrandingLogo, clientBrandingFrom } from "./client-branding";
import {
  railSections,
  shownRailSections,
  type RailSection,
  type RailSectionsGiven
} from "./rail-sections";
import type { WorkspaceRouteView } from "../../shared/workspace-route";
import { workspaceShortcutLabel } from "./workspace-shortcuts";

export type WorkspaceView = WorkspaceRouteView;

/** How many projects of the open workspace the rail lists under "Projects" (PRJ-5). */
const RAIL_PROJECTS_LIMIT = 5;

/** A project as the rail lists it. */
type RailProject = Pick<ProjectView, "id" | "name" | "title" | "audience">;

export { railSections, shownRailSections, type RailSection };

interface WorkspaceRailProps {
  config: SafeConfig;
  /** Absent for embedded token sessions, which show the client's branding in its place. */
  collaborationWorkspaceSelector?: ReactNode;
  /** The section rows. */
  sections?: readonly RailSection[];
  /** The conversations of the workspace that are loaded, latest activity first. */
  conversations: readonly ConversationListItem[];
  /** The conversation on screen, which may be older than the loaded ones. */
  openConversation?: ConversationListItem;
  /** The workspace holds older conversations than the loaded ones. */
  hasMoreConversations?: boolean;
  loadingMoreConversations?: boolean;
  /** The last request for older conversations failed. The loaded ones stay. */
  loadMoreConversationsFailed?: boolean;
  onLoadMoreConversations?: () => void;
  conversationsStatus: "loading" | "failed" | "ready";
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
  /** The viewer may open Build: the rail shows its row above the account row. */
  canViewBuild?: boolean;
  /** Present for a person who may decide requests or has made one: the Inbox row shows. */
  inbox?: RailSectionsGiven["inbox"];
  /**
   * The session has workspaces and the open one offers two agents or more, or the person may
   * write one: the Agents row shows.
   */
  agents?: boolean;
  /** The Apps module is on: the Apps row shows. */
  apps?: boolean;
  /** The Workflows area is open to the person: the Workflows row shows. */
  workflows?: boolean;
  /** The session has workspaces: the Scheduled row shows. */
  scheduled?: boolean;
  /** The Projects module is on and the session has workspaces: the Projects row shows. */
  projects?: boolean;
  /**
   * Present while projects are on: a conversation's menu moves it into a project, for its
   * author, and takes it out of one (PRJ-1).
   */
  projectActions?: {
    canMoveIn(conversation: ConversationListItem): boolean;
    moveIn(conversation: ConversationListItem): void;
    remove(conversation: ConversationListItem): void;
  };
  /**
   * The projects of the open workspace the person sees, used last first (PRJ-5). The first
   * `RAIL_PROJECTS_LIMIT` stand in a group above "Recent", with a row to all of them.
   */
  recentProjects?: readonly RailProject[];
  /** The project on screen: its row is the current one. */
  openProjectName?: string;
  onOpenProject?: (project: string) => void;
  /** The plus on the Projects group's label makes a project in the open workspace. */
  onCreateProject?: () => void;
  /**
   * The published Apps the person may open, most recently used first. The first
   * `RAIL_APPS_LIMIT` fold under the Apps row, whose caret opens and folds them; the row
   * itself opens the page with every App.
   */
  publishedApps?: readonly RailApp[];
  /** The workspace holds more Apps than `publishedApps`: "All apps" follows the listed ones. */
  morePublishedApps?: boolean;
  /** The App on screen: its row is the current one in place of the Apps row. */
  openAppName?: string;
  onOpenApp?: (app: string) => void;
  view: WorkspaceView;
  deletingConversation: boolean;
  canMoveConversation: boolean;
  /** The account menu. It shows its avatar alone in the collapsed rail. */
  accountMenu: ReactNode;
  collapsed: boolean;
  drawerOpen: boolean;
  onDrawerClose: () => void;
  onToggleCollapsed: () => void;
  onOpenSearch: () => void;
  onViewChange: (view: WorkspaceView) => void;
  onCreateConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onReloadConversations: () => void;
  onRenameConversation: (conversationId: string, title: string) => Promise<void>;
  onMoveConversation: (conversationId: string, title: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}

/**
 * The frame's navigation: the workspace selector with search and collapse, New chat, the
 * section rows with the published Apps under theirs, the workspace's conversations under "Recent", which load page by page as a
 * person scrolls, and a footer with the account menu and the settings. Collapsed it is a strip of icons; under
 * 768 px it is a drawer.
 */
export function WorkspaceRail(props: WorkspaceRailProps) {
  const { t } = useTranslation();
  const sections = shownRailSections(props.sections ?? railSections, {
    projects: props.projects,
    agents: props.agents,
    inbox: props.inbox,
    apps: props.apps,
    workflows: props.workflows,
    scheduled: props.scheduled
  });

  return (
    <Sidebar
      label={t("nav.label")}
      collapsed={props.collapsed}
      drawerOpen={props.drawerOpen}
      onDrawerClose={props.onDrawerClose}
      header={<RailHeader {...props} sections={sections} />}
      footer={<RailFooter {...props} />}
    >
      <RecentProjects {...props} />
      <RecentConversations {...props} />
    </Sidebar>
  );
}

function RailHeader({
  config,
  collaborationWorkspaceSelector,
  sections,
  inbox,
  publishedApps = [],
  morePublishedApps = false,
  openAppName,
  onOpenApp,
  view,
  collapsed,
  onToggleCollapsed,
  onOpenSearch,
  onViewChange,
  onCreateConversation
}: WorkspaceRailProps & { sections: readonly RailSection[] }) {
  const { t } = useTranslation();
  // A drawer is never collapsed, so the sidebar says what it shows.
  const iconsOnly = useSidebarCollapsed();
  const search = (
    <IconButton
      label={t("nav.search")}
      shortcut={workspaceShortcutLabel("search")}
      onClick={onOpenSearch}
    >
      <Search aria-hidden="true" />
    </IconButton>
  );
  const collapse = (
    <IconButton
      // A drawer has no collapsed strip.
      className="max-md:hidden"
      label={t(collapsed ? "nav.expand" : "nav.collapse")}
      aria-expanded={!collapsed}
      onClick={onToggleCollapsed}
    >
      <PanelLeft aria-hidden="true" />
    </IconButton>
  );
  const newChat = (
    <NavItem
      icon={<SquarePen aria-hidden="true" />}
      shortcut={workspaceShortcutLabel("newChat")}
      onClick={onCreateConversation}
    >
      {t("nav.newChat")}
    </NavItem>
  );
  // The Apps under their row, as the conversations stand under "Recent": the strip of icons
  // has no room for a list. An App that is listed and open is the current row itself, while
  // its row is in view.
  const appRows = iconsOnly ? [] : publishedApps.slice(0, RAIL_APPS_LIMIT);
  const listedOpenApp = appRows.some((app) => app.name === openAppName) ? openAppName : undefined;
  const appsFold = useRailAppsOpen(listedOpenApp);
  const appsGroupId = useId();
  const appsShown = appRows.length > 0 && appsFold.open;
  const sectionRows = sections.flatMap((section) => {
    const count = section.count?.({ inbox }) ?? 0;
    const folds = section.id === "apps" && appRows.length > 0;
    const row = (
      <NavItem
        key={section.id}
        icon={<RegistryIcon name={section.icon} />}
        selected={view === section.view && !(section.id === "apps" && appsShown && listedOpenApp)}
        count={count > 0 ? count : undefined}
        aria-label={count > 0 && section.countLabel ? t(section.countLabel, { count }) : undefined}
        onClick={() => onViewChange(section.view)}
        {...(folds
          ? {
              trailingShown: true,
              trailing: (
                <IconButton
                  size="sm"
                  label={t(appsFold.open ? "nav.appsHide" : "nav.appsShow")}
                  aria-expanded={appsFold.open}
                  aria-controls={appsFold.open ? appsGroupId : undefined}
                  data-testid="rail-apps-toggle"
                  onClick={appsFold.toggle}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={appsFold.open ? "rotate-90" : undefined}
                  />
                </IconButton>
              )
            }
          : {})}
      >
        {t(section.label)}
      </NavItem>
    );
    if (section.id !== "apps" || !appsShown) {
      return [row];
    }
    return [
      row,
      <NavGroup
        key="published-apps"
        id={appsGroupId}
        aria-label={t("nav.publishedApps")}
        data-testid="rail-apps"
      >
        {appRows.map((app) => (
          <NavItem
            key={app.name}
            // The mark starts where the label of the Apps row starts.
            className="pl-8"
            icon={<Avatar kind="app" size="xs" name={app.title} />}
            selected={app.name === openAppName}
            // The name is cut at the rail's edge; the whole name shows on the pointer.
            title={app.title}
            onClick={() => onOpenApp?.(app.name)}
          >
            {app.title}
          </NavItem>
        ))}
        {morePublishedApps || publishedApps.length > RAIL_APPS_LIMIT ? (
          <NavItem
            // The words start where the names of the Apps start.
            className="pl-15 text-muted-foreground"
            data-testid="rail-apps-all"
            onClick={() => onViewChange("apps")}
          >
            {t("nav.allApps")}
          </NavItem>
        ) : null}
      </NavGroup>
    ];
  });

  // New chat and the sections are one group of rows, in the strip as in the open rail: the
  // wider space stands only before "Recent".
  if (iconsOnly) {
    return (
      <NavGroup>
        <div className="grid h-(--layout-header) place-items-center">{collapse}</div>
        {search}
        {newChat}
        {sectionRows}
      </NavGroup>
    );
  }
  return (
    <>
      <div className="flex h-(--layout-header) min-w-0 items-center gap-1">
        <div className="min-w-0 flex-1">
          {collaborationWorkspaceSelector ?? <RailBranding config={config} />}
        </div>
        {search}
        {collapse}
      </div>
      <NavGroup>
        {newChat}
        {sectionRows}
      </NavGroup>
    </>
  );
}

/** The client's identity where an embedded session has no workspace to select. */
function RailBranding({ config }: { config: SafeConfig }) {
  const branding = clientBrandingFrom(config);
  return (
    <div className="flex h-control-md min-w-0 items-center gap-2 px-2">
      {branding.logoUrl ? (
        <ClientBrandingLogo
          branding={branding}
          className="max-h-6 max-w-full min-w-0 object-contain object-left"
        />
      ) : (
        <>
          <Avatar kind="workspace" size="sm" name={branding.clientLabel} />
          <span className="min-w-0 truncate text-label">{branding.clientLabel}</span>
        </>
      )}
    </div>
  );
}

/**
 * The projects of the open workspace used last, above "Recent", and a row to all of them
 * (PRJ-5). A private project carries the lock a private conversation carries. Nothing shows
 * while the workspace has no project the person sees, or in the collapsed strip.
 */
function RecentProjects({
  recentProjects = [],
  openProjectName,
  onOpenProject,
  onCreateProject,
  onViewChange
}: WorkspaceRailProps) {
  const { t } = useTranslation();
  if (useSidebarCollapsed() || recentProjects.length === 0) {
    return null;
  }
  return (
    <NavGroup
      label={t("projects.title")}
      data-testid="rail-projects"
      labelAction={
        onCreateProject ? (
          <IconButton size="sm" label={t("projects.railNew")} onClick={onCreateProject}>
            <Plus aria-hidden="true" />
          </IconButton>
        ) : undefined
      }
    >
      {recentProjects.slice(0, RAIL_PROJECTS_LIMIT).map((project) => (
        <NavItem
          key={project.id}
          icon={<Folder aria-hidden="true" />}
          selected={project.name === openProjectName}
          // The name is cut at the rail's edge; the whole name shows on the pointer.
          title={project.title}
          data-testid="rail-project"
          onClick={() => onOpenProject?.(project.name)}
        >
          <span className="flex min-w-0 items-center gap-1">
            <span className="min-w-0 truncate">{project.title}</span>
            {project.audience === "private" ? (
              <span
                className="shrink-0 text-muted-foreground"
                data-testid="rail-project-private"
                role="img"
                aria-label={t("projects.audiencePrivate")}
                title={t("projects.audiencePrivate")}
              >
                <Lock className="size-3" aria-hidden="true" />
              </span>
            ) : null}
          </span>
        </NavItem>
      ))}
      <NavItem
        // The words start where the names of the projects start.
        className="pl-8 text-muted-foreground"
        data-testid="rail-projects-all"
        onClick={() => onViewChange("projects")}
      >
        {t("projects.railAll")}
      </NavItem>
    </NavGroup>
  );
}

function RecentConversations({
  config,
  conversations,
  openConversation,
  hasMoreConversations = false,
  loadingMoreConversations = false,
  loadMoreConversationsFailed = false,
  conversationsStatus,
  selectedConversationId,
  deletingConversation,
  canMoveConversation,
  onLoadMoreConversations,
  onCreateConversation,
  onSelectConversation,
  onReloadConversations,
  onRenameConversation,
  onMoveConversation,
  onDeleteConversation,
  projectActions
}: WorkspaceRailProps) {
  const { t } = useTranslation();
  // The collapsed strip hides the list with its label.
  if (useSidebarCollapsed()) {
    return null;
  }

  const recent = recentConversations(conversations, openConversation);

  return (
    <NavGroup
      label={t("nav.recent")}
      // The same start as the "New chat" row, where the pointer is when a person reads the list.
      labelAction={
        <IconButton size="sm" label={t("nav.newChat")} onClick={onCreateConversation}>
          <Plus aria-hidden="true" />
        </IconButton>
      }
    >
      {recent.length > 0 ? (
        recent.map((conversation) => (
          <ConversationButton
            key={conversation.id}
            conversation={conversation}
            selected={conversation.id === selectedConversationId}
            retention={config.retention}
            onSelect={() => onSelectConversation(conversation.id)}
            onRename={(title) => onRenameConversation(conversation.id, title)}
            onMove={
              canMoveConversation
                ? () => onMoveConversation(conversation.id, conversation.title)
                : undefined
            }
            onMoveToProject={
              projectActions?.canMoveIn(conversation)
                ? () => projectActions.moveIn(conversation)
                : undefined
            }
            onRemoveFromProject={
              projectActions && conversation.projectId
                ? () => projectActions.remove(conversation)
                : undefined
            }
            onDelete={() => onDeleteConversation(conversation.id)}
            deleting={deletingConversation}
          />
        ))
      ) : conversationsStatus === "loading" ? (
        <RecentSkeleton />
      ) : conversationsStatus === "failed" ? (
        <EmptyState
          layout="inline"
          className="px-2 py-1.5"
          role="alert"
          action={
            <Button variant="link" size="sm" className="px-0" onClick={onReloadConversations}>
              {t("tryAgain")}
            </Button>
          }
        >
          {t("nav.recentLoadFailed")}
        </EmptyState>
      ) : (
        <EmptyState layout="inline" className="px-2 py-1.5">
          {t("noConversations")}
        </EmptyState>
      )}
      {hasMoreConversations && onLoadMoreConversations ? (
        <OlderConversations
          loading={loadingMoreConversations}
          failed={loadMoreConversationsFailed}
          onLoad={onLoadMoreConversations}
        />
      ) : null}
    </NavGroup>
  );
}

/**
 * The conversations the rail lists: the loaded ones, and before them the open conversation
 * when it is older than those, so the row a person is in is always there to be the current one.
 */
export function recentConversations(
  conversations: readonly ConversationListItem[],
  openConversation: ConversationListItem | undefined
): readonly ConversationListItem[] {
  return openConversation && !conversations.some(({ id }) => id === openConversation.id)
    ? [openConversation, ...conversations]
    : conversations;
}

/**
 * The end of the loaded conversations while the workspace holds older ones. The row loads the
 * next page when it scrolls into view, and on a click or a key for a person who does not
 * scroll. A failed load stays in view and is tried again only on request.
 */
function OlderConversations({
  loading,
  failed,
  onLoad
}: {
  loading: boolean;
  failed: boolean;
  onLoad: () => void;
}) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const row = rowRef.current;
    if (!row || loading || failed) {
      return undefined;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onLoad();
      }
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, [failed, loading, onLoad]);

  return (
    <div ref={rowRef} data-testid="conversations-older">
      {failed ? (
        <EmptyState
          layout="inline"
          className="px-2 py-1.5"
          role="alert"
          action={
            <Button variant="link" size="sm" className="px-0" onClick={onLoad}>
              {t("tryAgain")}
            </Button>
          }
        >
          {t("nav.loadMoreFailed")}
        </EmptyState>
      ) : (
        <NavItem
          className="text-muted-foreground"
          disabled={loading}
          aria-busy={loading}
          onClick={onLoad}
        >
          {t(loading ? "nav.loadingMore" : "nav.loadMore")}
        </NavItem>
      )}
    </div>
  );
}

const SKELETON_ROW_WIDTHS = ["w-3/4", "w-1/2", "w-2/3"];

function RecentSkeleton() {
  return (
    <div data-testid="conversations-loading" aria-busy="true">
      {SKELETON_ROW_WIDTHS.map((width) => (
        <div key={width} className="flex h-8 items-center px-2">
          <Skeleton className={width} />
        </div>
      ))}
    </div>
  );
}

function RailFooter({
  canViewAdministration,
  canViewBuild = false,
  view,
  accountMenu,
  onViewChange
}: WorkspaceRailProps) {
  const { t } = useTranslation();
  const iconsOnly = useSidebarCollapsed();
  const activeClassName = "bg-state-selected text-foreground hover:bg-state-selected";
  const settingsButton = canViewAdministration ? (
    <IconButton
      className={view === "settings" ? activeClassName : undefined}
      label={view === "settings" ? t("returnToChat") : t("nav.settings")}
      aria-pressed={view === "settings"}
      onClick={() => onViewChange(view === "settings" ? "chat" : "settings")}
    >
      <Settings aria-hidden="true" />
    </IconButton>
  ) : null;

  const buildRow = canViewBuild ? (
    <NavItem
      icon={<Blocks aria-hidden="true" />}
      selected={view === "build"}
      onClick={() => onViewChange("build")}
    >
      {t("nav.build")}
    </NavItem>
  ) : null;

  if (iconsOnly) {
    return (
      <div className="grid justify-items-center gap-0.5">
        {buildRow}
        {settingsButton}
        {accountMenu}
      </div>
    );
  }
  return (
    <>
      {buildRow ? <div className="pb-2">{buildRow}</div> : null}
      <div className="flex min-w-0 items-center gap-1">
        {accountMenu}
        {settingsButton}
      </div>
    </>
  );
}
