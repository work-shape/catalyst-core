import { PanelLeft, Plus, Shield } from "lucide-react";
import type { ReactNode } from "react";
import type { Conversation, SafeConfig } from "@agent-chat-platform/api-client";
import { ConversationButton } from "./conversation-button";
import { useTranslation } from "./i18n";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

export type WorkspaceView = "chat" | "settings" | "superadmin";

export function WorkspaceRail({
  config,
  conversations,
  selectedConversationId,
  isSuperadmin,
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
  config: SafeConfig | undefined;
  conversations: Conversation[];
  selectedConversationId: string | undefined;
  isSuperadmin: boolean;
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
  const clientLabel = config?.ui.clientName ?? config?.ui.title ?? "Agent Chat";
  const logoUrl = config?.ui.logoUrl;
  const logoUrlDark = config?.ui.logoUrlDark;
  const invertLogoOnDark = Boolean(config?.ui.logoInvertOnDark && !logoUrlDark);
  const superadminButton = isSuperadmin ? (
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
      className="grid h-full min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)_auto] gap-4 overflow-hidden border-r bg-sidebar p-4 text-sidebar-foreground"
      aria-label={t("conversations")}
    >
      {logoUrl ? (
        <div className="grid min-w-0 gap-2">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
            <div
              className={cn(
                "flex h-10 min-w-0 max-w-[12rem] items-center justify-center overflow-hidden rounded-md border px-3 text-primary shadow-xs",
                logoUrlDark || invertLogoOnDark ? "bg-card dark:bg-transparent" : "bg-white"
              )}
            >
              <img
                className={cn(
                  "max-h-7 w-full object-contain",
                  logoUrlDark && "dark:hidden",
                  invertLogoOnDark && "dark:invert"
                )}
                src={logoUrl}
                alt=""
              />
              {logoUrlDark ? (
                <img
                  className="hidden max-h-7 w-full object-contain dark:block"
                  src={logoUrlDark}
                  alt=""
                />
              ) : null}
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("closeSidebar")}
              title={t("closeSidebar")}
              aria-pressed="true"
              onClick={onToggleSidebar}
            >
              <PanelLeft size={17} aria-hidden="true" />
            </Button>
          </div>
          <div className="grid min-w-0 gap-0.5">
            <strong className="truncate text-sm">{clientLabel}</strong>
            <span className="truncate text-xs text-muted-foreground">{t("conversations")}</span>
          </div>
        </div>
      ) : (
        <div className="grid min-w-0 grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-2.5">
          <div className="grid size-9 place-items-center overflow-hidden rounded-md border bg-card text-primary shadow-xs">
            <Shield size={18} aria-hidden="true" />
          </div>
          <div className="grid min-w-0 gap-0.5">
            <strong className="truncate text-sm">{clientLabel}</strong>
            <span className="truncate text-xs text-muted-foreground">{t("conversations")}</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t("closeSidebar")}
            title={t("closeSidebar")}
            aria-pressed="true"
            onClick={onToggleSidebar}
          >
            <PanelLeft size={17} aria-hidden="true" />
          </Button>
        </div>
      )}

      <Button
        className="h-10 w-full justify-center shadow-xs"
        type="button"
        onClick={onCreateConversation}
        disabled={creatingConversation}
      >
        <Plus size={17} aria-hidden="true" />
        <span>{t("newConversation")}</span>
      </Button>

      <nav className="grid min-h-0 content-start gap-2 overflow-auto pr-1">
        {conversations.length === 0 ? (
          <div className="rounded-md border border-dashed bg-sidebar-accent/40 px-3 py-4 text-sm text-muted-foreground">
            {t("noConversations")}
          </div>
        ) : (
          conversations.map((conversation) => (
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

      <footer className="-mx-4 flex min-w-0 items-center justify-between gap-2 border-t border-sidebar-border px-4 pt-3">
        {userMenu}
        {superadminButton}
      </footer>
    </aside>
  );
}
