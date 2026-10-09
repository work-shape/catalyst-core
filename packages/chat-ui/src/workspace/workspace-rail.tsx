import { ChevronLeft, ClipboardCheck, PanelLeft, Plus, Search, Shield } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ConversationListItem, SafeConfig } from "@vivd-catalyst/api-client";
import { Button, cn, CountBadge } from "@vivd-catalyst/ui";
import { ConversationButton } from "../conversation/conversation-button";
import { useTranslation } from "../i18n";
import { ClientBrandingLogo, clientBrandingFrom } from "./client-branding";
import type { WorkspaceRouteView } from "./workspace-route";

export type WorkspaceView = WorkspaceRouteView;

export function WorkspaceRail({
  config,
  collaborationWorkspaceSelector,
  conversations,
  selectedConversationId,
  canViewAdministration,
  approvals,
  view,
  creatingConversation,
  deletingConversation,
  canMoveConversation,
  userMenu,
  onToggleSidebar,
  onViewChange,
  onCreateConversation,
  onSelectConversation,
  onRenameConversation,
  onMoveConversation,
  onDeleteConversation
}: {
  config: SafeConfig;
  /** Absent for embedded token sessions, which have no workspace UI at all. */
  collaborationWorkspaceSelector?: ReactNode;
  conversations: ConversationListItem[];
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
  /** Present only for users who may review Approval Requests. */
  approvals?: { pendingCount: number };
  view: WorkspaceView;
  creatingConversation: boolean;
  deletingConversation: boolean;
  canMoveConversation: boolean;
  userMenu: ReactNode;
  onToggleSidebar: () => void;
  onViewChange: (view: WorkspaceView) => void;
  onCreateConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => Promise<void>;
  onMoveConversation: (conversationId: string, title: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}) {
  const { t } = useTranslation();
  const [conversationQuery, setConversationQuery] = useState("");
  const branding = clientBrandingFrom(config);
  const filteredConversations = useMemo(() => {
    const query = conversationQuery.trim().toLocaleLowerCase();
    if (!query) {
      return conversations;
    }
    return conversations.filter((conversation) =>
      conversation.title.toLocaleLowerCase().includes(query)
    );
  }, [conversationQuery, conversations]);
  const administrationButton = canViewAdministration ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={view === "superadmin" ? "bg-sidebar-accent text-primary" : "text-muted-foreground"}
      aria-label={view === "superadmin" ? t("returnToChat") : t("openSuperadminPanel")}
      title={view === "superadmin" ? t("returnToChat") : t("openSuperadminPanel")}
      onClick={() => onViewChange(view === "superadmin" ? "chat" : "superadmin")}
    >
      <Shield size={16} aria-hidden="true" />
    </Button>
  ) : null;
  const approvalsLabel =
    view === "approvals"
      ? t("returnToChat")
      : approvals && approvals.pendingCount > 0
        ? t("openApprovalsPending", { count: approvals.pendingCount })
        : t("openApprovals");
  const approvalsButton = approvals ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "relative",
        view === "approvals" ? "bg-sidebar-accent text-primary" : "text-muted-foreground"
      )}
      aria-label={approvalsLabel}
      title={approvalsLabel}
      onClick={() => onViewChange(view === "approvals" ? "chat" : "approvals")}
    >
      <ClipboardCheck size={16} aria-hidden="true" />
      {approvals.pendingCount > 0 ? (
        <CountBadge
          count={approvals.pendingCount}
          className="absolute -top-0.5 -right-0.5"
          aria-hidden="true"
        />
      ) : null}
    </Button>
  ) : null;
  const closeSidebarButton = (className: string) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn("size-9 text-muted-foreground hover:text-sidebar-foreground", className)}
      aria-label={t("closeSidebar")}
      title={t("closeSidebar")}
      aria-pressed="true"
      onClick={onToggleSidebar}
    >
      <PanelLeft size={17} aria-hidden="true" />
    </Button>
  );

  return (
    <aside
      className="relative grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] border-r border-sidebar-border bg-sidebar px-5 pb-4 pt-5 text-sidebar-foreground"
      aria-label={t("conversations")}
    >
      {collaborationWorkspaceSelector ? null : closeSidebarButton("absolute right-4 top-4 z-20")}

      {/*
        The collapse handle sits on the rail's right border, where it would cover the
        list's scrollbar. It shows only while the pointer is on the border: this narrow
        zone straddles it, and the list's scrollbar ends to the left of the zone.
      */}
      <div className="group/rail-edge absolute inset-y-0 -right-1.5 z-20 hidden w-3 md:block">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="pointer-events-none absolute left-1/2 top-1/2 h-11 w-6 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-sidebar-border/60 bg-sidebar/95 text-muted-foreground/70 opacity-0 shadow-none transition-opacity hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover/rail-edge:pointer-events-auto group-hover/rail-edge:opacity-100"
          aria-label={t("collapseSidebar")}
          title={t("collapseSidebar")}
          onClick={onToggleSidebar}
        >
          <ChevronLeft size={12} strokeWidth={1.75} aria-hidden="true" />
        </Button>
      </div>

      {/*
        With workspace chrome visible the selector is the rail's top element and
        carries the collapse toggle; the client branding moves into its popover.
        Without the chrome — feature off or embedded — the branding row stays
        exactly as it was.
      */}
      {collaborationWorkspaceSelector ? (
        <div className="min-w-0 border-b border-sidebar-border pb-3">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1">
            <div className="-ml-2 min-w-0">{collaborationWorkspaceSelector}</div>
            {closeSidebarButton("shrink-0")}
          </div>
        </div>
      ) : branding.logoUrl ? (
        <div className="flex h-16 min-w-0 items-start border-b border-sidebar-border pb-3 pr-11">
          <button
            type="button"
            className="flex h-12 min-w-0 max-w-[11rem] cursor-pointer items-center justify-start overflow-hidden rounded-sm border-0 bg-transparent p-0 text-primary outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/30"
            aria-label={branding.clientLabel}
            onClick={onCreateConversation}
          >
            <ClientBrandingLogo
              branding={branding}
              className="max-h-11 w-full object-contain object-left"
            />
          </button>
        </div>
      ) : (
        <div className="grid h-16 min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-2.5 border-b border-sidebar-border pb-3 pr-11">
          <div className="grid size-9 place-items-center overflow-hidden rounded-md border border-sidebar-border bg-sidebar-accent/50 text-primary">
            <span className="text-sm font-semibold" aria-hidden="true">
              {branding.clientInitial}
            </span>
          </div>
          <div className="grid min-w-0 gap-1 pt-0.5">
            <strong className="truncate text-sm font-semibold">{branding.clientLabel}</strong>
            <span className="truncate text-xs text-muted-foreground">{t("workspace")}</span>
          </div>
        </div>
      )}

      <div className="grid gap-3 pb-3 pt-4">
        <div className="flex min-w-0 items-center justify-between gap-2">
          <span className="truncate text-[0.6875rem] font-semibold uppercase tracking-[0.13em] text-muted-foreground">
            {t("conversations")}
          </span>
          <Button
            className="size-8 text-muted-foreground hover:text-foreground"
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("newConversation")}
            title={t("newConversation")}
            onClick={onCreateConversation}
            disabled={creatingConversation}
          >
            <Plus size={17} aria-hidden="true" />
          </Button>
        </div>
        <label className="relative block min-w-0">
          <Search
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={conversationQuery}
            className="h-10 w-full min-w-0 rounded-md border border-sidebar-border bg-transparent pl-9 pr-3 text-sm text-sidebar-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-sidebar-ring focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/30"
            placeholder={t("searchConversations")}
            aria-label={t("searchConversations")}
            onChange={(event) => setConversationQuery(event.currentTarget.value)}
          />
        </label>
      </div>

      <nav className="chat-scrollbar -ml-1 -mr-3 grid min-h-0 auto-rows-max content-start gap-0.5 overflow-y-auto overflow-x-hidden pl-1 pr-3 pb-3">
        {conversations.length === 0 ? (
          <div className="rounded-md border border-dashed border-sidebar-border px-3 py-4 text-sm text-muted-foreground">
            {t("noConversations")}
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {t("noConversationMatches")}
          </div>
        ) : (
          filteredConversations.map((conversation) => (
            <ConversationButton
              key={conversation.id}
              conversation={conversation}
              selected={conversation.id === selectedConversationId}
              expires={config.retention?.expireConversations === true}
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
        )}
      </nav>

      <footer className="-mx-5 flex min-w-0 items-center justify-between gap-2 border-t border-sidebar-border px-5 pt-4">
        {userMenu}
        {approvalsButton || administrationButton ? (
          <div className="flex shrink-0 items-center gap-1">
            {approvalsButton}
            {administrationButton}
          </div>
        ) : null}
      </footer>
    </aside>
  );
}
