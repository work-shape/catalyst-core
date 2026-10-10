import { Blocks, MessagesSquare, PanelLeft, Search, Settings, SquarePen } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationListItem, SafeConfig } from "@vivd-catalyst/api-client";
import {
  Avatar,
  Button,
  EmptyState,
  IconButton,
  NavGroup,
  NavItem,
  Sidebar,
  Skeleton,
  useSidebarCollapsed
} from "@vivd-catalyst/ui";
import { ConversationButton } from "../conversation/conversation-button";
import { useTranslation } from "../i18n";
import { ClientBrandingLogo, clientBrandingFrom } from "./client-branding";
import {
  railSections,
  shownRailSections,
  type RailSection,
  type RailSectionsGiven
} from "./rail-sections";
import type { WorkspaceRouteView } from "./workspace-route";
import { workspaceShortcutLabel } from "./workspace-shortcuts";

export type WorkspaceView = WorkspaceRouteView;

/**
 * How many conversations the rail lists under "Recent". The rest are one row away, on the list
 * of every conversation, so the rail stays a short list and not a second place to scroll.
 */
export const RAIL_RECENT_LIMIT = 30;
export { railSections, shownRailSections, type RailSection };

interface WorkspaceRailProps {
  config: SafeConfig;
  /** Absent for embedded token sessions, which show the client's branding in its place. */
  collaborationWorkspaceSelector?: ReactNode;
  /** The section rows. */
  sections?: readonly RailSection[];
  conversations: ConversationListItem[];
  conversationsStatus: "loading" | "failed" | "ready";
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
  /** The viewer may open Build: the rail shows its row above the account row. */
  canViewBuild?: boolean;
  /** Present for a person who may decide requests or has made one: the Inbox row shows. */
  inbox?: RailSectionsGiven["inbox"];
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
  /** Opens the list of every conversation of the workspace. */
  onShowAllConversations: () => void;
  onSelectConversation: (conversationId: string) => void;
  onReloadConversations: () => void;
  onRenameConversation: (conversationId: string, title: string) => Promise<void>;
  onMoveConversation: (conversationId: string, title: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}

/**
 * The frame's navigation: the workspace selector with search and collapse, New chat, the
 * section rows, the latest conversations under "Recent" with the way to all of them, and a
 * footer with the account menu and the settings. Collapsed it is a strip of icons; under
 * 768 px it is a drawer.
 */
export function WorkspaceRail(props: WorkspaceRailProps) {
  const { t } = useTranslation();
  const sections = shownRailSections(props.sections ?? railSections, { inbox: props.inbox });

  return (
    <Sidebar
      label={t("nav.label")}
      collapsed={props.collapsed}
      drawerOpen={props.drawerOpen}
      onDrawerClose={props.onDrawerClose}
      header={<RailHeader {...props} sections={sections} />}
      footer={<RailFooter {...props} />}
    >
      <RecentConversations {...props} />
    </Sidebar>
  );
}

function RailHeader({
  config,
  collaborationWorkspaceSelector,
  sections,
  inbox,
  view,
  collapsed,
  onToggleCollapsed,
  onOpenSearch,
  onViewChange,
  onCreateConversation,
  onShowAllConversations
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
  // The strip hides the list under "Recent", so it carries the way to the conversations itself.
  const allConversations = (
    <NavItem
      icon={<MessagesSquare aria-hidden="true" />}
      selected={view === "conversations"}
      onClick={onShowAllConversations}
    >
      {t("nav.conversations")}
    </NavItem>
  );
  const sectionRows =
    sections.length === 0 ? null : (
      <NavGroup className={iconsOnly ? undefined : "mt-4"}>
        {sections.map((section) => {
          const count = section.count?.({ inbox }) ?? 0;
          return (
            <NavItem
              key={section.id}
              icon={<section.icon aria-hidden="true" />}
              selected={view === section.view}
              count={count > 0 ? count : undefined}
              aria-label={
                count > 0 && section.countLabel ? t(section.countLabel, { count }) : undefined
              }
              onClick={() => onViewChange(section.view)}
            >
              {t(section.label)}
            </NavItem>
          );
        })}
      </NavGroup>
    );

  if (iconsOnly) {
    return (
      <div className="grid justify-items-center gap-0.5">
        <div className="grid h-(--layout-header) place-items-center">{collapse}</div>
        {search}
        {newChat}
        {allConversations}
        {sectionRows}
      </div>
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
      {newChat}
      {sectionRows}
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

function RecentConversations({
  config,
  conversations,
  conversationsStatus,
  selectedConversationId,
  view,
  deletingConversation,
  canMoveConversation,
  onShowAllConversations,
  onSelectConversation,
  onReloadConversations,
  onRenameConversation,
  onMoveConversation,
  onDeleteConversation
}: WorkspaceRailProps) {
  const { t } = useTranslation();
  // The collapsed strip hides the list with its label.
  if (useSidebarCollapsed()) {
    return null;
  }

  const recent = recentConversations(conversations, selectedConversationId);

  return (
    <NavGroup label={t("nav.recent")}>
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
      {conversations.length > RAIL_RECENT_LIMIT ? (
        <NavItem
          className={view === "conversations" ? undefined : "text-muted-foreground"}
          selected={view === "conversations"}
          onClick={onShowAllConversations}
        >
          {t("nav.showAll")}
        </NavItem>
      ) : null}
    </NavGroup>
  );
}

/**
 * The conversations the rail lists: the latest ones, and after them the open conversation when
 * it is an older one, so the row a person is in is always there to be the current one.
 */
export function recentConversations(
  conversations: readonly ConversationListItem[],
  selectedConversationId: string | undefined
): readonly ConversationListItem[] {
  const latest = conversations.slice(0, RAIL_RECENT_LIMIT);
  const open = conversations
    .slice(RAIL_RECENT_LIMIT)
    .find((conversation) => conversation.id === selectedConversationId);
  return open ? [...latest, open] : latest;
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
