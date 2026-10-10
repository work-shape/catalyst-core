import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  hashKey,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient
} from "@tanstack/react-query";
import type { ApiClient, ConversationListItem } from "@vivd-catalyst/api-client";
import { PERSONAL_DEFAULT_CONVERSATION_LIST, workspaceQueryKeys } from "./workspace-query-keys";

/**
 * How many conversations the rail asks for at once: its first rows, and each further page a
 * person scrolls to.
 *
 * The rail is the list of a workspace's conversations and never reads it to its end up front.
 * A page is read by cursor over (updatedAt, id), so the first and the three-hundredth cost the
 * server the same. Loading is one request, every further page is one request, and whatever
 * marks the list as changed reads the first page again and nothing else. What grows with the
 * pages a person loads is this tab alone: after N further pages it holds and draws
 * `RAIL_PAGE_SIZE` x (N + 1) rows, until the person leaves the workspace. A person after an old
 * conversation finds it with the search, which the server answers, and does not scroll to it.
 */
export const RAIL_PAGE_SIZE = 30;

/** The conversations the rail has loaded, latest activity first. */
export interface RailConversations {
  conversations: ConversationListItem[];
  /** Where the next older page starts. Absent once the list is read to its end. */
  nextCursor?: string;
}

type ConversationPage = Awaited<ReturnType<ApiClient["conversations"]["list"]>>;
type RailConversationsKey = ReturnType<typeof workspaceQueryKeys.conversations>;

interface RailConversationsInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  collaborationWorkspaceId: string | undefined;
  collaborationWorkspacesAvailable: boolean;
  enabled: boolean;
}

function readPage(input: RailConversationsInput, cursor?: string): Promise<ConversationPage> {
  const { collaborationWorkspaceId } = input;
  return input.client.conversations.list({
    query: {
      ...(input.collaborationWorkspacesAvailable ? { collaborationWorkspaceId } : {}),
      limit: RAIL_PAGE_SIZE,
      ...(cursor === undefined ? {} : { cursor })
    }
  });
}

/** Whether `conversation` stands after `other` in the list: older activity, then smaller id. */
function standsAfter(conversation: ConversationListItem, other: ConversationListItem): boolean {
  return conversation.updatedAt === other.updatedAt
    ? conversation.id < other.id
    : conversation.updatedAt < other.updatedAt;
}

/**
 * The loaded conversations after the first page was read again. The first page is as the
 * server has it now; the older rows a person has loaded stay, so reading again never costs
 * more than one page. A row that a new conversation pushed off the first page stays too, as
 * the first of the older ones.
 */
export function withFirstPage(
  loaded: RailConversations | undefined,
  firstPage: ConversationPage
): RailConversations {
  const last = firstPage.items.at(-1);
  if (!loaded || !last || firstPage.nextCursor === undefined) {
    // Nothing older was loaded, or the first page is the whole list.
    return { conversations: firstPage.items, nextCursor: firstPage.nextCursor };
  }
  const onFirstPage = new Set(firstPage.items.map(({ id }) => id));
  const older = loaded.conversations.filter(
    (conversation) => !onFirstPage.has(conversation.id) && standsAfter(conversation, last)
  );
  return {
    conversations: [...firstPage.items, ...older],
    nextCursor: older.length > 0 ? loaded.nextCursor : firstPage.nextCursor
  };
}

/**
 * The loaded conversations with the next older page after them. A page asked for from a place
 * the list has since left is dropped, and a conversation that moved between two requests shows
 * once.
 */
export function withOlderPage(
  loaded: RailConversations | undefined,
  cursor: string,
  page: ConversationPage
): RailConversations | undefined {
  if (!loaded || loaded.nextCursor !== cursor) {
    return loaded;
  }
  const shown = new Set(loaded.conversations.map(({ id }) => id));
  return {
    conversations: [...loaded.conversations, ...page.items.filter(({ id }) => !shown.has(id))],
    nextCursor: page.nextCursor
  };
}

