import { useComposerRuntime } from "@assistant-ui/react";
import { Users } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from "react";
import {
  Avatar,
  Button,
  Chip,
  FormNotice,
  nextSuggestion,
  SuggestionList,
  suggestionOptionId,
  type SuggestionListOption
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { useChatShare, type ChatShareValue } from "./chat-share";
import { findMentionTrigger, insertMention, type MentionTrigger } from "./mention-trigger";
import { listNames, noMatchWords, outsideWords, shareRefusal } from "./share-words";

// The @ menu of the composer and the chips above it (CHAT-SHARE-2). An @ at the start of the
// text or after a space opens the menu for the creator of a private chat: up to five likely
// people on a bare @, and the letters after it search them; from two letters the instance adds
// everyone active on it, those outside the workspace marked (CHAT-SHARE-6). A picked person
// becomes a chip and "@Name" in the text; Send shares with them first, then sends.

/** How long the search waits for the next letter before it asks the instance. */
export const SEARCH_DELAY_MS = 120;

export interface ComposerMention {
  open: boolean;
  /** Takes the keys the open menu answers: arrows, Enter, Tab and Escape. */
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  /** The caret moved, or text was typed or pasted. */
  onCaretChange(): void;
  onPaste(): void;
  /** What the field says of the menu to assistive technology. */
  inputProps: {
    "aria-controls"?: string;
    "aria-expanded"?: boolean;
    "aria-activedescendant"?: string;
    "aria-autocomplete"?: "list";
  };
  menu: ShareMenuState | undefined;
}

interface ShareMenuState {
  listId: string;
  share: ChatShareValue;
  query: string;
  options: SuggestionListOption[];
  activeId: string | undefined;
  setActiveId(id: string): void;
  choose(id: string): void;
  loading: boolean;
  error: unknown;
}

/** The composer's @: where it stands, what it offers and how the keys move in it. */
export function useComposerMention(
  inputRef: RefObject<HTMLTextAreaElement | null>,
  text: string
): ComposerMention {
  const share = useChatShare();
  const { t } = useTranslation();
  const composer = useComposerRuntime();
  const listId = useId();
  const [trigger, setTrigger] = useState<MentionTrigger>();
  // The @ that Escape or a paste closed stays text until the person types another.
  const dismissedAt = useRef<number | undefined>(undefined);
  const pasted = useRef(false);
  const menuOn = share?.menu === true;

  const read = useCallback(() => {
    const input = inputRef.current;
    if (!menuOn || !input) {
      setTrigger(undefined);
      return;
    }
    const found = findMentionTrigger(input.value, input.selectionStart ?? input.value.length);
    if (pasted.current) {
      pasted.current = false;
      if (found) dismissedAt.current = found.at;
    }
    if (dismissedAt.current !== undefined && input.value[dismissedAt.current] !== "@") {
      dismissedAt.current = undefined;
    }
    setTrigger(found && found.at !== dismissedAt.current ? found : undefined);
  }, [inputRef, menuOn]);

  // Each change of the text: the menu follows, and a chip whose "@Name" is gone goes too.
  const syncChips = share?.syncChips;
  useEffect(() => {
    read();
    syncChips?.(text);
  }, [read, syncChips, text]);

  const query = useDebounced(trigger?.query ?? "", SEARCH_DELAY_MS);
  const candidates = share?.menuCandidates;
  // A search with a space that nobody matches was text after all, as in "@Ada is right": the
  // menu steps aside until the search matches someone again.
  const settledOnNobody =
    trigger !== undefined &&
    /\s/u.test(trigger.query) &&
    query === trigger.query &&
    candidates !== undefined &&
    !candidates.loading &&
    candidates.error === undefined &&
    candidates.candidates.length === 0;
  const searching = trigger !== undefined && share !== undefined;
  const open = searching && !settledOnNobody;
  const searchMenu = share?.searchMenu;
  useEffect(() => {
    searchMenu?.(searching ? query : undefined);
  }, [query, searchMenu, searching]);
  const chips = share?.chips;
  const workspaceName = share?.chat.workspaceName ?? "";
  const options = useMemo((): SuggestionListOption[] => {
    const picked = new Set(chips?.map((chip) => chip.userId));
    return (candidates?.candidates ?? []).map((candidate) =>
      candidateOption(
        candidate,
        workspaceName,
        t,
        candidate.hasAccess || picked.has(candidate.userId)
      )
    );
  }, [candidates?.candidates, chips, t, workspaceName]);
  const [activeId, setActiveId] = useState<string>();
  const active =
    activeId !== undefined && options.some((option) => option.id === activeId && !option.disabled)
      ? activeId
      : nextSuggestion(options, undefined, 1);

  const choose = useCallback(
    (id: string) => {
      const option = options.find((candidate) => candidate.id === id);
      const input = inputRef.current;
      if (!share || !option || option.disabled || !trigger || !input) return;
      const caret = input.selectionStart ?? input.value.length;
      const next = insertMention(input.value, trigger, caret, option.label);
      const member =
        candidates?.candidates.find((candidate) => candidate.userId === id)?.member ?? true;
      share.pick({ userId: option.id, label: option.label, member });
      // The "@Name" just placed is no new search, wherever the caret lands in it.
      dismissedAt.current = trigger.at;
      composer.setText(next.text);
      setTrigger(undefined);
      window.requestAnimationFrame(() => {
        input.focus();
        input.setSelectionRange(next.caret, next.caret);
      });
    },
    [candidates?.candidates, composer, inputRef, options, share, trigger]
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open || event.nativeEvent.isComposing) return false;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveId(nextSuggestion(options, active, event.key === "ArrowDown" ? 1 : -1));
        return true;
      }
      if ((event.key === "Enter" || event.key === "Tab") && active !== undefined) {
        if (event.shiftKey) return false;
        event.preventDefault();
        choose(active);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissedAt.current = trigger?.at;
        setTrigger(undefined);
        return true;
      }
      return false;
    },
    [active, choose, open, options, trigger]
  );

  return {
    open,
    onKeyDown,
    onCaretChange: read,
    onPaste: () => {
      pasted.current = true;
    },
    inputProps: open
      ? {
          "aria-controls": listId,
          "aria-expanded": true,
          "aria-autocomplete": "list",
          ...(active === undefined
            ? {}
            : { "aria-activedescendant": suggestionOptionId(listId, active) })
        }
      : {},
    menu:
      open && share
        ? {
            listId,
            share,
            query: trigger.query,
            options,
            activeId: active,
            setActiveId,
            choose,
            loading: candidates?.loading ?? false,
            error: candidates?.error
          }
        : undefined
  };
}

