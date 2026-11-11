import { useEffect, useRef } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ApiClient, SharedFromOutsideListItem } from "@work-shape/catalyst-api-client";
import { retryUnlessRefused } from "./workspace-queries";
import { workspaceQueryKeys } from "./workspace-query-keys";

/**
 * How many chats shared from outside the rail and the palette show: the first page, latest
 * activity first. A person with more finds an older one by its title in the palette.
 */
const SHARED_FROM_OUTSIDE_LIMIT = 20;

interface SharedFromOutsideInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  /** The session has workspaces: an embedded one reads no list of chats shared with it. */
  enabled: boolean;
}

function readSharedFromOutside(
  client: ApiClient,
  titleQuery: string,
  signal: AbortSignal
): Promise<SharedFromOutsideListItem[]> {
  return client.conversations.shared_from_outside
    .list({
      query: {
        limit: SHARED_FROM_OUTSIDE_LIMIT,
        ...(titleQuery === "" ? {} : { query: titleQuery })
      },
      signal
    })
    .then((page) => page.items);
}

/**
 * The chats shared with the person from workspaces they are no member of (CHAT-SHARE-6b), each
 * with its workspace's name. It reads the first page again when the window regains the focus,
 * when anything marks the conversations as changed (a leave does), and when the person opens
 * such a chat that it does not hold yet, as a fresh share's Inbox notice does.
 */
export function useSharedFromOutsideQuery(
  input: SharedFromOutsideInput & {
    /** The chat on screen when it is read from outside its workspace. */
    openOutsideConversationId?: string | undefined;
  }
) {
  const { client, openOutsideConversationId } = input;
  const query = useQuery({
    queryKey: workspaceQueryKeys.sharedFromOutside(input.apiBaseUrl, input.authScope, ""),
    queryFn: ({ signal }) => readSharedFromOutside(client, "", signal),
    enabled: input.enabled,
    retry: retryUnlessRefused
  });
  const { data, refetch } = query;
  // One read for each chat opened that the list does not hold, so a chat that is not in it
  // (beyond its first page, or already left) costs one request and no loop.
  const askedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (
      openOutsideConversationId === undefined ||
      data === undefined ||
      askedFor.current === openOutsideConversationId ||
      data.some(({ id }) => id === openOutsideConversationId)
    ) {
      return;
    }
    askedFor.current = openOutsideConversationId;
    refetch().catch(() => undefined);
  }, [data, openOutsideConversationId, refetch]);
  return query;
}

/**
 * The chats shared from outside whose title contains `titleQuery`, for the palette's search.
 * While the next search runs the previous results stay.
 */
export function useSharedFromOutsideSearchQuery(
  input: SharedFromOutsideInput & { titleQuery: string }
) {
  const { client, titleQuery } = input;
  return useQuery({
    queryKey: workspaceQueryKeys.sharedFromOutside(input.apiBaseUrl, input.authScope, titleQuery),
    queryFn: ({ signal }) => readSharedFromOutside(client, titleQuery, signal),
    enabled: input.enabled && titleQuery !== "",
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
    gcTime: 0
  });
}
