import { SquarePen } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient, ConversationListItem } from "@vivd-catalyst/api-client";
import { CommandPalette, type CommandPaletteGroup } from "@vivd-catalyst/ui";
import { useConversationSearchQuery } from "../api/conversation-search-query";
import { useTranslation, type TranslationKey } from "../i18n";
import { workspaceShortcutLabel } from "./workspace-shortcuts";

/**
 * How long the palette waits after a key before it asks the server, in milliseconds, so a
 * typed word is one search and not one per letter. The reader sees the previous results until
 * then.
 */
const SEARCH_DELAY_MS = 150;

// A conversation id never equals these, so a command or a place cannot be taken for one.
const NEW_CHAT_VALUE = "command:new-chat";
const GO_TO_PREFIX = "go-to:";

/** One place of the "Go to" group: a Settings page the viewer may open, or Build. */
interface PaletteGoToTarget {
  id: string;
  labelKey: TranslationKey;
}

/**
 * The command palette: New chat, the conversations of the active workspace and the places the
 * viewer may go to. Before anything is typed it shows the conversations the rail has loaded
 * and asks the server nothing; a typed text is searched on the server, and narrows the places
 * here.
 */
export function ConversationPalette({
  open,
  apiBaseUrl,
  authScope,
  client,
  collaborationWorkspaceId,
  collaborationWorkspacesAvailable,
  recentConversations,
  goToTargets,
  onNewChat,
  onSelectConversation,
  onGoTo,
  onClose
}: {
  open: boolean;
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  collaborationWorkspaceId: string | undefined;
  collaborationWorkspacesAvailable: boolean;
  recentConversations: readonly ConversationListItem[];
  /** The caller lists only what the viewer may open. */
  goToTargets: readonly PaletteGoToTarget[];
  onNewChat(): void;
  onSelectConversation(conversationId: string): void;
  onGoTo(targetId: string): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const searched = useDelayed(typed, SEARCH_DELAY_MS);
  const search = useConversationSearchQuery({
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    collaborationWorkspacesAvailable,
    titleQuery: open ? searched : ""
  });

  // Every opening starts empty.
  useEffect(() => {
    if (!open) {
      setQuery("");
    }
  }, [open]);

  const conversationItems = (conversations: readonly ConversationListItem[]) =>
    conversations.map((conversation) => ({ value: conversation.id, label: conversation.title }));
  const results = searched === "" ? undefined : search.data;
  const needle = typed.toLocaleLowerCase();
  const goTo: CommandPaletteGroup = {
    heading: t("nav.paletteGoTo"),
    items: goToTargets
      .map((target) => ({ value: `${GO_TO_PREFIX}${target.id}`, label: t(target.labelKey) }))
      .filter((item) => item.label.toLocaleLowerCase().includes(needle))
  };
  let groups: CommandPaletteGroup[];
  let message: string | undefined;
  if (typed === "") {
    groups = [
      {
        items: [
          {
            value: NEW_CHAT_VALUE,
            label: t("nav.newChat"),
            leading: <SquarePen aria-hidden="true" />,
            shortcut: workspaceShortcutLabel("newChat")
          }
        ]
      },
      { heading: t("nav.recent"), items: conversationItems(recentConversations) },
      goTo
    ];
  } else if (search.isError) {
    groups = [goTo];
    message = t("nav.paletteFailed");
  } else {
    groups = [
      { heading: t("nav.paletteConversations"), items: conversationItems(results ?? []) },
      goTo
    ];
    // The sentence names the text the shown answer belongs to, not what is typed since.
    message =
      results?.length === 0 && !search.isPlaceholderData && goTo.items.length === 0
        ? t("nav.paletteNoMatch", { query: searched })
        : undefined;
  }

  return (
    <CommandPalette
      open={open}
      label={t("nav.search")}
      query={query}
      groups={groups}
      message={message}
      onQueryChange={setQuery}
      onSelect={(value) => {
        onClose();
        if (value === NEW_CHAT_VALUE) {
          onNewChat();
        } else if (value.startsWith(GO_TO_PREFIX)) {
          onGoTo(value.slice(GO_TO_PREFIX.length));
        } else {
          onSelectConversation(value);
        }
      }}
      onClose={onClose}
    />
  );
}

/** `value`, once it has stood unchanged for `delayMs`. An empty value arrives at once. */
function useDelayed(value: string, delayMs: number): string {
  const [delayed, setDelayed] = useState(value);
  useEffect(() => {
    if (value === "") {
      setDelayed("");
      return undefined;
    }
    const timeout = window.setTimeout(() => setDelayed(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return delayed;
}
