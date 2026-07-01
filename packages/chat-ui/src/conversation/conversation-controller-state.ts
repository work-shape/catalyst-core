import type {
  ActiveRunSummary,
  AgentRun,
  AgentRunProjection,
  Conversation,
  ConversationThreadSnapshot,
  Message,
  RunObservation
} from "@vivd-catalyst/api-client";

export type ConversationSnapshotStatus = "loading" | "ready" | "not_found" | "error";
export type ConversationConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "caught_up"
  | "disconnected";
export type ConversationControllerErrorClass =
  | "send_failed"
  | "stream_disconnected"
  | "run_failed"
  | "run_cancelled"
  | "auth_expired";

export interface ConversationControllerRunSummary
  extends Omit<ActiveRunSummary, "status"> {
  status: AgentRun["status"];
}

export interface ConversationControllerState {
  snapshotStatus: ConversationSnapshotStatus;
  connectionStatus: ConversationConnectionStatus;
  conversation?: Conversation;
  messages: Message[];
  completedRunProjections?: Record<string, AgentRunProjection>;
  activeRun?: {
    run: ConversationControllerRunSummary;
    projection: AgentRunProjection;
    lastAppliedSequence: number;
  };
  error?: {
    class: ConversationControllerErrorClass;
    message: string;
  };
}

export interface ConversationControllerApplyResult {
  state: ConversationControllerState;
  applied: boolean;
  refreshRequired: boolean;
}

export function createInitialControllerState(): ConversationControllerState {
  return {
    snapshotStatus: "ready",
    connectionStatus: "idle",
    messages: []
  };
}

export function createControllerStateFromSnapshot(
  snapshot: ConversationThreadSnapshot,
  previousState?: ConversationControllerState
): ConversationControllerState {
  const snapshotRun = activeRunForSnapshot(snapshot, previousState);
  const snapshotTerminalError = snapshotRun ? terminalErrorFromSnapshot(snapshotRun) : undefined;
  const preservedTerminalError = preservedTerminalErrorForSnapshotRun(
    snapshotRun,
    previousState
  );
  const error = preservedTerminalError ?? snapshotTerminalError;
  return {
    snapshotStatus: "ready",
    connectionStatus: snapshotRun
      ? isLiveRunStatus(snapshotRun.run.status)
        ? "connecting"
        : "caught_up"
      : "idle",
    conversation: snapshot.conversation,
    messages: snapshot.messages,
    completedRunProjections: snapshot.completedRunProjections,
    ...(snapshotRun
      ? {
          activeRun: {
            run: snapshotRun.run,
            projection: snapshotRun.projection,
            lastAppliedSequence: snapshotRun.projection.lastSequence
          }
        }
      : {}),
    ...(error ? { error } : {})
  };
}

export function applyRunObservationToControllerState(
  state: ConversationControllerState,
  observation: RunObservation
): ConversationControllerApplyResult {
  const activeRun = state.activeRun;
  if (!activeRun || activeRun.run.id !== observation.runId) {
    return {
      state,
      applied: false,
      refreshRequired: false
    };
  }

  if (observation.sequence <= activeRun.lastAppliedSequence) {
    return {
      state,
      applied: false,
      refreshRequired: false
    };
  }

  if (observation.sequence > activeRun.lastAppliedSequence + 1) {
    return {
      state: {
        ...state,
        connectionStatus: "reconnecting",
        error: {
          class: "stream_disconnected",
          message: "Run observation sequence gap detected"
        }
      },
      applied: false,
      refreshRequired: true
    };
  }

  const projection = applyObservationToProjection(activeRun.projection, observation);
  const nextRun = applyObservationToRunSummary(activeRun.run, observation);
  const nextMessages = applyObservationToMessages(state.messages, observation);
  return {
    state: {
      ...state,
      connectionStatus: isTerminalObservation(observation) ? "caught_up" : "connected",
      messages: nextMessages,
      activeRun: {
        run: nextRun,
        projection,
        lastAppliedSequence: observation.sequence
      },
      error: terminalError(observation) ?? state.error
    },
    applied: true,
    refreshRequired: false
  };
}

