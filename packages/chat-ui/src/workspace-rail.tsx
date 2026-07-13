import { ChevronLeft, PanelLeft, Plus, Search, Shield } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import type { ConversationListItem, SafeConfig } from "@vivd-catalyst/api-client";
import { ConversationButton } from "./conversation-button";
import { useTranslation } from "./i18n";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

export type WorkspaceView = "chat" | "settings" | "superadmin";

export function WorkspaceRail({
  config,
  conversations,
  selectedConversationId,
  canViewAdministration,
  view,
  creatingConversation,
  deletingConversation,
  userMenu,
  onToggleSidebar,
  onViewChange,
  onCreateConversation,
  onSelectConversation,
  onDeleteConversation
}: {
  config: SafeConfig;
  conversations: ConversationListItem[];
  selectedConversationId: string | undefined;
  canViewAdministration: boolean;
  view: WorkspaceView;
  creatingConversation: boolean;
  deletingConversation: boolean;
  userMenu: ReactNode;
  onToggleSidebar: () => void;
  onViewChange: (view: WorkspaceView) => void;
  onCreateConversation: () => void;
  onSelectConversation: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
}) {
  const { t } = useTranslation();
  const [conversationQuery, setConversationQuery] = useState("");
  const clientLabel = config.ui.clientName ?? config.ui.title;
  const clientInitial = clientLabel.trim().charAt(0).toLocaleUpperCase();
  const logoUrl = config.ui.logoUrl;
  const logoUrlDark = config.ui.logoUrlDark;
  const invertLogoOnDark = Boolean(config.ui.logoInvertOnDark && !logoUrlDark);
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

  return (
    <aside
      className="relative grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] border-r border-sidebar-border bg-sidebar px-5 pb-4 pt-5 text-sidebar-foreground"
      aria-label={t("conversations")}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-4 top-4 z-20 size-9 text-muted-foreground hover:text-sidebar-foreground"
        aria-label={t("closeSidebar")}
        title={t("closeSidebar")}
        aria-pressed="true"
        onClick={onToggleSidebar}
      >
        <PanelLeft size={17} aria-hidden="true" />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute -right-3 top-1/2 z-20 hidden h-11 w-6 -translate-y-1/2 rounded-xl border border-sidebar-border/60 bg-sidebar/95 text-muted-foreground/70 shadow-none hover:bg-sidebar-accent hover:text-sidebar-foreground md:inline-flex"
        aria-label={t("collapseSidebar")}
        title={t("collapseSidebar")}
        onClick={onToggleSidebar}
      >
        <ChevronLeft size={12} strokeWidth={1.75} aria-hidden="true" />
      </Button>

      {logoUrl ? (
        <div className="flex h-16 min-w-0 items-start border-b border-sidebar-border pb-3 pr-11">
          <button
            type="button"
            className="flex h-12 min-w-0 max-w-[11rem] cursor-pointer items-center justify-start overflow-hidden rounded-sm border-0 bg-transparent p-0 text-primary outline-none focus-visible:ring-[3px] focus-visible:ring-sidebar-ring/30"
            aria-label={clientLabel}
            onClick={onCreateConversation}
          >
            <img
              className={cn(
                "max-h-11 w-full object-contain object-left",
                logoUrlDark && "dark:hidden",
                invertLogoOnDark && "dark:invert"
              )}
              src={logoUrl}
              alt={clientLabel}
            />
            {logoUrlDark ? (
              <img
                className="hidden max-h-11 w-full object-contain object-left dark:block"
                src={logoUrlDark}
                alt={clientLabel}
              />
            ) : null}
          </button>
        </div>
      ) : (
        <div className="grid h-16 min-w-0 grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-2.5 border-b border-sidebar-border pb-3 pr-11">
          <div className="grid size-9 place-items-center overflow-hidden rounded-md border border-sidebar-border bg-sidebar-accent/50 text-primary">
            <span className="text-sm font-semibold" aria-hidden="true">
              {clientInitial}
            </span>
          </div>
          <div className="grid min-w-0 gap-1 pt-0.5">
            <strong className="truncate text-sm font-semibold">{clientLabel}</strong>
            <span className="truncate text-xs text-muted-foreground">{t("workspace")}</span>
          </div>
        </div>
      )}

      <div className="grid gap-3 pb-3 pt-6">
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

      <nav className="chat-scrollbar -mx-1 grid min-h-0 auto-rows-max content-start gap-1 overflow-y-auto overflow-x-hidden px-1 pb-3">
        {conversations.length === 0 ? (
          <div className="rounded-md border border-dashed border-sidebar-border px-3 py-4 text-sm text-muted-foreground">
            {t("noConversations")}
          </div>
        ) : filteredConversations.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">{t("noConversationMatches")}</div>
        ) : (
          filteredConversations.map((conversation) => (
            <ConversationButton
              key={conversation.id}
              conversation={conversation}
              selected={conversation.id === selectedConversationId}
              onSelect={() => onSelectConversation(conversation.id)}
              onDelete={() => onDeleteConversation(conversation.id)}
              deleting={deletingConversation}
            />
          ))
        )}
      </nav>

      <footer className="-mx-5 flex min-w-0 items-center justify-between gap-2 border-t border-sidebar-border px-5 pt-4">
        {userMenu}
        {administrationButton}
      </footer>
    </aside>
  );
}
