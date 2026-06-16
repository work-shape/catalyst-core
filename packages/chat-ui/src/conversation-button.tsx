import { useEffect, useRef, useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import type { Conversation } from "@vivd-catalyst/api-client";
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
          <AnimatedConversationTitle title={conversation.title} />
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

function AnimatedConversationTitle({ title }: { title: string }) {
  const { text, typing } = useTypewriterTitle(title);

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline text-sm font-medium" title={title} aria-label={title}>
      <span className="truncate" aria-hidden="true">
        {text}
      </span>
      {typing ? <span className="ml-0.5 h-3 w-px shrink-0 animate-pulse bg-current" aria-hidden="true" /> : null}
    </span>
  );
}

function useTypewriterTitle(title: string): { text: string; typing: boolean } {
  const previousTitleRef = useRef(title);
  const [state, setState] = useState({ text: title, typing: false });

  useEffect(() => {
    if (previousTitleRef.current === title) {
      return undefined;
    }
    previousTitleRef.current = title;

    if (prefersReducedMotion() || title.length === 0) {
      setState({ text: title, typing: false });
      return undefined;
    }

    let index = 0;
    let timeout: number | undefined;
    setState({ text: "", typing: true });

    function tick() {
      index += 1;
      setState({
        text: title.slice(0, index),
        typing: index < title.length
      });
      if (index < title.length) {
        timeout = window.setTimeout(tick, 24);
      }
    }

    timeout = window.setTimeout(tick, 24);
    return () => {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
    };
  }, [title]);

  return state;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
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