export function completeRunObservationStreamInControllerState(
  state: ConversationControllerState,
  input: {
    sawObservation: boolean;
    streamCaughtUp: boolean;
  }
): ConversationControllerState {
  if (input.streamCaughtUp || input.sawObservation) {
    const { error: currentError, ...rest } = state;
    const preservedError =
      currentError?.class === "stream_disconnected" ? undefined : currentError;
    return {
      ...rest,
      connectionStatus: "caught_up",
      ...(preservedError ? { error: preservedError } : {})
    };
  }

  return {
    ...state,
    connectionStatus: "disconnected",
    error: {
      class: "stream_disconnected",
      message: "Run observation stream disconnected"
    }
  };
}

export function isLiveRunStatus(status: AgentRun["status"]): boolean {
  return (
    status === "queued" ||
    status === "running" ||
    status === "waiting_for_permission" ||
    status === "cancelling"
  );
}

export function isTerminalObservation(observation: RunObservation): boolean {
  return (
    observation.payload.type === "run_completed" ||
    observation.payload.type === "run_cancelled" ||
    observation.payload.type === "run_failed"
  );
}

function applyObservationToProjection(
  projection: AgentRunProjection,
  observation: RunObservation
): AgentRunProjection {
  const event = observation.payload;
  const parts = cloneProjectionParts(projection);
  const reasoning = projection.reasoning.map((entry) => ({ ...entry }));
  const toolCalls = projection.activeToolCalls.map((entry) => ({ ...entry }));
  let text = projection.text;
  let error = projection.error;

  if (event.type === "message_delta") {
    text += event.delta;
    appendProjectionTextPart(parts, event.delta);
  }
  if (event.type === "message_completed") {
    text = event.message.text;
    reconcileCompletedProjectionText(parts, event.message.text);
  }
  if (event.type === "reasoning_delta") {
    const existing = reasoning.find((entry) => entry.id === event.id);
    if (existing) {
      existing.text += event.delta;
      existing.open = true;
    } else {
      reasoning.push({ id: event.id, text: event.delta, open: true });
    }
    upsertProjectionPart(parts, {
      type: "reasoning",
      id: event.id,
      text: reasoning.find((entry) => entry.id === event.id)?.text ?? event.delta,
      open: true
    });
  }
  if (event.type === "tool_call_started") {
    const toolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      state: "input_available"
    } as const;
    upsertToolCall(toolCalls, toolCall);
    upsertProjectionPart(parts, {
      type: "tool_call",
      ...toolCall
    });
  }
  if (event.type === "tool_permission_requested") {
    const existing = toolCalls.find((entry) => entry.toolCallId === event.toolCallId);
    const toolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: existing?.input,
      state: "waiting_for_permission"
    } as const;
    upsertToolCall(toolCalls, toolCall);
    upsertProjectionPart(parts, {
      type: "tool_call",
      ...toolCall
    });
  }
  if (event.type === "tool_call_completed") {
    const existing = toolCalls.find((entry) => entry.toolCallId === event.toolCallId);
    const result = isRecord(event.result) ? event.result : undefined;
    const toolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: existing?.input,
      state: "output_available",
      output: result
        ? result.status === "success"
          ? {
              status: "success",
              output: result.output,
              display: result.display,
              artifacts: result.artifacts,
              projectionNotice: event.projectionNotice
            }
          : {
              status: result.status,
              error: result.error,
              projectionNotice: event.projectionNotice
            }
        : undefined
    } as const;
    upsertToolCall(toolCalls, toolCall);
    upsertProjectionPart(parts, {
      type: "tool_call",
      ...toolCall
    });
  }
  if (event.type === "tool_call_failed") {
    const existing = toolCalls.find((entry) => entry.toolCallId === event.toolCallId);
    const result = isRecord(event.result) ? event.result : undefined;
    const error = isRecord(result?.error) ? result.error : undefined;
    const toolCall = {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: existing?.input,
      state: "output_error",
      errorText: typeof error?.message === "string" ? error.message : "Tool call failed"
    } as const;
    upsertToolCall(toolCalls, toolCall);
    upsertProjectionPart(parts, {
      type: "tool_call",
      ...toolCall
    });
  }
  if (event.type === "run_failed") {
    error = event.error;
  }
  if (isTerminalObservation(observation)) {
    for (const entry of reasoning) {
      entry.open = false;
    }
    for (const part of parts) {
      if (part.type === "reasoning") {
        part.open = false;
      }
    }
  }

  return {
    ...projection,
    lastSequence: Math.max(projection.lastSequence, observation.sequence),
    status: applyObservationStatus(projection.status, observation),
    parts,
    text,
    reasoning,
    activeToolCalls: toolCalls,
    ...(error ? { error } : {})
  };
}

