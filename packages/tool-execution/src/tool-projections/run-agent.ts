import {
  AGENTS_RUN_OPERATION,
  AGENT_TOOL_ACTION_PREFIX,
  RUN_AGENT_TOOL_NAME,
  type ToolExecutionRequest,
  type ToolHandlerFailureResult
} from "@work-shape/catalyst-core";
import type { RunOperationDeps } from "../operation-execution";
import { failed } from "../tool-results";
import type { ToolProjection } from "./projection";

/**
 * `run_agent`, the start of a subagent. The runtime keeps the started subagent's call with the
 * run it waits on.
 */
export const runAgentProjection: ToolProjection = {
  toolName: RUN_AGENT_TOOL_NAME,
  project: (request, { context, deps }) => runAgentRequest(request, context, deps),
  operationEffect: (operation) => (operation === AGENTS_RUN_OPERATION ? "changing" : undefined),
  answered: (request, answer, result) =>
    request.toolName === AGENTS_RUN_OPERATION &&
    answer.status === "success" &&
    result.status === "done"
      ? { ...answer, privateOutput: { operationRunId: result.runId } }
      : answer
};

/**
 * A call of `run_agent` as the call of `agents.run` (CR-1). The agent's own list is asked
 * first, as for the knowledge tool. A subagent is never offered `run_agent`, and one whose
 * model calls it all the same is refused here. The call's key is its run and its tool call,
 * so a retried call answers the subagent it started.
 */
async function runAgentRequest(
  request: ToolExecutionRequest,
  context: { subagent?: true },
  deps: RunOperationDeps
): Promise<
  { request: ToolExecutionRequest; idempotencyKey: string } | { refusal: ToolHandlerFailureResult }
> {
  if (context.subagent) {
    return { refusal: failed("not_allowed", "A subagent cannot start subagents of its own.") };
  }
  const listed = (await deps.agentToolNames?.(request.agentName, request.conversationId)) ?? [];
  if (!listed.includes(AGENTS_RUN_OPERATION)) {
    const action = `${AGENT_TOOL_ACTION_PREFIX}${RUN_AGENT_TOOL_NAME}`;
    return {
      refusal: failed(
        "not_allowed",
        `Agent '${request.agentName}' is not allowed to use '${RUN_AGENT_TOOL_NAME}'`,
        { action }
      )
    };
  }
  return {
    request: { ...request, toolName: AGENTS_RUN_OPERATION },
    idempotencyKey: `${request.agentRunId}:${request.toolCallId}`
  };
}
