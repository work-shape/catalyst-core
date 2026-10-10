import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { ApiClient } from "@vivd-catalyst/api-client";
import { PERSONAL_DEFAULT_CONVERSATION_LIST } from "./workspace-queries";
import { workspaceQueryKeys } from "./workspace-query-keys";

/**
 * How many conversations one search shows. It is a page of the list: a search with more
 * matches than this shows the most recently changed ones, and typing more narrows them.
 */
const CONVERSATION_SEARCH_RESULTS = 20;

/**
 * The conversations of a workspace whose title contains `titleQuery`, searched on the server
 * with the list's access filter. While the next search runs the previous results stay.
 */
export function useConversationSearchQuery(input: {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  collaborationWorkspaceId: string | undefined;
  collaborationWorkspacesAvailable: boolean;
  titleQuery: string;
}) {
  const { collaborationWorkspaceId, titleQuery } = input;
  return useQuery({
    queryKey: workspaceQueryKeys.conversationSearch(
      input.apiBaseUrl,
      input.authScope,
      input.collaborationWorkspacesAvailable
        ? collaborationWorkspaceId
        : PERSONAL_DEFAULT_CONVERSATION_LIST,
      titleQuery
    ),
    queryFn: async ({ signal }) =>
      (
        await input.client.conversations.list({
          query: {
            ...(input.collaborationWorkspacesAvailable ? { collaborationWorkspaceId } : {}),
            query: titleQuery,
            limit: CONVERSATION_SEARCH_RESULTS
          },
          signal
        })
      ).items,
    enabled:
      titleQuery !== "" &&
      (!input.collaborationWorkspacesAvailable || Boolean(collaborationWorkspaceId)),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
    gcTime: 0
  });
}

/**
 * How many conversations the full list asks for at once: the default page of the list
 * operation, whose largest page is 200.
 *
 * The list is read page by page and never to its end up front. A page is read by cursor over
 * (updatedAt, id), so the first and the two-hundredth cost the server the same, and the full
 * list is built for 10,000 conversations of one person in a workspace: that is 200 pages, of
 * which a reader loads the ones they ask for. What grows with the pages loaded is this tab:
 * the rows it holds and draws, and one request per loaded page whenever the list is marked as
 * changed. A reader after an old conversation narrows the list with the search, which the
 * server answers, and does not page to it.
 */
const CONVERSATION_LIST_PAGE_SIZE = 50;

/** The page parameter of the first page, which has no cursor. */
const FIRST_PAGE = "";

/**
 * The conversations of a workspace by last activity, one page after the other, with the
 * list's access filter. A `titleQuery` keeps the ones whose title contains it. While the
 * answer to another text is on its way the previous rows stay.
 */
export function useConversationPagesQuery(input: {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  collaborationWorkspaceId: string | undefined;
  collaborationWorkspacesAvailable: boolean;
  titleQuery: string;
}) {
  const { collaborationWorkspaceId, titleQuery } = input;
  return useInfiniteQuery({
    queryKey: workspaceQueryKeys.conversationPages(
      input.apiBaseUrl,
      input.authScope,
      input.collaborationWorkspacesAvailable
        ? collaborationWorkspaceId
        : PERSONAL_DEFAULT_CONVERSATION_LIST,
      titleQuery
    ),
    queryFn: ({ pageParam, signal }) =>
      input.client.conversations.list({
        query: {
          ...(input.collaborationWorkspacesAvailable ? { collaborationWorkspaceId } : {}),
          ...(titleQuery === "" ? {} : { query: titleQuery }),
          limit: CONVERSATION_LIST_PAGE_SIZE,
          ...(pageParam === FIRST_PAGE ? {} : { cursor: pageParam })
        },
        signal
      }),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: !input.collaborationWorkspacesAvailable || Boolean(collaborationWorkspaceId),
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0
  });
}
