import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import type { ApiClient, Conversation } from "@work-shape/catalyst-api-client";
import { useTranslation } from "../../shared/i18n";
import { useOwnChatSkillsQuery } from "../../shared/api/personal-chat-skills";
import { usePersonalConnectionsQuery } from "../../shared/api/personal-connections";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { retryUnlessRefused } from "../../shared/api/workspace-queries";
import { mentionsName, withoutMentions } from "./mention-trigger";
import { shareRefusal, type ShareRefusal } from "./share-words";

// One private chat shared with named members of its workspace (CHAT-SHARE-2). The provider
// stands around the open chat on its route: the composer's @ menu, the head's people and the
// panel "Who can see this chat" read it. The instance decides every share: the interface only
// offers what it answers and words its refusals.

/** The open chat, its reader and its workspace, as the provider is given them. */
export interface ChatShareChat {
  client: ApiClient;
  apiBaseUrl: string;
  authScope: string;
  conversation: Conversation;
  viewer: { id: string; label: string };
  /** The chat's workspace by the name the interface gives it. */
  workspaceName: string;
  /** Opens the dialog that moves this chat to another workspace. */
  onMove?(): void;
  /** The reader left the chat: the interface goes elsewhere. */
  onLeft(): void;
}

/** Someone who reads the chat: its creator first, then each person named. */
export interface ChatReader {
  userId: string;
  label: string;
  creator: boolean;
  you: boolean;
}

/** A person picked in the composer, shared with when the message is sent. */
interface ShareChip {
  userId: string;
  label: string;
  /** Why the instance refused to share with them: Send waits until the chip is removed. */
  refusal?: string;
}

export interface ChatShareValue {
  chat: ChatShareChat;
  isCreator: boolean;
  /** The creator of a private chat: an @ opens the menu of people to share it with. */
  menu: boolean;
  /** The creator may add people in the panel; else the panel lists who reads the chat. */
  canAdd: boolean;
  readers: readonly ChatReader[];
  chips: readonly ShareChip[];
  pick(person: { userId: string; label: string }): void;
  drop(userId: string): void;
  /** Drops the chips whose "@Name" the text no longer holds. */
  syncChips(text: string): void;
  /** A share before a send is under way. */
  sharing: boolean;
  /**
   * Shares with the picked people before the message goes, then calls `send`, or `chipsOnly`
   * for a message whose text holds only chips (its attachments may still go). True where it took the send over; nothing is sent where a
   * share is refused, and the chip says why.
   */
  beforeSend(text: string, send: () => void, chipsOnly: () => void): boolean;
  /** The person's own skills or Connections run in this chat until it names someone. */
  ownStops: boolean;
  add(person: { userId: string; label: string }): Promise<ShareRefusal | undefined>;
  remove(person: { userId: string; label: string }): Promise<ShareRefusal | undefined>;
  panelOpen: boolean;
  setPanelOpen(open: boolean): void;
  /** Who wrote a message of a chat that names people: "You" or their name. */
  senderOf(messageId: string): string | undefined;
  /** What the composer's open @ searches, or nothing while it is closed. */
  searchMenu(query: string | undefined): void;
  /** The people the open @ offers, as the instance answered its search. */
  menuCandidates: {
    candidates: readonly ShareCandidate[];
    loading: boolean;
    error: unknown;
  };
}

type ShareCandidate = Awaited<
  ReturnType<ApiClient["conversations"]["share_candidates"]>
>["candidates"][number];

const ChatShareContext = createContext<ChatShareValue | undefined>(undefined);

/** The open chat's sharing, or nothing where the chat is not shared from here. */
export function useChatShare(): ChatShareValue | undefined {
  return useContext(ChatShareContext);
}

function shareCandidatesScope(apiBaseUrl: string, conversationId: string) {
  return ["chat-share-candidates", apiBaseUrl, conversationId] as const;
}

/**
 * The people the creator may name on the chat: the instance's preselection on an empty search,
 * or those of them the search matches. A refusal says why the chat is not shared at all.
 */