export function railConversationsQueryOptions(input: RailConversationsInput) {
  const queryKey = workspaceQueryKeys.conversations(
    input.apiBaseUrl,
    input.authScope,
    input.collaborationWorkspacesAvailable
      ? input.collaborationWorkspaceId
      : PERSONAL_DEFAULT_CONVERSATION_LIST
  );
  return {
    queryKey,
    queryFn: async ({ client }: { client: QueryClient }) =>
      withFirstPage(client.getQueryData<RailConversations>(queryKey), await readPage(input)),
    enabled:
      input.enabled &&
      (!input.collaborationWorkspacesAvailable || Boolean(input.collaborationWorkspaceId))
  };
}

/** Reads the page after the loaded conversations, when there is one. One request. */
export async function loadOlderRailConversations(
  queryClient: QueryClient,
  input: RailConversationsInput
): Promise<void> {
  const { queryKey } = railConversationsQueryOptions(input);
  const cursor = queryClient.getQueryData<RailConversations>(queryKey)?.nextCursor;
  if (cursor === undefined) {
    return;
  }
  const page = await readPage(input, cursor);
  queryClient.setQueryData<RailConversations>(queryKey, (loaded) =>
    withOlderPage(loaded, cursor, page)
  );
}

/**
 * Reads the rail's first page again: one request, whatever a person has loaded. A read still
 * on its way is kept, so nothing is asked twice at once.
 */
export function refreshRailConversations(
  queryClient: QueryClient,
  queryKey: RailConversationsKey
): Promise<void> {
  return queryClient.refetchQueries({ queryKey, exact: true }, { cancelRefetch: false });
}

/** Changes the loaded conversations in place, as a rename, a delete or a new chat does. */
export function updateRailConversations(
  queryClient: QueryClient,
  queryKey: RailConversationsKey,
  update: (conversations: ConversationListItem[]) => ConversationListItem[]
): void {
  queryClient.setQueryData<RailConversations>(queryKey, (loaded) => ({
    ...loaded,
    conversations: update(loaded?.conversations ?? [])
  }));
}

/** The rail's conversations of a workspace, and the way to the older ones. */
export function useRailConversations(input: RailConversationsInput) {
  const queryClient = useQueryClient();
  const {
    apiBaseUrl,
    authScope,
    client,
    collaborationWorkspaceId,
    collaborationWorkspacesAvailable,
    enabled
  } = input;
  const source = useMemo(
    () => ({
      apiBaseUrl,
      authScope,
      client,
      collaborationWorkspaceId,
      collaborationWorkspacesAvailable,
      enabled
    }),
    [
      apiBaseUrl,
      authScope,
      client,
      collaborationWorkspaceId,
      collaborationWorkspacesAvailable,
      enabled
    ]
  );
  const options = useMemo(() => railConversationsQueryOptions(source), [source]);
  const { queryKey } = options;
  const query = useQuery(options);
  const older = useMutation({
    // Another workspace starts without the state of this one's last request.
    mutationKey: [...queryKey, "older"],
    mutationFn: () => loadOlderRailConversations(queryClient, source)
  });
  // The row that loads a page asks when it scrolls into view and when it is pressed, which
  // can be the same moment: one request answers both.
  const asking = useRef(false);
  const { mutate } = older;
  // Older pages are kept while the person stays in the workspace and let go when they leave.
  const shownKey = useRef(queryKey);
  useEffect(() => {
    const leftKey = shownKey.current;
    shownKey.current = queryKey;
    if (hashKey(leftKey) !== hashKey(queryKey)) {
      queryClient.removeQueries({ queryKey: leftKey, exact: true });
      // A request of the workspace left no longer reports back here.
      asking.current = false;
    }
  }, [queryClient, queryKey]);

  const loadMore = useCallback(() => {
    if (asking.current) {
      return;
    }
    asking.current = true;
    mutate(undefined, {
      onSettled: () => {
        asking.current = false;
      }
    });
  }, [mutate]);
  return {
    query,
    hasMore: query.data?.nextCursor !== undefined,
    loadingMore: older.isPending,
    loadMoreFailed: older.isError,
    loadMore
  };
}
