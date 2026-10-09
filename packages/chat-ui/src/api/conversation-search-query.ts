import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
