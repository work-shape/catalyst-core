import {
  AppError,
  asToolCallId,
  readAgentRuntimeMessageMetadata,
  type AgentRunId,
  type AgentRunResumeState,
  type ChatMessage,
  type ConversationHistoryStore,
  type ModelProviderConfig,
  type PausedToolCall,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type ToolDecisionRunner
} from "@work-shape/catalyst-core";
import type { ModelMessage, ModelToolCall } from "@work-shape/catalyst-model-provider";
import { projectRunOwnMessages } from "../model-context-projection";
import type { RunState } from "../run-state";
import { emitToolCallEnd } from "../tool-call-execution";
import type { ModelInput } from "./model-input";
import type { ToolDispatch, ToolDispatchOutcome } from "./tool-dispatch";

// Where a run that waited for a decision goes on (EW-2a): the model's input as it was when the
// run paused, and the rest of the paused step's calls.

/**
 * The one boundary of a resumed run's model input: the conversation's history up to the run's
 * input message and that message, as the run started with them, then the messages the run
 * wrote itself after it. A run whose answer compacted the context starts at the step message
 * of that answer instead, as it did while it worked. Nothing another run or person wrote
 * after the input message is part of it.
 */
export async function resumedModelMessages(input: {
  runId: AgentRunId;
  startInput: StartAgentRunInput;
  context: RuntimeCallContext;
  resume: AgentRunResumeState;
  modelInput: ModelInput;
  conversationHistory: Pick<ConversationHistoryStore, "listMessages">;
  provider: ModelProviderConfig;
  compactionEnabled: boolean;
  systemMessage: ModelMessage;
  userMessage: ModelMessage;
}): Promise<ModelMessage[]> {
  const { context, startInput, resume } = input;
  const persisted = await input.conversationHistory.listMessages({
    clientInstanceId: context.clientInstanceId,
    conversationId: startInput.conversationId
  });
  const inputIndex = persisted.findIndex((message) => message.id === startInput.inputMessageId);
  if (inputIndex < 0) {
    throw new AppError("NOT_FOUND", "Agent run input message is not available");
  }
  const own = persisted.slice(inputIndex + 1).filter((message) => runIdOf(message) === input.runId);
  const options = {
    ...input.modelInput.modelContextOptions(context),
    // The paused step's calls as the model wrote them, a call whose input could not be read
    // included: the stored message keeps only what it can show.
    stepToolCalls: {
      messageId: resume.stepMessageId,
      toolCalls: resume.toolCalls.map(toModelToolCall)
    }
  };
  const from = resume.modelInputFrom;
  if (from.kind === "message") {
    const start = own.findIndex((message) => message.id === from.messageId);
    if (start < 0) {
      throw new AppError("NOT_FOUND", "The step a resumed run goes on from is not available");
    }
    return [input.systemMessage, ...(await projectRunOwnMessages(own.slice(start), options))];
  }
  const history = await input.modelInput.loadModelHistory(startInput, context, input.provider, {
    compactionEnabled: input.compactionEnabled
  });
  return [
    input.systemMessage,
    ...history.messages,
    input.userMessage,
    ...(await projectRunOwnMessages(own, options))
  ];
}

function runIdOf(message: ChatMessage): string | undefined {
  const runtime = readAgentRuntimeMessageMetadata(message.metadata);
  return runtime?.kind === "assistant_tool_calls" || runtime?.kind === "tool_result"
    ? runtime.runId
    : undefined;
}

function toModelToolCall(call: PausedToolCall): ModelToolCall {
  return {
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    input: call.input,
    ...(call.inputParseError ? { inputParseError: call.inputParseError } : {})
  };
}

/**
 * Answers the decided calls of the paused step and runs the calls after them, as the step
 * would have. A confirmed call is executed once through `runDecidedTool`, keyed by its
 * Operation Run; a declined one is answered with the person's reason. Its start was emitted
 * before the pause, so only its end is emitted now.
 */
export async function finishPausedStep(input: {
  runId: AgentRunId;
  startInput: StartAgentRunInput;
  context: RuntimeCallContext;
  state: RunState;
  resume: AgentRunResumeState;
  runDecidedTool: ToolDecisionRunner | undefined;
  modelInput: ModelInput;
  toolDispatch: ToolDispatch;
  repeatedToolCalls: Map<string, number>;
  messages: ModelMessage[];
  offeredDataTools: ReadonlySet<string>;
}): Promise<ToolDispatchOutcome & { answeredToolCallIds: string[] }> {
  const { resume, context, state } = input;
  const answered = new Set(resume.doneToolCallIds);
  const answeredNow: string[] = [];
  const pending = resume.toolCalls.filter((call) => !answered.has(call.toolCallId));
  let next = 0;
  for (const call of pending) {
    const waited = resume.waiting.find((entry) => entry.toolCallId === call.toolCallId);
    if (!waited) break;
    if (!input.runDecidedTool) {
      throw new AppError("INTERNAL", "This runtime cannot carry out a decided call");
    }
    if (context.signal?.aborted) return { kind: "stopped", answeredToolCallIds: answeredNow };
    const toolCall = toModelToolCall(call);
    const result = await input.runDecidedTool(
      {
        request: {
          toolName: call.toolName,
          toolCallId: asToolCallId(call.toolCallId),
          agentRunId: input.runId,
          conversationId: input.startInput.conversationId,
          agentName: input.startInput.agentName,
          input: call.input
        },
        operationRunId: waited.operationRunId,
        frozenInput: waited.frozenInput
      },
      context
    );
    const answer = await emitToolCallEnd(
      {
        modelContext: input.modelInput.modelContextOptions(context),
        runId: input.runId,
        startInput: input.startInput,
        state,
        toolCall
      },
      result
    );
    await input.toolDispatch.answerToolCall(
      input.runId,
      input.startInput,
      context,
      toolCall,
      answer,
      input.messages
    );
    answeredNow.push(call.toolCallId);
    next += 1;
  }
  const rest = pending.slice(next).map(toModelToolCall);
  if (rest.length === 0) return { kind: "answered", answeredToolCallIds: answeredNow };
  const outcome = await input.toolDispatch.dispatchToolCalls(
    input.runId,
    input.startInput,
    context,
    state,
    rest,
    input.repeatedToolCalls,
    input.messages,
    input.offeredDataTools
  );
  return outcome.kind === "paused"
    ? {
        ...outcome,
        answeredToolCallIds: [...answeredNow, ...outcome.answeredToolCallIds]
      }
    : { ...outcome, answeredToolCallIds: answeredNow };
}

/** Ends this execution of the run at the call that waits, keeping what it goes on from. */
export function pauseRun(
  state: RunState,
  paused: Extract<ToolDispatchOutcome, { kind: "paused" }>,
  resume: Omit<AgentRunResumeState, "version" | "waiting">
): void {
  const { toolCall, waiting } = paused;
  state.waitForDecision(
    {
      toolCallId: asToolCallId(toolCall.toolCallId),
      toolName: toolCall.toolName,
      operationRunId: waiting.operationRunId,
      operationId: waiting.operationId,
      mode: waiting.mode,
      inputPreview: waiting.frozenInput,
      expiresAt: waiting.expiresAt
    },
    {
      version: 1,
      ...resume,
      waiting: [
        {
          toolCallId: toolCall.toolCallId,
          operationRunId: waiting.operationRunId,
          frozenInput: waiting.frozenInput
        }
      ]
    }
  );
}