function applyObservationToRunSummary(
  run: ConversationControllerRunSummary,
  observation: RunObservation
): ConversationControllerRunSummary {
  return {
    ...run,
    status: applyObservationStatus(run.status, observation),
    lastSequence: Math.max(run.lastSequence, observation.sequence),
    updatedAt: observation.createdAt
  };
}

function applyObservationToMessages(
  messages: Message[],
  observation: RunObservation
): Message[] {
  const event = observation.payload;
  if (event.type !== "message_completed") {
    return messages;
  }
  const message: Message = {
    id: event.message.id,
    clientInstanceId: observation.clientInstanceId,
    conversationId: observation.conversationId,
    role: "assistant",
    text: event.message.text,
    createdAt: event.createdAt,
    metadata: event.message.metadata
  };
  if (messages.some((candidate) => candidate.id === message.id)) {
    return messages.map((candidate) => (candidate.id === message.id ? message : candidate));
  }
  return [...messages, message];
}

function upsertToolCall(
  toolCalls: AgentRunProjection["activeToolCalls"],
  toolCall: AgentRunProjection["activeToolCalls"][number]
): void {
  const index = toolCalls.findIndex((entry) => entry.toolCallId === toolCall.toolCallId);
  if (index >= 0) {
    toolCalls[index] = toolCall;
    return;
  }
  toolCalls.push(toolCall);
}

function cloneProjectionParts(
  projection: AgentRunProjection
): AgentRunProjection["parts"] {
  const projectionParts = projection.parts ?? [];
  if (projectionParts.length > 0) {
    return projectionParts.map((part) => ({ ...part }));
  }
  const parts: AgentRunProjection["parts"] = [
    ...projection.reasoning.map((entry) => ({
      type: "reasoning" as const,
      id: entry.id,
      text: entry.text,
      open: entry.open
    })),
    ...projection.activeToolCalls.map((entry) => ({
      type: "tool_call" as const,
      ...entry
    }))
  ];
  if (projection.text.length > 0 || parts.length === 0) {
    parts.push({
      type: "text",
      text: projection.text
    });
  }
  return parts;
}

function appendProjectionTextPart(
  parts: AgentRunProjection["parts"],
  delta: string
): void {
  if (delta.length === 0) {
    return;
  }
  const lastPart = parts.at(-1);
  if (lastPart?.type === "text") {
    lastPart.text += delta;
    return;
  }
  parts.push({
    type: "text",
    text: delta
  });
}