/** The menu over the composer while an @ is open. */
export function ShareMenu({ menu }: { menu: ShareMenuState }) {
  const { t } = useTranslation();
  const { share } = menu;
  const workspace = share.chat.workspaceName;
  const refusal = menu.error ? shareRefusal(menu.error, t) : undefined;
  const empty = refusal
    ? refusal.message
    : menu.loading && menu.options.length === 0
      ? undefined
      : noMatchWords(menu.query, workspace, t);
  return (
    <SuggestionList
      id={menu.listId}
      label={t("chatShare.menuLabel")}
      heading={refusal ? undefined : t("chatShare.menuHeading")}
      loading={menu.loading}
      options={refusal ? [] : menu.options}
      activeId={menu.activeId}
      onActiveChange={menu.setActiveId}
      onSelect={menu.choose}
      empty={empty}
      footer={
        refusal?.reason === "personal_workspace_conversation" && share.chat.onMove ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={share.chat.onMove}
          >
            {t("moveConversationMenuItem")}
          </Button>
        ) : undefined
      }
      className="absolute bottom-full left-0 z-30 mb-2 w-80 max-w-full"
    />
  );
}

/**
 * The people picked in the composer, above it, and the one line that says what sharing gives
 * them, or why the instance refused it. A refused chip holds Send until it is removed.
 */
export function ShareChips() {
  const share = useChatShare();
  const { t } = useTranslation();
  if (!share || share.chips.length === 0) return null;
  const refused = share.chips.find((chip) => chip.refusal !== undefined);
  const outside = share.chips.filter((chip) => !chip.member).map((chip) => chip.label);
  return (
    <div className="grid gap-1.5 px-1" data-testid="share-chips">
      <div className="flex flex-wrap items-center gap-1.5">
        <Users aria-hidden="true" className="size-3.5 text-muted-foreground" />
        {share.chips.map((chip) => (
          <Chip
            key={chip.userId}
            leading={<Avatar kind="person" size="xs" name={chip.label} />}
            className={chip.refusal === undefined ? undefined : "border-destructive-border"}
            onRemove={share.sharing ? undefined : () => share.drop(chip.userId)}
          >
            {chip.label}
          </Chip>
        ))}
      </div>
      {refused?.refusal !== undefined ? (
        <FormNotice tone="error" data-testid="share-refusal">
          {refused.refusal}
        </FormNotice>
      ) : (
        <p className="text-caption text-muted-foreground" data-testid="share-confirm-line">
          {t("chatShare.willSee", {
            names: listNames(
              share.chips.map((chip) => chip.label),
              t
            )
          })}
          {share.ownStops ? ` ${t("chatShare.ownStop")}` : ""}
        </p>
      )}
      {refused === undefined && outside.length > 0 ? (
        <p className="text-caption text-muted-foreground" data-testid="share-outside-line">
          {outsideWords(outside, share.chat.workspaceName, t)}
        </p>
      ) : null}
    </div>
  );
}

/** Why Send waits, where the picked people hold it: a share under way, or one refused. */
export function useShareSendBlock(): { reason: string; loading: boolean } | undefined {
  const share = useChatShare();
  const { t } = useTranslation();
  if (!share) return undefined;
  if (share.sharing) return { reason: t("chatShare.sharing"), loading: false };
  if (share.chips.some((chip) => chip.refusal !== undefined)) {
    return { reason: t("chatShare.removeChipFirst"), loading: false };
  }
  return undefined;
}

type Translate = ReturnType<typeof useTranslation>["t"];

/**
 * A person a search offers, as a list shows them: "has access" for one who reads the chat
 * already, else "not in {workspace}" for one outside its workspace (CHAT-SHARE-6).
 */
export function candidateOption(
  candidate: {
    userId: string;
    displayLabel: string;
    email?: string | undefined;
    hasAccess: boolean;
    member: boolean;
  },
  workspace: string,
  t: Translate,
  disabled: boolean
): SuggestionListOption {
  const trailing = candidate.hasAccess
    ? t("chatShare.hasAccess")
    : candidate.member
      ? undefined
      : t("chatShare.notIn", { workspace });
  return {
    id: candidate.userId,
    label: candidate.displayLabel,
    ...(candidate.email === undefined ? {} : { description: candidate.email }),
    leading: <Avatar kind="person" size="sm" name={candidate.displayLabel} />,
    ...(trailing === undefined ? {} : { trailing }),
    disabled
  };
}

export function useDebounced(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    // An empty search, the bare @, asks at once.
    if (value === "") {
      setSettled(value);
      return;
    }
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [delay, value]);
  return settled;
}
