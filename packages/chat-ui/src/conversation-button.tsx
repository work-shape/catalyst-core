import { useEffect, useRef, useState } from "react";
import { ThreadListItemMorePrimitive } from "@assistant-ui/react";
import { MessageSquare, MoreHorizontal, Trash2 } from "lucide-react";
import type { ConversationListItem } from "@vivd-catalyst/api-client";
import { useTranslation } from "./i18n";
import { Button } from "./ui/button";
import { cn } from "./ui/cn";
import { Dialog } from "./ui/dialog";
import { Spinner } from "./ui/spinner";

export function ConversationButton({
  conversation,
  selected,
  onSelect,
  onDelete,
  deleting
}: {
  conversation: ConversationListItem;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { locale, t } = useTranslation();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const running = Boolean(conversation.activeRun);
  const unread = Boolean(conversation.unread && !selected);

  return (
    <>
      <div
        data-testid="conversation-row"
        className={cn(
          "group/conversation relative grid min-w-0 grid-cols-[minmax(0,1fr)_2.25rem] items-center overflow-hidden rounded-md border border-transparent transition-colors",
          "hover:bg-sidebar-accent/55",
          selected && "bg-sidebar-accent/80"
        )}
      >
        {selected ? (
          <span className="absolute inset-y-2 left-0 w-0.5 rounded-r-full bg-primary" aria-hidden="true" />
        ) : null}
        <Button
          className="h-auto min-w-0 justify-start gap-2.5 px-3 py-3 text-left text-foreground hover:bg-transparent"
          type="button"
          variant="ghost"
          onClick={onSelect}
        >
          {running ? (
            <Spinner
              size="sm"
              className="mt-0.5 text-primary"
              data-testid="conversation-running-icon"
            />
          ) : (
            <MessageSquare
              size={16}
              className={cn(
                "mt-0.5 shrink-0 text-muted-foreground",
                unread && "text-primary"
              )}
              aria-hidden="true"
            />
          )}
          <span className="grid min-w-0 gap-0.5">
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <AnimatedConversationTitle title={conversation.title} />
              {unread ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                  data-testid="conversation-unread-indicator"
                  aria-label={t("conversationUnread")}
                  title={t("conversationUnread")}
                />
              ) : null}
            </span>
            <span className="truncate text-[0.8125rem] text-muted-foreground">
              {running ? (
                <span className="inline-flex min-w-0 items-center gap-1 text-primary" data-testid="conversation-running-indicator">
                  {t("conversationRunning")}
                </span>
              ) : unread ? (
                <span className="text-primary" data-testid="conversation-unread-label">
                  {t("conversationUnread")}
                </span>
              ) : (
                formatConversationDate(conversation.updatedAt, locale, t("updatedRecently"))
              )}
            </span>
          </span>
        </Button>

        <ThreadListItemMorePrimitive.Root>
          <ThreadListItemMorePrimitive.Trigger
            className={cn(
              "inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors",
              "hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40",
              "opacity-100 md:opacity-0 md:group-hover/conversation:opacity-100 md:group-focus-within/conversation:opacity-100",
              "data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[state=open]:opacity-100"
            )}
            type="button"
            disabled={deleting}
            aria-label={t("conversationOptions", { title: conversation.title })}
            title={t("conversationOptions", { title: conversation.title })}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </ThreadListItemMorePrimitive.Trigger>
          <ThreadListItemMorePrimitive.Content
            align="end"
            sideOffset={6}
            className="z-50 min-w-44 rounded-md border bg-popover p-1.5 text-popover-foreground shadow-lg"
          >
            <ThreadListItemMorePrimitive.Item
              className={cn(
                "flex min-h-9 cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors",
                "text-destructive focus:bg-destructive/10 data-[highlighted]:bg-destructive/10 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
              )}
              disabled={deleting}
              onSelect={() => setConfirmDeleteOpen(true)}
            >
              <Trash2 size={15} aria-hidden="true" />
              <span>{t("deleteConversationMenuItem")}</span>
            </ThreadListItemMorePrimitive.Item>
          </ThreadListItemMorePrimitive.Content>
        </ThreadListItemMorePrimitive.Root>
      </div>

      <Dialog
        open={confirmDeleteOpen}
        title={t("deleteConversationDialogTitle")}
        onClose={() => {
          if (!deleting) {
            setConfirmDeleteOpen(false);
          }
        }}
      >
        <div className="grid gap-4">
          <p className="text-sm leading-6 text-muted-foreground">
            {t("deleteConversationDialogDescription", { title: conversation.title })}
          </p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmDeleteOpen(false)}
              disabled={deleting}
            >
              {t("cancel")}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                setConfirmDeleteOpen(false);
                onDelete();
              }}
              disabled={deleting}
            >
              <Trash2 size={16} aria-hidden="true" />
              {deleting ? t("deleting") : t("confirmDeleteConversation")}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

function AnimatedConversationTitle({ title }: { title: string }) {
  const { text, typing } = useTypewriterTitle(title);

  return (
    <span className="inline-flex min-w-0 max-w-full items-baseline text-sm font-medium leading-5" title={title} aria-label={title}>
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