function reconcileCompletedProjectionText(
  parts: AgentRunProjection["parts"],
  completedText: string
): void {
  const observedText = parts
    .filter((part): part is Extract<AgentRunProjection["parts"][number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (observedText.length === 0) {
    if (completedText.length > 0 || parts.length === 0) {
      parts.push({
        type: "text",
        text: completedText
      });
    }
    return;
  }
  if (completedText === observedText) {
    return;
  }
  if (completedText.length > 0 && observedText.endsWith(completedText)) {
    return;
  }
  if (completedText.startsWith(observedText)) {
    appendProjectionTextPart(parts, completedText.slice(observedText.length));
    return;
  }
  if (completedText.length > 0) {
    appendProjectionTextPart(parts, completedText);
  }
}

function upsertProjectionPart(
  parts: AgentRunProjection["parts"],
  part: AgentRunProjection["parts"][number]
): void {
  const index = parts.findIndex((candidate) => {
    if (candidate.type !== part.type) {
      return false;
    }
    if (part.type === "tool_call") {
      return candidate.type === "tool_call" && candidate.toolCallId === part.toolCallId;
    }
    if (part.type === "reasoning") {
      return candidate.type === "reasoning" && candidate.id === part.id;
    }
    return false;
  });
  if (index >= 0) {
    parts[index] = part;
    return;
  }
  parts.push(part);
}

function applyObservationStatus(
  currentStatus: AgentRun["status"],
  observation: RunObservation
): AgentRun["status"] {
  if (observation.payload.type === "run_completed") {
    return "completed";
  }
  if (observation.payload.type === "run_cancelled") {
    return "cancelled";
  }
  if (observation.payload.type === "run_failed") {
    return "failed";
  }
  return currentStatus;
}

function activeRunForSnapshot(
  snapshot: ConversationThreadSnapshot,
  previousState: ConversationControllerState | undefined
): NonNullable<ConversationThreadSnapshot["activeRun"]> | undefined {
  if (snapshot.activeRun) {
    if (
      previousState?.activeRun?.run.id === snapshot.activeRun.run.id &&
      previousState.activeRun.lastAppliedSequence > snapshot.activeRun.projection.lastSequence
    ) {
      return {
        run: previousState.activeRun.run,
        projection: previousState.activeRun.projection
      };
    }
    return snapshot.activeRun;
  }
  if (!previousState?.activeRun) {
    return undefined;
  }
  const previousRun = previousState.activeRun.run;
  if (
    previousRun.conversationId !== snapshot.conversation.id ||
    !isUserVisibleTerminalRunStatus(previousRun.status)
  ) {
    return undefined;
  }
  return {
    run: previousState.activeRun.run,
    projection: previousState.activeRun.projection
  };
}

function isUserVisibleTerminalRunStatus(status: AgentRun["status"]): boolean {
  return status === "cancelled" || status === "failed";
}

function preservedTerminalErrorForSnapshotRun(
  snapshotRun: NonNullable<ConversationThreadSnapshot["activeRun"]> | undefined,
  previousState: ConversationControllerState | undefined
): ConversationControllerState["error"] | undefined {
  if (!snapshotRun || !previousState?.activeRun) {
    return undefined;
  }
  if (previousState.activeRun.run.id !== snapshotRun.run.id) {
    return undefined;
  }
  if (previousState.activeRun.lastAppliedSequence < snapshotRun.projection.lastSequence) {
    return undefined;
  }
  return isUserVisibleTerminalControllerError(previousState.error?.class)
    ? previousState.error
    : undefined;
}

function isUserVisibleTerminalControllerError(
  errorClass: ConversationControllerErrorClass | undefined
): boolean {
  return errorClass === "run_cancelled" || errorClass === "run_failed";
}

function terminalErrorFromSnapshot(
  activeRun: NonNullable<ConversationThreadSnapshot["activeRun"]>
): ConversationControllerState["error"] | undefined {
  if (activeRun.run.status === "failed") {
    return {
      class: "run_failed",
      message: activeRun.projection.error?.message ?? "Run failed"
    };
  }
  if (activeRun.run.status === "cancelled") {
    return {
      class: "run_cancelled",
      message: "Run cancelled"
    };
  }
  return undefined;
}

function terminalError(
  observation: RunObservation
): ConversationControllerState["error"] | undefined {
  if (observation.payload.type === "run_failed") {
    return {
      class: "run_failed",
      message: observation.payload.error.message
    };
  }
  if (observation.payload.type === "run_cancelled") {
    return {
      class: "run_cancelled",
      message: observation.payload.reason ?? "Run cancelled"
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
