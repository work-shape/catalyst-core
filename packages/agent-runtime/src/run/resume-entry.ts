import {
  AppError,
  asToolCallId,
  readAgentRuntimeMessageMetadata,
  readUserMessageMetadata,
  type AgentRunId,
  type AgentRunResumeState,
  type ChatMessage,
  type ConversationHistoryStore,
  type ModelProviderConfig,
  type PausedToolCall,
  type RuntimeCallContext,
  type StartAgentRunInput,
  type StartedSubagent,
  type ToolDecisionRunner
} from "@work-shape/catalyst-core";
import type { ModelMessage, ModelToolCall } from "@work-shape/catalyst-model-provider";
import { projectRunOwnMessages } from "../model-context-projection";
import type { RunState } from "../run-state";
import { emitToolCallEnd } from "../tool-call-execution";
import type { ModelInput } from "./model-input";
import type { ToolDispatch, ToolDispatchOutcome } from "./tool-dispatch";
import {
  isRunAgentCall,
  readSubagentAnswers,
  startedSubagentOf,
  type SubagentOutcomeReader
} from "./subagents";

// Where a run that waited for a decision goes on (EW-2a): the model's input as it was when the
// run paused, and the rest of the paused step's calls.

/**
 * The one boundary of a resumed run's model input: the conversation's history up to the run's
 * input message and that message, as the run started with them, then the messages the run
 * wrote itself after it. A run whose answer compacted the context starts at the step message
 * of that answer instead, as it did while it worked. Nothing another run or person wrote
 * after the input message is part of it, except the steers the run itself took in.
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

/** The run a row belongs to: its own steps and results, and the steers it took in (FU-2). */
function runIdOf(message: ChatMessage): string | undefined {
  if (message.role === "user") {
    return readUserMessageMetadata(message.metadata)?.steered?.runId;
  }
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
  // A call that started its subagent is answered once the step's calls are through.
  const startedBefore = resume.subagents ?? [];
  const started = new Set(startedBefore.map((subagent) => subagent.toolCallId));
  const answeredNow: string[] = [];
  const subagents: StartedSubagent[] = [];
  const pending = resume.toolCalls.filter(
    (call) => !answered.has(call.toolCallId) && !started.has(call.toolCallId)
  );
  let next = 0;
  for (const call of pending) {
    const waited = resume.waiting.find((entry) => entry.toolCallId === call.toolCallId);
    if (!waited) break;
    if (!input.runDecidedTool) {
      throw new AppError("INTERNAL", "This runtime cannot carry out a decided call");
    }
    if (context.signal?.aborted) return { kind: "stopped", answeredToolCallIds: answeredNow };
    const toolCall = toModelToolCall(call);
    await input.toolDispatch.beforePersonalCall(call.toolName, state);
    const refusal = await input.toolDispatch.webFetchRefusal(
      input.runId,
      call.toolName,
      state,
      input.startInput
    );
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
        frozenInput: waited.frozenInput,
        ...(refusal ? { refusal } : {})
      },
      context
    );
    next += 1;
    // A decided `run_agent` call started its subagent: it is answered with the others.
    const subagent = isRunAgentCall(call.toolName)
      ? startedSubagentOf(call.toolCallId, result, waited.operationRunId)
      : undefined;
    if (subagent) {
      state.emit({ type: "subagent_started", runId: input.runId, ...subagent.event });
      subagents.push(subagent.started);
      continue;
    }
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
  }
  const rest = pending.slice(next).map(toModelToolCall);
  // An open answered as the run resumes gets no note: its report is noted with a later request.
  if (rest.length === 0)
    return { kind: "answered", answeredToolCallIds: answeredNow, subagents, opened: [] };
  const outcome = await input.toolDispatch.dispatchToolCalls(
    input.runId,
    input.startInput,
    context,
    state,
    rest,
    input.repeatedToolCalls,
    input.messages,
    input.offeredDataTools,
    startedBefore.length + subagents.length
  );
  if (outcome.kind === "stopped") return { ...outcome, answeredToolCallIds: answeredNow };
  return outcome.kind === "paused"
    ? {
        ...outcome,
        answeredToolCallIds: [...answeredNow, ...outcome.answeredToolCallIds],
        subagents: [...subagents, ...outcome.subagents]
      }
    : {
        ...outcome,
        answeredToolCallIds: answeredNow,
        subagents: [...subagents, ...outcome.subagents]
      };
}

/**
 * At the end of a step that started subagents: answers each `run_agent` call with how its
 * subagent ended, in the order of the calls, once all of them ended. While one has not, this
 * execution ends with the run waiting for them, keeping `resume` with the subagents to go on.
 */
export async function answerSubagents(input: {
  runId: AgentRunId;
  startInput: StartAgentRunInput;
  context: RuntimeCallContext;
  state: RunState;
  reader: SubagentOutcomeReader | undefined;
  subagents: StartedSubagent[];
  /** The step as the run goes on from it; every call but the subagents' is answered. */
  resume: Omit<AgentRunResumeState, "version" | "waiting" | "subagents" | "doneToolCallIds">;
  modelInput: ModelInput;
  toolDispatch: ToolDispatch;
  messages: ModelMessage[];
}): Promise<"answered" | "waiting" | "stopped"> {
  const { context, state, subagents, resume } = input;
  const answers = await readSubagentAnswers(input.reader, input.runId, context, subagents);
  if (context.signal?.aborted) return "stopped";
  if (answers.kind === "waiting") {
    const started = new Set(subagents.map((subagent) => subagent.toolCallId));
    state.waitForSubagents({
      version: 1,
      ...resume,
      doneToolCallIds: resume.toolCalls
        .map((call) => call.toolCallId)
        .filter((toolCallId) => !started.has(toolCallId)),
      waiting: [],
      subagents
    });
    return "waiting";
  }
  for (const [index, subagent] of subagents.entries()) {
    const call = resume.toolCalls.find((entry) => entry.toolCallId === subagent.toolCallId);
    const result = answers.results[index];
    if (!call || !result) {
      throw new AppError("INTERNAL", "A subagent's call is not part of its step");
    }
    const toolCall = toModelToolCall(call);
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
  }
  return "answered";
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
      ...(waiting.targetTitle ? { targetTitle: waiting.targetTitle } : {}),
      mode: waiting.mode,
      inputPreview: waiting.frozenInput,
      ...(waiting.simulation === undefined ? {} : { simulation: waiting.simulation }),
      ...(waiting.alwaysAllow ? { alwaysAllow: true as const } : {}),
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
