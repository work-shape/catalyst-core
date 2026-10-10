import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  ApiError,
  type ApiClient,
  type ApprovalRequestView,
  type OperationInput
} from "@vivd-catalyst/api-client";
import { workspaceQueryKeys } from "../api/workspace-query-keys";

export interface ApprovalRequestApiInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

export type ApprovalDecisionInput = OperationInput<"approval_requests.decide">["body"];

/** `revert_conflict`: newer changes sit on top of the one that should be undone. */
export type ApprovalActionFailure = "failed" | "revert_conflict";

/** Cache dimension of first-party sessions, matching the rest of the workspace queries. */
export const APPROVAL_AUTH_SCOPE = "standalone";

const PENDING_COUNT_REFETCH_MS = 60_000;

export const approvalRequestQueryKeys = {
  /** Prefix of every approval request query; a decision invalidates all of them at once. */
  all: (apiBaseUrl: string, authScope: string) =>
    ["approval-requests", apiBaseUrl, authScope] as const,
  request: (apiBaseUrl: string, authScope: string, requestId: string) =>
    ["approval-requests", apiBaseUrl, authScope, "request", requestId] as const,
  pendingCount: (apiBaseUrl: string, authScope: string) =>
    ["approval-requests", apiBaseUrl, authScope, "pending-count"] as const
};

/** How one request stands on the page: on its way, absent, failed or there. */
export type ApprovalRequestState =
  | { status: "loading" }
  /** Missing, or not visible to this user: the server does not tell the two apart. */
  | { status: "not-found" }
  | { status: "error"; onRetry(): void }
  | { status: "ready"; request: ApprovalRequestView };

export function approvalRequestState(
  query: Pick<ReturnType<typeof useApprovalRequestQuery>, "data" | "error" | "isError" | "refetch">
): ApprovalRequestState {
  return query.data
    ? { status: "ready", request: query.data }
    : isApprovalRequestNotFound(query.error)
      ? { status: "not-found" }
      : query.isError
        ? { status: "error", onRetry: () => void query.refetch() }
        : { status: "loading" };
}

export function useApprovalRequestQuery(
  input: ApprovalRequestApiInput & { requestId: string; enabled?: boolean }
) {
  return useQuery({
    queryKey: approvalRequestQueryKeys.request(input.apiBaseUrl, input.authScope, input.requestId),
    queryFn: () => input.client.approval_requests.get({ params: { requestId: input.requestId } }),
    enabled: input.enabled ?? true,
    // The card is the live state of a shared request: another approver may
    // have decided while this tab was in the background.
    refetchOnWindowFocus: true,
    retry: (failureCount, error) => !isApprovalRequestNotFound(error) && failureCount < 2
  });
}

export function useApprovalPendingCountQuery(
  input: ApprovalRequestApiInput & { enabled: boolean }
) {
  return useQuery({
    queryKey: approvalRequestQueryKeys.pendingCount(input.apiBaseUrl, input.authScope),
    queryFn: () => input.client.approval_requests.count_pending(),
    enabled: input.enabled,
    // Sessions that may not ask (an embedded token, for example) fail once and
    // are left alone instead of being polled.
    refetchInterval: (query) => (query.state.status === "error" ? false : PENDING_COUNT_REFETCH_MS),
    retry: false
  });
}

export function useApprovalRequestActions(
  input: ApprovalRequestApiInput & {
    requestId: string;
    /** The conversation whose history records what happens to this request. */
    originConversationId: string | undefined;
    /**
     * Called once a decision is stored. Returns true when it started a run in
     * the origin conversation, which then delivers that thread itself.
     */
    onDecided?(decision: ApprovalDecisionInput): boolean;
  }
) {
  const queryClient = useQueryClient();
  const onDecided = useRef(input.onDecided);
  useEffect(() => {
    onDecided.current = input.onDecided;
  });

  // Runs after success and failure alike. A 409 means someone else decided
  // first, and the refetch is what shows their decision on the card.
  const refreshApprovalRequests = () =>
    queryClient.invalidateQueries({
      queryKey: approvalRequestQueryKeys.all(input.apiBaseUrl, input.authScope)
    });

  // Every action appends a decision to the origin conversation. Nothing pushes
  // stored messages to an open thread, so the status line needs this refetch.
  const refreshOriginThread = () => {
    if (input.originConversationId) {
      void queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.thread(
          input.apiBaseUrl,
          input.authScope,
          input.originConversationId
        )
      });
    }
  };
  const refreshAfterAction = () => {
    refreshOriginThread();
    return refreshApprovalRequests();
  };

  const decide = useMutation({
    mutationFn: (decision: ApprovalDecisionInput) =>
      input.client.approval_requests.decide({
        params: { requestId: input.requestId },
        body: decision
      }),
    onSuccess: (_request, decision) => {
      // A started run answers with the whole thread, decision included. A
      // refetch racing that answer could put an older snapshot over it.
      if (!onDecided.current?.(decision)) {
        refreshOriginThread();
      }
    },
    onError: refreshOriginThread,
    onSettled: refreshApprovalRequests
  });
  const withdraw = useMutation({
    mutationFn: () =>
      input.client.approval_requests.withdraw({ params: { requestId: input.requestId } }),
    onSettled: refreshAfterAction
  });
  const revert = useMutation({
    mutationFn: () =>
      input.client.approval_requests.revert({ params: { requestId: input.requestId } }),
    onSettled: refreshAfterAction
  });

  // A lost race on a decision needs no message: the refetched card shows who
  // decided. A refused rollback changes nothing on the card, so it has to say why.
  const failure: ApprovalActionFailure | undefined = revert.error
    ? isApprovalRequestConflict(revert.error)
      ? "revert_conflict"
      : "failed"
    : [decide.error, withdraw.error].some((error) => error && !isApprovalRequestConflict(error))
      ? "failed"
      : undefined;

  return {
    decide: (decision: ApprovalDecisionInput) => decide.mutate(decision),
    withdraw: () => withdraw.mutate(),
    revert: () => revert.mutate(),
    pending: decide.isPending || withdraw.isPending || revert.isPending,
    failure
  };
}

function isApprovalRequestNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === "NOT_FOUND");
}

export function isApprovalRequestConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.code === "CONFLICT");
}
