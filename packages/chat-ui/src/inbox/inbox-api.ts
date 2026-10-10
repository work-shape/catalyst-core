import { useQuery } from "@tanstack/react-query";
import { listAll, type ApprovalRequestView } from "@vivd-catalyst/api-client";
import {
  approvalRequestQueryKeys,
  type ApprovalRequestApiInput
} from "../approvals/approval-request-api";
import type { InboxTab } from "./inbox-model";

/** How often an open list asks again, so a decision made elsewhere shows without a reload. */
const INBOX_LIST_REFETCH_MS = 60_000;

/**
 * The key of a list. It stands under the prefix of every approval request query, so a decision
 * refreshes the lists together with the count and the open item.
 */
export function inboxListQueryKey(apiBaseUrl: string, authScope: string, tab: InboxTab) {
  return [...approvalRequestQueryKeys.all(apiBaseUrl, authScope), "inbox", tab] as const;
}

/**
 * One list of the Inbox, read whole and ordered by the page. `to_decide` and `decided` need a
 * review right and are asked only for a person who has one.
 */
export function useInboxListQuery(
  input: ApprovalRequestApiInput & { tab: InboxTab; enabled: boolean }
) {
  const { client, tab } = input;
  return useQuery({
    queryKey: inboxListQueryKey(input.apiBaseUrl, input.authScope, tab),
    queryFn: (): Promise<ApprovalRequestView[]> =>
      listAll((paging) =>
        tab === "mine"
          ? client.approval_requests.list_mine({ query: paging })
          : client.approval_requests.list({
              query:
                tab === "to_decide"
                  ? { status: "pending", ...paging }
                  : { scope: "decided", ...paging }
            })
      ),
    enabled: input.enabled,
    refetchOnWindowFocus: true,
    refetchInterval: INBOX_LIST_REFETCH_MS
  });
}
