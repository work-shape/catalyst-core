import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { completedOutput, type ApiClient, type OwnFeedback } from "@work-shape/catalyst-api-client";

// The person's own feedback in one conversation (LU-4): one comment per answer, read once per
// conversation for every answer of it, and changed by its author until a reviewer handled it.

interface OwnFeedbackInput {
  apiBaseUrl: string;
  /** Absent outside a workspace's client, where nothing is read or changed. */
  client: ApiClient | undefined;
  conversationId: string;
}

function requireClient(client: ApiClient | undefined): ApiClient {
  if (!client) throw new Error("Feedback is read and sent within a workspace");
  return client;
}

function ownFeedbackKey(apiBaseUrl: string, conversationId: string) {
  return ["feedback", "own", apiBaseUrl, conversationId] as const;
}

/** The person's comments in the conversation, by the run whose answer each is about. */
export function useOwnFeedbackQuery(input: OwnFeedbackInput & { enabled: boolean }) {
  return useQuery({
    queryKey: ownFeedbackKey(input.apiBaseUrl, input.conversationId),
    queryFn: async () => {
      const { items } = await requireClient(input.client).feedback.list_own({
        params: { conversationId: input.conversationId }
      });
      return new Map(
        items.flatMap((item): [string, OwnFeedback][] =>
          item.agentRunId ? [[item.agentRunId, item]] : []
        )
      );
    },
    enabled: input.enabled && input.client !== undefined,
    staleTime: 60_000
  });
}

/** Sending, changing and withdrawing one's own comment. Each reads the list again after. */
export function useOwnFeedbackMutations(input: OwnFeedbackInput & { heldMessage: string }) {
  const queryClient = useQueryClient();
  const params = { conversationId: input.conversationId };
  const settle = () =>
    queryClient.invalidateQueries({
      queryKey: ownFeedbackKey(input.apiBaseUrl, input.conversationId)
    });
  const send = useMutation({
    mutationFn: async (body: { runId: string; text: string; includeExchange: boolean }) =>
      completedOutput(
        await requireClient(input.client).feedback.send({ params, body }),
        input.heldMessage
      ),
    onSettled: settle
  });
  const update = useMutation({
    mutationFn: async (change: { feedbackId: string; text: string; includeExchange: boolean }) =>
      completedOutput(
        await requireClient(input.client).feedback.update({
          params: { ...params, feedbackId: change.feedbackId },
          body: { text: change.text, includeExchange: change.includeExchange }
        }),
        input.heldMessage
      ),
    onSettled: settle
  });
  const withdraw = useMutation({
    mutationFn: async (feedbackId: string) =>
      completedOutput(
        await requireClient(input.client).feedback.withdraw({ params: { ...params, feedbackId } }),
        input.heldMessage
      ),
    onSettled: settle
  });
  return { send, update, withdraw };
}