export function useShareCandidates(input: {
  chat: ChatShareChat | undefined;
  query: string;
  enabled: boolean;
  limit?: number;
}) {
  const { chat } = input;
  const query = input.query.trim();
  const limit = input.limit ?? 5;
  return useQuery({
    queryKey: [
      ...shareCandidatesScope(chat?.apiBaseUrl ?? "", chat?.conversation.id ?? ""),
      query,
      limit
    ],
    queryFn: ({ signal }) => {
      if (!chat) throw new Error("No chat to share");
      return chat.client.conversations.share_candidates({
        params: { conversationId: chat.conversation.id },
        query: { ...(query === "" ? {} : { query }), limit },
        signal
      });
    },
    enabled: input.enabled && chat !== undefined,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: retryUnlessRefused
  });
}

/** What the provider is given on every route; the open chat is one of them where there is one. */
export interface ChatShareProviderProps {
  client: ApiClient;
  apiBaseUrl: string;
  authScope: string;
  viewer: { id: string; label: string };
  /** The open workspace by the name the interface gives it, once it is known. */
  workspaceName: string | undefined;
  /** The open chat: nothing is shared from here without one. */
  conversation: Conversation | undefined;
  /** Opens the dialog that moves the chat to another workspace, where the person may. */
  onMove?(conversation: Conversation): void;
  onLeft(): void;
  /** Who sent each message that started a turn, by the message's id. */
  runSenders?: ReadonlyMap<string, { userId: string; label?: string }>;
  /** The rail's "Share…" asked for the open chat's panel. */
  panelRequested?: boolean;
  onPanelRequestHandled?(): void;
  children: ReactNode;
}

/**
 * Stands around the chat on every route, so a chat opened or closed never mounts what is under
 * it again: the chips and the panel belong to the chat they were opened on, and another chat
 * starts with none.
 */
export function ChatShareProvider({
  client,
  apiBaseUrl,
  authScope,
  viewer,
  workspaceName,
  conversation,
  onMove,
  onLeft,
  runSenders,
  panelRequested = false,
  onPanelRequestHandled,
  children
}: ChatShareProviderProps) {
  const { id: viewerId, label: viewerLabel } = viewer;
  // The viewer is compared by what it holds: a caller may build it anew on each render.
  const chat = useMemo(
    (): ChatShareChat | undefined =>
      conversation && workspaceName !== undefined
        ? {
            client,
            apiBaseUrl,
            authScope,
            conversation,
            viewer: { id: viewerId, label: viewerLabel },
            workspaceName,
            ...(onMove ? { onMove: () => onMove(conversation) } : {}),
            onLeft
          }
        : undefined,
    [
      apiBaseUrl,
      authScope,
      client,
      conversation,
      onLeft,
      onMove,
      viewerId,
      viewerLabel,
      workspaceName
    ]
  );
  const value = useChatShareValue({
    chat,
    base: { client, apiBaseUrl, authScope },
    runSenders,
    panelRequested,
    onPanelRequestHandled
  });
  return <ChatShareContext.Provider value={value}>{children}</ChatShareContext.Provider>;
}

/**
 * Holds a value for one chat: read for another chat, it is the empty value again. The ref holds
 * the latest value for a reader in the same moment, such as a send right after a pick.
 */
function useChatState<T>(chatId: string | undefined, empty: T) {
  const [held, setHeld] = useState<{ chatId: string | undefined; value: T }>({
    chatId,
    value: empty
  });
  const latest = useRef(held);
  const current = held.chatId === chatId ? held.value : empty;
  const read = useCallback(
    () => (latest.current.chatId === chatId ? latest.current.value : empty),
    [chatId, empty]
  );
  const update = useCallback(
    (next: (value: T) => T) => {
      latest.current = { chatId, value: next(read()) };
      setHeld(latest.current);
    },
    [chatId, read]
  );
  return [current, update, read] as const;
}

const NO_CHIPS: readonly ShareChip[] = [];

