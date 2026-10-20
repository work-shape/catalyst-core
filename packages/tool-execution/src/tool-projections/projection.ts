import type {
  OperationCallRuntime,
  OperationEffect,
  OperationResult,
  RuntimeCallContext,
  ToolDecisionWait,
  ToolExecutionRequest,
  ToolExecutionResult,
  ToolHandlerFailureResult,
  ToolOperationRunner
} from "@work-shape/catalyst-core";
import type { RunOperationDeps } from "../operation-execution";

/**
 * What a tool's projection makes of a call: an answer it reached itself, by calls of this
 * runner; the call of the operation the tool stands for, with its key where a retry must
 * answer the same run; or a refusal before any run.
 */
export type ProjectedCall =
  | { answer: ToolExecutionResult | ToolDecisionWait }
  | { request: ToolExecutionRequest; idempotencyKey?: string }
  | { refusal: ToolHandlerFailureResult };

/** What a projection is handed with the call. */
interface ProjectionRun {
  context: RuntimeCallContext;
  options: Pick<OperationCallRuntime, "unreadableInput">;
  deps: RunOperationDeps;
  /** The runner itself, for a projection that answers by several calls of it. */
  runner: ToolOperationRunner;
  /** Numbers the sources a Knowledge Base search cites, across the calls of one agent run. */
  takeKnowledgeRefs(runId: ToolExecutionRequest["agentRunId"], count: number): number;
}

/**
 * A tool an agent calls that is not itself the operation it runs: its call is projected onto
 * another operation, or answered by several calls. One file per tool under
 * `tool-projections/`, listed once in `TOOL_PROJECTIONS`.
 */
export interface ToolProjection {
  /** The tool the agent calls. */
  toolName: string;
  project(request: ToolExecutionRequest, run: ProjectionRun): Promise<ProjectedCall>;
  /**
   * The effect of an operation this projection calls, which no tool registers, or nothing for
   * any other operation.
   */
  operationEffect?(operation: string): OperationEffect | undefined;
  /** The answer of the projected call once it ran, where the projection adds to it. */
  answered?(
    request: ToolExecutionRequest,
    answer: ToolExecutionResult,
    result: OperationResult
  ): ToolExecutionResult;
}
