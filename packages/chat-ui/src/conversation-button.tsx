import { MessageSquare, Trash2 } from "lucide-react";
import type { Conversation } from "@agent-chat-platform/api-client";
import { useTranslation } from "./i18n";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";

export function ConversationButton({
  conversation,
  selected,
  onSelect,
  onDelete,
  deleting
}: {
  conversation: Conversation;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { locale, t } = useTranslation();

  return (
    <div
      data-testid="conversation-row"
      className={cn(
        "group/conversation grid min-w-0 grid-cols-[minmax(0,1fr)_2.25rem] items-center rounded-md border border-transparent transition-colors",
        "hover:border-sidebar-border hover:bg-sidebar-accent/70",
        selected && "border-primary/40 bg-sidebar-accent shadow-xs"
      )}
    >
      <Button
        className="h-auto min-w-0 justify-start gap-2 px-2 py-2 text-left text-foreground hover:bg-transparent"
        type="button"
        variant="ghost"
        onClick={onSelect}
      >
        <MessageSquare size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="grid min-w-0 gap-0.5">
          <span className="truncate text-sm font-medium">{conversation.title}</span>
          <span className="truncate text-xs text-muted-foreground">
            {formatConversationDate(conversation.updatedAt, locale, t("updatedRecently"))}
          </span>
        </span>
      </Button>
      <Button
        className="size-8 text-muted-foreground opacity-100 hover:bg-destructive/10 hover:text-destructive md:opacity-0 md:transition-opacity md:group-hover/conversation:opacity-100 md:group-focus-within/conversation:opacity-100"
        type="button"
        variant="ghost"
        size="icon"
        onClick={onDelete}
        disabled={deleting}
        aria-label={t("deleteConversation", { title: conversation.title })}
      >
        <Trash2 size={15} aria-hidden="true" />
      </Button>
    </div>
  );
}

function formatConversationDate(value: string, locale: string, fallback: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}
