import {
  AppError,
  RUN_AGENT_TOOL_NAME,
  SUBAGENTS_PER_STEP,
  asAgentRunId,
  asConversationId,
  isOperationRunId,
  asToolCallId,
  type AgentRunId,
  type ChildAgentRunStore,
  type RunAgentResult,
  type RuntimeCallContext,
  type StartedSubagent,
  type SubagentStarted,
  type ToolExecutionError,
  type ToolExecutionResult
} from "@work-shape/catalyst-core";

// The subagents of a run's step (CR-1): a `run_agent` call that started its subagent is not
// answered at once. The run keeps it, goes on with the step and, once the step's calls are
// through, answers each such call with how its subagent ended, or waits for them.

/** What the runtime reads of a run's subagents. */
export type SubagentOutcomeReader = Pick<ChildAgentRunStore, "readSubagentOutcomes">;

export function isRunAgentCall(toolName: string): boolean {
  return toolName === RUN_AGENT_TOOL_NAME;
}

/** The refusal of a `run_agent` call beyond the step's limit; it starts nothing. */
export function stepLimitRefusal(startedInStep: number): ToolExecutionError | undefined {
  return startedInStep >= SUBAGENTS_PER_STEP
    ? {
        code: "subagent_limit",
        message: `This step started ${SUBAGENTS_PER_STEP} subagents, as many as one step may. Start more in the next step, or do the rest yourself.`
      }
    : undefined;
}

/**
 * The subagent a successful call of `agents.run` started: its output names the child, and
 * the Operation Run of the call comes with it or, for a decided call, from the decision.
 */
export function startedSubagentOf(
  toolCallId: string,
  result: ToolExecutionResult,
  decidedOperationRunId?: string
): { started: StartedSubagent; event: SubagentStarted } | undefined {
  if (result.status !== "success") return undefined;
  const { output, privateOutput } = result;
  if (typeof output !== "object" || output === null) return undefined;
  if (!("runId" in output) || !("threadId" in output)) return undefined;
  if (!("agent" in output) || !("description" in output)) return undefined;
  const { runId, threadId, agent, description } = output;
  if (typeof runId !== "string" || typeof threadId !== "string") return undefined;
  if (typeof agent !== "string" || typeof description !== "string") return undefined;
  const operationRunId =
    decidedOperationRunId ??
    (typeof privateOutput === "object" &&
    privateOutput !== null &&
    "operationRunId" in privateOutput &&
    typeof privateOutput.operationRunId === "string"
      ? privateOutput.operationRunId
      : undefined);
  if (!operationRunId || !isOperationRunId(operationRunId)) return undefined;
  return {
    started: { toolCallId, operationRunId, runId: asAgentRunId(runId) },
    event: {
      toolCallId: asToolCallId(toolCallId),
      subagentRunId: asAgentRunId(runId),
      threadId: asConversationId(threadId),
      agent,
      description
    }
  };
}

/**
 * How each subagent of the step ended, in call order, or `waiting` while one has not ended.
 * The answers are what the parent's model reads as the results of its `run_agent` calls.
 */
export async function readSubagentAnswers(
  reader: SubagentOutcomeReader | undefined,
  parentRunId: AgentRunId,
  context: RuntimeCallContext,
  subagents: readonly StartedSubagent[]
): Promise<{ kind: "waiting" } | { kind: "ended"; results: ToolExecutionResult[] }> {
  if (!reader) throw new AppError("INTERNAL", "This runtime cannot read the subagents of a run");
  const outcomes = await reader.readSubagentOutcomes({
    clientInstanceId: context.clientInstanceId,
    parentRunId,
    runIds: subagents.map((subagent) => subagent.runId)
  });
  const results: ToolExecutionResult[] = [];
  for (const outcome of outcomes) {
    if (outcome.status === "open") return { kind: "waiting" };
    const answer: RunAgentResult = outcome;
    results.push({ status: "success", output: answer });
  }
  return { kind: "ended", results };
}
