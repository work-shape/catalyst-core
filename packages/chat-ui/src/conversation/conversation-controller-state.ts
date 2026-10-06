import type {
  ActiveRunSummary,
  AgentRun,
  AgentRunProjection,
  Conversation,
  ConversationThreadSnapshot,
  Message,
  RunObservation
} from "@vivd-catalyst/api-client";
import {
  applyAgentRunObservation,
  type AgentRunProjection as CoreAgentRunProjection,
  type RunObservation as CoreRunObservation
} from "@vivd-catalyst/core";

export type ConversationSnapshotStatus = "loading" | "ready" | "not_found" | "error";
export type ConversationConnectionStatus =
  "idle" | "connecting" | "connected" | "reconnecting" | "caught_up" | "disconnected";
export type ConversationControllerErrorClass =
  "send_failed" | "stream_disconnected" | "run_failed" | "run_cancelled" | "auth_expired";

export interface ConversationControllerRunSummary extends Omit<ActiveRunSummary, "status"> {
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
    category?: string;
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
  const preservedTerminalError = preservedTerminalErrorForSnapshotRun(snapshotRun, previousState);
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

  const projection = applyAgentRunObservation(
    activeRun.projection as CoreAgentRunProjection,
    observation as CoreRunObservation
  ) as AgentRunProjection;
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
    const preservedError = currentError?.class === "stream_disconnected" ? undefined : currentError;
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

function applyObservationToMessages(messages: Message[], observation: RunObservation): Message[] {
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
      message: activeRun.projection.error?.message ?? "Run failed",
      category: activeRun.projection.error?.category
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
      message: observation.payload.error.message,
      category: observation.payload.error.category
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
