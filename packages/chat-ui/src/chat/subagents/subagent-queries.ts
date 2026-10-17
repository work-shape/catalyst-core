import { useCallback, useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useWorkspaceThreadQuery } from "../../shared/api/workspace-queries";
import { workspaceQueryKeys } from "../../shared/api/workspace-query-keys";
import { isTerminalObservation } from "../conversation/conversation-controller-state";
import { WORKSPACE_AUTH_SCOPE } from "../workspace/workspace-chat-state";

/**
 * The subagents of a conversation (CR-1). The list stands under the conversation's Resources,
 * so a call that refreshes them, as a started subagent does, refreshes it too.
 */
export function useSubagentsQuery(input: { conversationId: string | undefined; enabled: boolean }) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useQuery({
    queryKey: workspaceQueryKeys.conversationSubagents(
      apiBaseUrl,
      WORKSPACE_AUTH_SCOPE,
      input.conversationId
    ),
    queryFn: async () =>
      (
        await client.conversations.subagents.list({
          params: { conversationId: input.conversationId ?? "" }
        })
      ).items,
    enabled: input.enabled && Boolean(input.conversationId)
  });
}

/** Reads a conversation's Resources and its subagents again: one of them changed. */
export function useRefreshSubagents(): (conversationId: string) => void {
  const { apiBaseUrl } = useWorkspaceApiClient();
  const queryClient = useQueryClient();
  return useCallback(
    (conversationId: string) => {
      queryClient
        .invalidateQueries({
          queryKey: workspaceQueryKeys.conversationResources(
            apiBaseUrl,
            WORKSPACE_AUTH_SCOPE,
            conversationId
          )
        })
        .catch(() => undefined);
    },
    [apiBaseUrl, queryClient]
  );
}

/**
 * Follows a running subagent on its own stream, from where its thread stands, and reads the
 * conversation's subagents again when it ends. Its card and its row then show how it ended.
 */
export function useFollowSubagent(input: {
  rootConversationId: string | undefined;
  threadId: string | undefined;
  runId: string | undefined;
  active: boolean;
}): void {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const queryClient = useQueryClient();
  const refreshSubagents = useRefreshSubagents();
  const { rootConversationId, threadId, runId, active } = input;
  const thread = useWorkspaceThreadQuery({
    apiBaseUrl,
    authScope: WORKSPACE_AUTH_SCOPE,
    client,
    conversationId: threadId,
    enabled: active && Boolean(threadId)
  });
  const snapshot = thread.data?.conversation.id === threadId ? thread.data : undefined;
  const after =
    snapshot?.activeRun?.run.id === runId
      ? snapshot?.activeRun?.projection.lastSequence
      : undefined;
  const endedBeforeRead = active && snapshot !== undefined && after === undefined;

  useEffect(() => {
    if (endedBeforeRead && rootConversationId) refreshSubagents(rootConversationId);
  }, [endedBeforeRead, refreshSubagents, rootConversationId]);

  useEffect(() => {
    if (!active || !threadId || !runId || !rootConversationId || after === undefined) {
      return undefined;
    }
    // The card and the panel's row of a subagent follow it on one stream.
    const following = followedSubagents.get(runId);
    if (following) {
      following.followers += 1;
    } else {
      const abort = new AbortController();
      followedSubagents.set(runId, { followers: 1, abort });
      (async () => {
        try {
          for await (const observation of client.conversations.runs.observe({
            params: { conversationId: threadId, runId },
            query: { after: String(after) },
            signal: abort.signal
          })) {
            if (isTerminalObservation(observation)) {
              refreshSubagents(rootConversationId);
              queryClient
                .invalidateQueries({
                  queryKey: workspaceQueryKeys.thread(apiBaseUrl, WORKSPACE_AUTH_SCOPE, threadId)
                })
                .catch(() => undefined);
              return;
            }
          }
        } catch {
          // A stream that breaks leaves the card as it was; the parent's next step reads the
          // subagents again when it answers the call.
        }
      })().catch(() => undefined);
    }
    return () => {
      const current = followedSubagents.get(runId);
      if (!current) return;
      current.followers -= 1;
      if (current.followers === 0) {
        current.abort.abort();
        followedSubagents.delete(runId);
      }
    };
  }, [
    active,
    after,
    apiBaseUrl,
    client,
    queryClient,
    refreshSubagents,
    rootConversationId,
    runId,
    threadId
  ]);
}

/** The subagents followed on their streams now, by run, with how many views follow each. */
const followedSubagents = new Map<string, { followers: number; abort: AbortController }>();

/** Stops one subagent through its thread's cancel route. The parent goes on without it. */
export function useStopSubagent(rootConversationId: string | undefined) {
  const { client } = useWorkspaceApiClient();
  const refreshSubagents = useRefreshSubagents();
  return useMutation({
    mutationFn: (subagent: { threadId: string; runId: string }) =>
      client.conversations.runs.cancel({
        params: { conversationId: subagent.threadId, runId: subagent.runId },
        body: { reason: "user_requested" }
      }),
    onSettled: () => {
      if (rootConversationId) refreshSubagents(rootConversationId);
    }
  });
}