function useChatShareValue({
  chat,
  base,
  runSenders,
  panelRequested,
  onPanelRequestHandled
}: {
  chat: ChatShareChat | undefined;
  base: { client: ApiClient; apiBaseUrl: string; authScope: string };
  runSenders: ReadonlyMap<string, { userId: string; label?: string }> | undefined;
  panelRequested: boolean;
  onPanelRequestHandled: (() => void) | undefined;
}): ChatShareValue | undefined {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const conversation = chat?.conversation;
  const chatId = conversation?.id;
  const viewerId = chat?.viewer.id;
  const viewerLabel = chat?.viewer.label ?? "";
  const onLeft = chat?.onLeft;
  const { client, apiBaseUrl, authScope } = base;

  const refresh = useCallback(async () => {
    if (chatId === undefined) return;
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.thread(apiBaseUrl, authScope, chatId)
      }),
      queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.conversationsScope(apiBaseUrl, authScope)
      }),
      queryClient.invalidateQueries({ queryKey: shareCandidatesScope(apiBaseUrl, chatId) })
    ]);
  }, [apiBaseUrl, authScope, chatId, queryClient]);

  const isCreator = conversation !== undefined && conversation.createdByUserId === viewerId;
  // The chips as a send reads them, which may follow a change in the same moment.
  const [chips, updateChips, chipsNow] = useChatState<readonly ShareChip[]>(chatId, NO_CHIPS);
  const [sharing, setSharing] = useState(false);
  const sharingRef = useRef(false);
  const [panelFor, setPanelFor] = useState<string>();
  const panelOpen = chatId !== undefined && panelFor === chatId;
  const setPanelOpen = useCallback(
    (open: boolean) => setPanelFor(open ? chatId : undefined),
    [chatId]
  );
  if (panelRequested && chatId !== undefined && !panelOpen) {
    setPanelFor(chatId);
    onPanelRequestHandled?.();
  }

  const readers = useMemo((): ChatReader[] => {
    if (!conversation) return [];
    const creatorLabel = isCreator
      ? viewerLabel
      : (conversation.createdByDisplayLabel ?? t("chatShare.someone"));
    return [
      {
        userId: conversation.createdByUserId,
        label: creatorLabel,
        creator: true,
        you: isCreator
      },
      ...conversation.people.map((person) => ({
        userId: person.userId,
        label: person.displayLabel,
        creator: false,
        you: person.userId === viewerId
      }))
    ];
  }, [conversation, isCreator, t, viewerId, viewerLabel]);

  const shareable = isCreator && conversation.visibility === "private";
  // The person's own skills and Connections leave the chat with its first named person.
  const asksOwn = shareable && conversation.people.length === 0 && chips.length > 0;
  const ownSkills = useOwnChatSkillsQuery({ client, apiBaseUrl, authScope, enabled: asksOwn });
  const ownConnections = usePersonalConnectionsQuery({
    client,
    apiBaseUrl,
    authScope,
    enabled: asksOwn
  });
  const ownStops =
    asksOwn &&
    ((ownSkills.data?.items ?? []).some((skill) => skill.inMyChats) ||
      (ownConnections.data?.connections ?? []).some(
        (connection) => connection.state === "connected"
      ));

  const add = useCallback(
    async (person: { userId: string; label: string }) => {
      if (chatId === undefined) return undefined;
      try {
        await client.conversations.add_person({
          params: { conversationId: chatId },
          body: { userId: person.userId }
        });
        await refresh();
        return undefined;
      } catch (error) {
        return shareRefusal(error, t, person.label);
      }
    },
    [chatId, client, refresh, t]
  );

  const remove = useCallback(
    async (person: { userId: string; label: string }) => {
      if (chatId === undefined) return undefined;
      try {
        await client.conversations.remove_person({
          params: { conversationId: chatId, userId: person.userId }
        });
      } catch (error) {
        return shareRefusal(error, t, person.label);
      }
      if (person.userId === viewerId) {
        setPanelFor(undefined);
        onLeft?.();
      }
      await refresh();
      return undefined;
    },
    [chatId, client, onLeft, refresh, t, viewerId]
  );

  const pick = useCallback(
    (person: { userId: string; label: string }) =>
      updateChips((current) =>
        current.some((chip) => chip.userId === person.userId)
          ? current
          : [...current, { userId: person.userId, label: person.label }]
      ),
    [updateChips]
  );
  const drop = useCallback(
    (userId: string) => updateChips((current) => current.filter((chip) => chip.userId !== userId)),
    [updateChips]
  );
  const syncChips = useCallback(
    (text: string) => {
      if (chipsNow().every((chip) => mentionsName(text, chip.label))) return;
      updateChips((current) => current.filter((chip) => mentionsName(text, chip.label)));
    },
    [chipsNow, updateChips]
  );

  const beforeSend = useCallback(
    (text: string, send: () => void, chipsOnly: () => void) => {
      const waiting = chipsNow();
      if (waiting.length === 0) return false;
      if (sharingRef.current || waiting.some((chip) => chip.refusal !== undefined)) return true;
      sharingRef.current = true;
      setSharing(true);
      (async () => {
        try {
          for (const chip of waiting) {
            const refused = await add(chip);
            if (refused) {
              updateChips((current) =>
                current.map((each) =>
                  each.userId === chip.userId ? { ...each, refusal: refused.message } : each
                )
              );
              return;
            }
            updateChips((current) => current.filter((each) => each.userId !== chip.userId));
          }
          // Shared with everyone picked: the message goes, or what it holds beside the chips.
          if (
            withoutMentions(
              text,
              waiting.map((chip) => chip.label)
            ) === ""
          )
            chipsOnly();
          else send();
        } finally {
          sharingRef.current = false;
          setSharing(false);
        }
      })().catch(() => undefined);
      return true;
    },
    [add, chipsNow, updateChips]
  );

  // The composer's @ asks here, where the query client always is.
  const [menuQuery, setMenuQuery] = useState<string>();
  const menuSearch = useShareCandidates({
    chat,
    query: menuQuery ?? "",
    enabled: menuQuery !== undefined && shareable
  });
  const menuCandidates = useMemo(
    () => ({
      candidates: menuSearch.data?.candidates ?? [],
      loading: menuSearch.isFetching,
      error: menuSearch.error
    }),
    [menuSearch.data, menuSearch.error, menuSearch.isFetching]
  );

  // A chat more than one person reads or wrote in says who wrote each message, so the turns of
  // someone who left never read as another's. One person alone sees no names.
  const namesSenders = useMemo(
    () =>
      readers.length > 1 ||
      new Set(Array.from(runSenders?.values() ?? [], (sender) => sender.userId)).size > 1,
    [readers.length, runSenders]
  );
  const senderOf = useCallback(
    (messageId: string) => {
      if (!namesSenders) return undefined;
      const sender = runSenders?.get(messageId);
      if (!sender) return undefined;
      if (sender.userId === viewerId) return t("chatShare.senderYou");
      // Someone who left or was removed keeps their name on what they wrote.
      return readers.find((each) => each.userId === sender.userId)?.label ?? sender.label;
    },
    [namesSenders, readers, runSenders, t, viewerId]
  );

  return useMemo(
    (): ChatShareValue | undefined =>
      chat === undefined
        ? undefined
        : {
            chat,
            isCreator,
            menu: shareable,
            canAdd: shareable && chat.conversation.projectId === undefined,
            readers,
            chips,
            pick,
            drop,
            syncChips,
            sharing,
            beforeSend,
            ownStops,
            add,
            remove,
            panelOpen,
            setPanelOpen,
            senderOf,
            searchMenu: setMenuQuery,
            menuCandidates
          },
    [
      add,
      menuCandidates,
      senderOf,
      beforeSend,
      chat,
      chips,
      drop,
      isCreator,
      ownStops,
      panelOpen,
      pick,
      readers,
      remove,
      setPanelOpen,
      shareable,
      sharing,
      syncChips
    ]
  );
}
