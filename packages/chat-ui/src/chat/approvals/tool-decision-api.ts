import { useMutation, useQuery } from "@tanstack/react-query";
import type { OperationInput } from "@work-shape/catalyst-api-client";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useEmbeddedSession } from "../../shared/embedded-session";
import { APPROVAL_AUTH_SCOPE } from "../../shared/api/approval-request-api";
import { toolDecisionFailure } from "./tool-decision-model";

export type ToolDecisionInput = OperationInput<"operations.decide">["body"];

/**
 * Answers a call that waits for the person's confirmation (`operations.decide`). The card shows
 * the answer as soon as it is taken; the run's observations then carry it to every open tab.
 */
export function useToolDecisionDecide(operationRunId: string) {
  const { client } = useWorkspaceApiClient();
  const mutation = useMutation({
    mutationFn: (decision: ToolDecisionInput) =>
      client.operations.decide({ params: { runId: operationRunId }, body: decision })
  });
  return {
    decide: (decision: ToolDecisionInput) => mutation.mutate(decision),
    pending: mutation.isPending,
    /** The answer the server took, until the run's own record of it arrives. */
    decided: mutation.isSuccess ? mutation.variables : undefined,
    failure: toolDecisionFailure(mutation.error)
  };
}

/**
 * The Inbox request a call waits on, read from its Operation Run: it names the item a
 * confirmation leads to and the request an approval card shows. An embedding host's session
 * reads neither the run (`governance:read`) nor the Inbox, which are the person's own, so it
 * asks for nothing and the card answers in the conversation, as `operations.decide` allows.
 */
export function useWaitingOperationRunQuery(operationRunId: string): {
  approvalRequestId: string | undefined;
  /** The run's answer is still awaited: the card holds its buttons until it knows. */
  held: boolean;
} {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const embedded = useEmbeddedSession();
  const run = useQuery({
    queryKey: ["operation-runs", apiBaseUrl, APPROVAL_AUTH_SCOPE, operationRunId] as const,
    queryFn: () => client.operations.get_run({ params: { runId: operationRunId } }),
    enabled: !embedded,
    retry: 1
  });
  return {
    approvalRequestId: embedded ? undefined : run.data?.approvalRequestId,
    held: !embedded && run.isPending
  };
}
