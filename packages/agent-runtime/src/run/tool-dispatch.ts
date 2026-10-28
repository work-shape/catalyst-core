import { WEB_FETCH_TOOL_NAME } from "@work-shape/catalyst-web-access";
import {
  ASK_QUESTION_TOOL_NAME,
  DATA_STORE_USE_TOOL_NAME,
  WORKSPACE_OPEN_TOOL_NAME,
  forbiddenPreviewTool,
  isFileSetId,
  parseConnectionOperationName,
  type FileSetId
} from "@work-shape/catalyst-core";
import type {
  AgentRunId,
  ChatMessage,
  RuntimeCallContext,
  StartAgentRunInput,
  StartedSubagent,
  ToolDecisionWait,
  ToolExecutionError,
  ToolExecutionResult
} from "@work-shape/catalyst-core";
import type { ModelMessage, ModelToolCall } from "@work-shape/catalyst-model-provider";
import { executeToolCall } from "../tool-call-execution";
import { isUnofferedDataToolCall } from "../model-tool-materialization";
import {
  createToolResultMetadata,
  stableStringify,
  TOOL_RESULT_READ_TOOL_NAME,
  type ModelOutputProjection
} from "../model-context-projection";
import type { RunState } from "../run-state";
import { isCancellationRequested } from "./run-events";
import type { ModelInput } from "./model-input";
import type { RunEvents } from "./run-events";
import type { LocalAgentRuntimeOptions } from "./run-events";
import { isRunAgentCall, stepLimitRefusal } from "./subagents";
import { createToolResultReader } from "./tool-result-read";

const DEFAULT_REPEATED_TOOL_CALL_LIMIT = 3;

/**
 * How the calls of one step went: all through, the run stopped, or a call waits for a
 * decision. Calls run in order, so the calls after a waiting one have not started (S7). A
 * `run_agent` call that started its subagent is not answered here: it is in `subagents`, and
 * answered once the step's calls are through and its subagent ended.
 */
export type ToolDispatchOutcome =
  | {
      kind: "answered";
      subagents: StartedSubagent[];
      opened: OpenedPreview[];
      /**
       * A call of the step asked the person a question, or waits for their click on a card
       * (`data_store.use`): the turn ends with the step (ASK-1, STORE-USE-1).
       */
      asked: boolean;
      /**
       * A call of the step added a Data Store to the conversation: the run reads its tool offer
       * again before its next model request, so the store's read tools arrive in this turn.
       */
      offerChanged: boolean;
    }
  | { kind: "stopped" }
  | {
      kind: "paused";
      toolCall: ModelToolCall;
      waiting: ToolDecisionWait;
      /** The calls this dispatch answered before the waiting one. */
      answeredToolCallIds: string[];
      subagents: StartedSubagent[];
    };

/** A revision a `workspace.open` call of the step showed in the preview, by its result. */
export interface OpenedPreview {
  toolCallId: string;
  fileSetId: FileSetId;
  number?: number;
}

/** What a successful `data_store.use` came to: added at once, or waiting for the person. */
function storeUse(
  toolCall: ModelToolCall,
  result: ToolExecutionResult
): "added" | "awaits_person" | undefined {
  if (toolCall.toolName !== DATA_STORE_USE_TOOL_NAME || result.status !== "success") return;
  const output = result.output;
  if (typeof output !== "object" || output === null) return;
  if ("awaitsPerson" in output && output.awaitsPerson === true) return "awaits_person";
  return "added" in output && output.added === true ? "added" : undefined;
}

/** The revision a call opened in the preview, when it was a `workspace.open` that showed one. */
function openedPreview(
  toolCall: ModelToolCall,
  result: ToolExecutionResult
): OpenedPreview | undefined {
  if (toolCall.toolName !== WORKSPACE_OPEN_TOOL_NAME || result.status !== "success") return;
  const output = result.output;
  if (typeof output !== "object" || output === null) return;
  const fileSetId = "fileSetId" in output ? output.fileSetId : undefined;
  const number = "number" in output ? output.number : undefined;
  if (typeof fileSetId !== "string" || !isFileSetId(fileSetId)) return;
  return {
    toolCallId: toolCall.toolCallId,
    fileSetId,
    ...(typeof number === "number" ? { number } : {})
  };
}

export class ToolDispatch {
  constructor(
    private readonly options: LocalAgentRuntimeOptions,
    private readonly modelInput: ModelInput,
    private readonly runEvents: RunEvents
  ) {}

