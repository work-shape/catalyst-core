import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ThreadListItemMorePrimitive } from "@assistant-ui/react";
import { Clock, FolderInput, Lock, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { ConversationListItem, SafeConfig } from "@vivd-catalyst/api-client";
import {
  Button,
  cn,
  Dialog,
  IconButton,
  Input,
  NavItem,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { retentionWarningDate, retentionWarningText } from "./retention-warning";

export function ConversationButton({
  conversation,
  selected,
  retention,
  onSelect,
  onRename,
  onMove,
  onDelete,
  deleting
}: {
  conversation: ConversationListItem;
  selected: boolean;
  /** The instance's retention settings, which decide whether and when a deletion is near. */
  retention: SafeConfig["retention"] | undefined;
  onSelect: () => void;
  onRename: (title: string) => Promise<void>;
  /** Absent while the user belongs to a single Collaboration Workspace. */
  onMove?: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { locale, t } = useTranslation();
  const [confirmDeleteOpen, setConfirmDeleteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(conversation.title);
  const [saving, setSaving] = useState(false);
  const editorFormRef = useRef<HTMLFormElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const renamingFromMenuRef = useRef(false);
  const wasSelectedRef = useRef(selected);
  const running = Boolean(conversation.activeRun);
  const unread = Boolean(conversation.unread && !selected);
  const expiresAt = retentionWarningDate(conversation.retainedUntil, retention);
  const expiryLabel = expiresAt ? retentionWarningText(expiresAt, { locale, t }) : undefined;
  const expiryHintId = useId();
  // The clock opens its hint under the pointer; the row's button opens it for the keyboard.
  const [expiryHint, setExpiryHint] = useState(retentionHintClosed);
  const onExpiryHintEvent = useCallback(
    (event: RetentionHintEvent) => setExpiryHint((state) => retentionHintAfter(state, event)),
    []
  );

  const exitEditing = useCallback(() => {
    if (saving) {
      return;
    }
    setDraftTitle(conversation.title);
    setEditing(false);
  }, [conversation.title, saving]);

  useEffect(() => {
    const movedToAnotherConversation = wasSelectedRef.current && !selected;
    wasSelectedRef.current = selected;
    if (movedToAnotherConversation) {
      exitEditing();
    }
  }, [exitEditing, selected]);

  useEffect(() => {
    if (!editing) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editing]);

  useEffect(() => {
    if (!editing) {
      return;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!editorFormRef.current?.contains(event.target as Node)) {
        exitEditing();
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [editing, exitEditing]);

  function startEditing() {
    setDraftTitle(conversation.title);
    setEditing(true);
  }

  async function saveTitle() {
    const title = draftTitle.trim();
    if (!title || saving) {
      titleInputRef.current?.focus();
      return;
    }
    if (title === conversation.title) {
      exitEditing();
      return;
    }

    exitEditing();
    setSaving(true);
    try {
      await onRename(title);
    } catch {
      // The mutation surfaces the error and the persisted title remains unchanged.
    } finally {
      setSaving(false);
    }
  }

  const options = (
    <ThreadListItemMorePrimitive.Root>
      <ThreadListItemMorePrimitive.Trigger asChild disabled={deleting || saving}>
        <IconButton size="sm" label={t("conversationOptions", { title: conversation.title })}>
          <MoreHorizontal aria-hidden="true" />
        </IconButton>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        align="end"
        sideOffset={6}
        className="z-50 min-w-44 rounded-lg border bg-popover p-1 text-popover-foreground shadow-overlay"
        onCloseAutoFocus={(event) => {
          if (renamingFromMenuRef.current) {
            event.preventDefault();
            renamingFromMenuRef.current = false;
          }
        }}
      >
        {expiryLabel ? (
          // Touch has no hover: the menu, always visible there, repeats the hint.
          <div
            className="mb-1 flex items-start gap-2 border-b px-2.5 pb-2 pt-1 text-xs text-muted-foreground"
            data-testid="conversation-expiry-menu-hint"
          >
            <Clock size={13} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
            <span className="max-w-56">{expiryLabel}</span>
          </div>
        ) : null}
        <ThreadListItemMorePrimitive.Item
          className={cn(
            "flex min-h-9 cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors",
            "focus:bg-accent data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          )}
          disabled={deleting || saving}
          onSelect={() => {
            renamingFromMenuRef.current = true;
            startEditing();
          }}
        >
          <Pencil size={15} aria-hidden="true" />
          <span>{t("renameConversationMenuItem")}</span>
        </ThreadListItemMorePrimitive.Item>
        {onMove ? (
          <ThreadListItemMorePrimitive.Item
            className={cn(
              "flex min-h-9 cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors",
              "focus:bg-accent data-[highlighted]:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
            )}
            disabled={deleting || saving}
            onSelect={onMove}
          >
            <FolderInput size={15} aria-hidden="true" />
            <span>{t("moveConversationMenuItem")}</span>
          </ThreadListItemMorePrimitive.Item>
        ) : null}
        <ThreadListItemMorePrimitive.Item
          className={cn(
            "flex min-h-9 cursor-default select-none items-center gap-2 rounded-md px-2.5 py-2 text-sm outline-none transition-colors",
            "text-destructive focus:bg-destructive/10 data-[highlighted]:bg-destructive/10 data-[disabled]:pointer-events-none data-[disabled]:opacity-50"
          )}
          disabled={deleting || saving}
          onSelect={() => setConfirmDeleteOpen(true)}
        >
          <Trash2 size={15} aria-hidden="true" />
          <span>{t("deleteConversationMenuItem")}</span>
        </ThreadListItemMorePrimitive.Item>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );

  return (
    <>
      <div
        data-testid="conversation-row"
        data-selected={selected ? "true" : undefined}
        className="min-w-0"
      >
        {editing ? (
          <form
            ref={editorFormRef}
            className="flex h-8 min-w-0 items-center"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                exitEditing();
              }
            }}
            onSubmit={(event) => {
              event.preventDefault();
              void saveTitle();
            }}
          >
            <Input
              ref={titleInputRef}
              size="sm"
              type="text"
              value={draftTitle}
              maxLength={120}
              disabled={saving}
              aria-label={t("renameConversationField")}
              onChange={(event) => setDraftTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  exitEditing();
                }
              }}
            />
          </form>
        ) : (
          <NavItem
            selected={selected}
            aria-describedby={expiryLabel ? expiryHintId : undefined}
            trailing={options}
            onClick={() => {
              onExpiryHintEvent("dismiss");
              onSelect();
            }}
            onFocus={(event) => {
              if (expiryLabel && event.currentTarget.matches(":focus-visible")) {
                onExpiryHintEvent("focus");
              }
            }}
            onBlur={() => onExpiryHintEvent("blur")}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {running ? (
                <Spinner
                  size="sm"
                  className="shrink-0 text-primary"
                  data-testid="conversation-running-indicator"
                  role="img"
                  aria-hidden={false}
                  aria-label={t("conversationRunning")}
                />
              ) : null}
              <span
                className="min-w-0 truncate"
                title={conversation.title}
                onClick={(event) => {
                  if (!selected) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  startEditing();
                }}
              >
                {conversation.title}
              </span>
              {conversation.visibility === "private" ? (
                <span
                  className="shrink-0 text-muted-foreground"
                  data-testid="conversation-private-marker"
                  role="img"
                  aria-label={t("conversationPrivate")}
                  title={t("conversationPrivate")}
                >
                  <Lock className="size-3" aria-hidden="true" />
                </span>
              ) : null}
              {expiryLabel ? (
                // Deletion cannot be undone, so its mark shows at rest, not only with the row's menu.
                <RetentionClock
                  name={t("conversationExpiresSoon")}
                  hint={expiryLabel}
                  open={retentionHintOpen(expiryHint)}
                  onHintEvent={onExpiryHintEvent}
                />
              ) : null}
              {unread ? (
                <span
                  className="size-1.5 shrink-0 rounded-full bg-primary"
                  data-testid="conversation-unread-indicator"
                  role="img"
                  aria-label={t("conversationUnread")}
                  title={t("conversationUnread")}
                />
              ) : null}
            </span>
          </NavItem>
        )}
        {expiryLabel && !editing ? (
          // The row's name stays short; the full sentence is its description.
          <span id={expiryHintId} className="sr-only" data-testid="conversation-expiry-description">
            {expiryLabel}
          </span>
        ) : null}
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

/** What holds the retention hint open: the pointer on the clock, the keyboard on the row. */
export interface RetentionHintState {
  hovered: boolean;
  focused: boolean;
}

export type RetentionHintEvent = "hover" | "unhover" | "focus" | "blur" | "dismiss";

export const retentionHintClosed: RetentionHintState = { hovered: false, focused: false };

/** The hint shows while either holds. A dismissal hides it until the next hover or focus. */
export function retentionHintAfter(
  state: RetentionHintState,
  event: RetentionHintEvent
): RetentionHintState {
  switch (event) {
    case "hover":
      return { ...state, hovered: true };
    case "unhover":
      return { ...state, hovered: false };
    case "focus":
      return { ...state, focused: true };
    case "blur":
      return { ...state, focused: false };
    case "dismiss":
      return retentionHintClosed;
  }
}

export function retentionHintOpen(state: RetentionHintState): boolean {
  return state.hovered || state.focused;
}

// The icon is swapped when the hint opens and closes. It takes no pointer events, so the swap
// under a resting pointer does not read as the pointer entering the clock again.
const clockClassName = "pointer-events-none size-3.5!";

function RetentionClock({
  name,
  hint,
  open,
  onHintEvent
}: {
  name: string;
  hint: string;
  open: boolean;
  onHintEvent: (event: RetentionHintEvent) => void;
}) {
  // The span stays mounted while the hint opens and closes, so its pointer tracking holds.
  return (
    <span
      className="flex shrink-0 text-warning"
      data-testid="conversation-expiry-warning"
      role="img"
      aria-label={name}
      onPointerEnter={(event) => {
        if (event.pointerType !== "touch") {
          onHintEvent("hover");
        }
      }}
      onPointerLeave={() => onHintEvent("unhover")}
    >
      {open ? (
        // A long list re-renders every row while a run streams, so the tooltip exists only
        // while it shows.
        <Tooltip open disableHoverableContent>
          <TooltipTrigger asChild>
            <Clock className={clockClassName} aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent
            data-testid="conversation-expiry-hint"
            onEscapeKeyDown={() => onHintEvent("dismiss")}
          >
            {hint}
          </TooltipContent>
        </Tooltip>
      ) : (
        <Clock className={clockClassName} aria-hidden="true" />
      )}
    </span>
  );
}
