import { useMutation, useQuery } from "@tanstack/react-query";
import type { OperationInput } from "@work-shape/catalyst-api-client";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
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
 * The Operation Run of a call that waits for somebody's approval: it names the request the
 * approval card shows.
 */
export function useWaitingOperationRunQuery(operationRunId: string) {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  return useQuery({
    queryKey: ["operation-runs", apiBaseUrl, APPROVAL_AUTH_SCOPE, operationRunId] as const,
    queryFn: () => client.operations.get_run({ params: { runId: operationRunId } }),
    retry: 1
  });
}