  async dispatchToolCalls(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    state: RunState,
    toolCalls: ModelToolCall[],
    repeatedToolCalls: Map<string, number>,
    messages: ModelMessage[],
    /** The data tools the run was offered when it started. A call of another one is refused. */
    offeredDataTools: ReadonlySet<string>,
    /** The subagents the step started before these calls, which count to the step's limit. */
    startedInStep = 0
  ): Promise<ToolDispatchOutcome> {
    const answeredToolCallIds: string[] = [];
    const subagents: StartedSubagent[] = [];
    const opened: OpenedPreview[] = [];
    let asked = false;
    let offerChanged = false;
    for (const toolCall of toolCalls) {
      if (context.signal?.aborted) return { kind: "stopped" };
      const webRefusal = await this.webFetchRefusal(runId, toolCall.toolName, state, input);
      const refusal =
        webRefusal ??
        (isRunAgentCall(toolCall.toolName)
          ? stepLimitRefusal(startedInStep + subagents.length)
          : undefined);
      const result = await executeToolCall({
        runId,
        startInput: input,
        context,
        state,
        toolCall,
        // A cut result is read from the run's own conversation, not run as an operation.
        runTool:
          toolCall.toolName === TOOL_RESULT_READ_TOOL_NAME
            ? createToolResultReader(
                this.options.conversationHistory,
                this.modelInput.modelContextOptions(context)
              )
            : this.options.runTool,
        offeredDataToolNames: [...offeredDataTools],
        unoffered:
          isUnofferedDataToolCall(toolCall.toolName, offeredDataTools) ||
          Boolean(input.preview && forbiddenPreviewTool(toolCall.toolName)),
        ...(refusal ? { refusal } : {}),
        modelContext: this.modelInput.modelContextOptions(context),
        repeatedToolCall: this.registerToolCall(
          repeatedToolCalls,
          toolCall.input,
          toolCall.toolName
        ),
        beforeDispatch: async () => {
          await this.runEvents.beforeEffect("tool_dispatch", runId);
          await this.beforePersonalCall(toolCall.toolName, state);
        }
      });
      if (isCancellationRequested(state.getStatus())) {
        return { kind: "stopped" };
      }
      if ("waiting" in result) {
        return {
          kind: "paused",
          toolCall,
          waiting: result.waiting,
          answeredToolCallIds,
          subagents
        };
      }
      if ("subagent" in result) {
        subagents.push(result.subagent);
        continue;
      }
      await this.answerToolCall(runId, input, context, toolCall, result, messages);
      answeredToolCallIds.push(toolCall.toolCallId);
      const preview = openedPreview(toolCall, result.result);
      if (preview) opened.push(preview);
      if (toolCall.toolName === ASK_QUESTION_TOOL_NAME && result.result.status === "success") {
        asked = true;
      }
      const used = storeUse(toolCall, result.result);
      if (used === "awaits_person") asked = true;
      if (used === "added") offerChanged = true;
    }
    return { kind: "answered", subagents, opened, asked, offerChanged };
  }

  async webFetchRefusal(
    runId: AgentRunId,
    toolName: string,
    state: RunState,
    input: StartAgentRunInput
  ): Promise<ToolExecutionError | undefined> {
    return toolName === WEB_FETCH_TOOL_NAME &&
      (await this.modelInput.webAccessOff(runId, state, input))
      ? {
          code: "not_allowed",
          message:
            "Web access is off in this conversation because it holds data from a personal connection"
        }
      : undefined;
  }

  /** Set before dispatch, independent of validation, authorization or the call's outcome. */
  async beforePersonalCall(toolName: string, state: RunState): Promise<void> {
    if (
      parseConnectionOperationName(toolName) &&
      (await this.options.personalData?.operations.resolve(toolName))?.personalConnection
    ) {
      state.disableWebAccess();
    }
  }

  /** Stores what a call came to and hands it to the model with the next request. */
  async answerToolCall(
    runId: AgentRunId,
    input: StartAgentRunInput,
    context: RuntimeCallContext,
    toolCall: ModelToolCall,
    answer: { result: ToolExecutionResult; modelOutput: ModelOutputProjection },
    messages: ModelMessage[]
  ): Promise<void> {
    await this.runEvents.beforeEffect("tool_result_message", runId);
    await this.persistToolResult({
      runId,
      input,
      context,
      toolCall,
      result: answer.result,
      modelOutput: answer.modelOutput
    });
    messages.push({
      role: "tool",
      toolCallId: toolCall.toolCallId,
      content: answer.modelOutput.content
    });
  }

  private async persistToolResult(input: {
    runId: AgentRunId;
    input: StartAgentRunInput;
    context: RuntimeCallContext;
    toolCall: ModelToolCall;
    result: ToolExecutionResult;
    modelOutput: ModelOutputProjection;
  }): Promise<ChatMessage> {
    return this.options.conversationHistory.appendMessage({
      clientInstanceId: input.context.clientInstanceId,
      conversationId: input.input.conversationId,
      role: "tool",
      text: input.modelOutput.text,
      metadata: createToolResultMetadata({
        runId: input.runId,
        toolCall: input.toolCall,
        result: input.result,
        modelOutput: input.modelOutput
      })
    });
  }

  private registerToolCall(
    calls: Map<string, number>,
    toolInput: unknown,
    toolName: string
  ): { repeated: boolean; count: number; limit: number } {
    const key = `${toolName}:${stableStringify(toolInput)}`;
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    const limit = this.options.repeatedToolCallLimit ?? DEFAULT_REPEATED_TOOL_CALL_LIMIT;
    return {
      repeated: count > limit,
      count,
      limit
    };
  }
}
