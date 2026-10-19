import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  ApiError,
  type ApiClient,
  type ApprovalRequestView,
  type OperationInput
} from "@work-shape/catalyst-api-client";
import { workspaceQueryKeys } from "./workspace-query-keys";

export interface ApprovalRequestApiInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
}

export type ApprovalDecisionInput = OperationInput<"approval_requests.decide">["body"];

/**
 * `revert_conflict`: newer changes sit on top of the one that should be undone.
 * `already_decided`: the decision was refused because the request was no longer pending.
 */
export type ApprovalActionFailure = "failed" | "revert_conflict" | "already_decided";

/** Cache dimension of first-party sessions, matching the rest of the workspace queries. */
export const APPROVAL_AUTH_SCOPE = "standalone";

const PENDING_COUNT_REFETCH_MS = 60_000;

/**
 * How often a request whose approved change is still being carried out is asked again, so the
 * final state shows once the change has run.
 */
const SETTLING_REFETCH_MS = 2_000;

/**
 * How long a request is asked at that pace, from when the page first saw its change running. Then,
 * or at once when a read fails, the page stops asking for it, keeps the last state and offers a
 * refresh. It asks at its usual pace again once the change is no longer running.
 */
const SETTLING_MAX_MS = 120_000;

/** The decision is taken and its change still runs: `execution` is `queued`. */
function isSettling(request: ApprovalRequestView | undefined): boolean {
  return request?.status === "approved" && request.applyResult?.execution === "queued";
}

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
  | {
      status: "ready";
      request: ApprovalRequestView;
      /** The change still ran when the page stopped asking: the person asks again. */
      onRefresh?(): void;
    };

export function approvalRequestState(
  query: Pick<
    ReturnType<typeof useApprovalRequestQuery>,
    "data" | "error" | "isError" | "refetch" | "settlingStopped"
  >
): ApprovalRequestState {
  return query.data
    ? {
        status: "ready",
        request: query.data,
        ...(query.settlingStopped ? { onRefresh: () => void query.refetch() } : {})
      }
    : isApprovalRequestNotFound(query.error)
      ? { status: "not-found" }
      : query.isError
        ? { status: "error", onRetry: () => void query.refetch() }
        : { status: "loading" };
}

export function useApprovalRequestQuery(
  input: ApprovalRequestApiInput & {
    requestId: string;
    enabled?: boolean;
    /** Asks again this often while shown. Absent: only when the window gets the focus back. */
    refetchIntervalMs?: number;
  }
) {
  const queryKey = approvalRequestQueryKeys.request(
    input.apiBaseUrl,
    input.authScope,
    input.requestId
  );
  const identity = JSON.stringify(queryKey);
  // When each request was first seen running here; dropped once its change is no longer running.
  const settlingSince = useRef(new Map<string, number>());
  /** Undefined while no change runs; true once this request is no longer asked by itself. */
  const settlingStopped = (data: ApprovalRequestView | undefined, failed: boolean) => {
    if (!isSettling(data)) {
      settlingSince.current.delete(identity);
      return undefined;
    }
    const since = settlingSince.current.get(identity) ?? Date.now();
    settlingSince.current.set(identity, since);
    return failed || Date.now() - since >= SETTLING_MAX_MS;
  };
  const query = useQuery({
    queryKey,
    queryFn: () => input.client.approval_requests.get({ params: { requestId: input.requestId } }),
    enabled: input.enabled ?? true,
    // The card is the live state of a shared request: another approver may
    // have decided while this tab was in the background.
    refetchOnWindowFocus: true,
    // Nothing tells this tab when an approved change has run: a request in the Inbox or in a
    // conversation whose run this tab does not watch asks again soon while the change runs.
    refetchInterval: (query) => {
      const stopped = settlingStopped(query.state.data, query.state.status === "error");
      return stopped === undefined
        ? (input.refetchIntervalMs ?? false)
        : stopped
          ? false
          : SETTLING_REFETCH_MS;
    },
    retry: (failureCount, error) => !isApprovalRequestNotFound(error) && failureCount < 2
  });
  return { ...query, settlingStopped: settlingStopped(query.data, query.isError) === true };
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

  const failure = approvalActionFailure({
    decide: decide.error,
    withdraw: withdraw.error,
    revert: revert.error
  });

  return {
    decide: (decision: ApprovalDecisionInput) => decide.mutate(decision),
    withdraw: () => withdraw.mutate(),
    revert: () => revert.mutate(),
    pending: decide.isPending || withdraw.isPending || revert.isPending,
    failure
  };
}

/**
 * What a failed action has to say. A refused rollback changes nothing on the request, so it says
 * why. A decision that lost the race says so too: the refetched request shows another outcome
 * than the one just clicked. A withdrawal that lost it needs no word: the outcome is on screen.
 */
export function approvalActionFailure(errors: {
  decide: unknown;
  withdraw: unknown;
  revert: unknown;
}): ApprovalActionFailure | undefined {
  if (errors.revert) {
    return isApprovalRequestConflict(errors.revert) ? "revert_conflict" : "failed";
  }
  if (errors.decide && isApprovalRequestConflict(errors.decide)) {
    return "already_decided";
  }
  return errors.decide || (errors.withdraw && !isApprovalRequestConflict(errors.withdraw))
    ? "failed"
    : undefined;
}

function isApprovalRequestNotFound(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 404 || error.code === "NOT_FOUND");
}

function isApprovalRequestConflict(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 409 || error.code === "CONFLICT");
}
