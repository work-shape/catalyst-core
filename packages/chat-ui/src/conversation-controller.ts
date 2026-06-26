import { useEffect, useMemo, useState } from "react";
import type {
  ActiveRunSummary,
  AgentRun,
  AgentRunProjection,
  ApiClient,
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

export function useConversationController({
  client,
  conversationId,
  enabled,
  snapshot,
  snapshotLoading,
  snapshotError,
  refreshSnapshot,
  onTerminalObservation
}: {
  client: ApiClient;
  conversationId: string | undefined;
  enabled: boolean;
  snapshot: ConversationThreadSnapshot | undefined;
  snapshotLoading: boolean;
  snapshotError: unknown;
  refreshSnapshot: () => Promise<unknown>;
  onTerminalObservation?: (observation: RunObservation) => void;
}): ConversationControllerState {
  const [state, setState] = useState<ConversationControllerState>(() =>
    createInitialControllerState()
  );
  const snapshotRunKey = snapshot?.activeRun
    ? `${snapshot.activeRun.run.id}:${snapshot.activeRun.projection.lastSequence}:${snapshot.activeRun.run.status}`
    : undefined;

  useEffect(() => {
    if (!enabled || !conversationId) {
      setState(createInitialControllerState());
      return;
    }
    if (snapshotLoading) {
      setState((current) => ({
        ...current,
        snapshotStatus: current.snapshotStatus === "ready" ? "ready" : "loading"
      }));
      return;
    }
    if (snapshotError) {
      setState({
        ...createInitialControllerState(),
        snapshotStatus: "error",
        error: {
          class: "stream_disconnected",
          message: snapshotError instanceof Error ? snapshotError.message : "Conversation snapshot failed"
        }
      });
      return;
    }
    if (snapshot) {
      setState((current) => createControllerStateFromSnapshot(snapshot, current));
    }
  }, [conversationId, enabled, snapshot, snapshotError, snapshotLoading, snapshotRunKey]);

  const activeRunConnection = useMemo(() => {
    if (!enabled || !conversationId || !snapshot?.activeRun) {
      return undefined;
    }
    return {
      conversationId,
      runId: snapshot.activeRun.run.id,
      afterSequence: snapshot.activeRun.projection.lastSequence
    };
  }, [conversationId, enabled, snapshotRunKey]);

  useEffect(() => {
    if (!activeRunConnection) {
      return undefined;
    }

    const abortController = new AbortController();
    let cancelled = false;

    setState((current) => ({
      ...current,
      connectionStatus:
        current.connectionStatus === "disconnected" ? "reconnecting" : "connecting"
    }));

    void (async () => {
      try {
        let sawObservation = false;
        for await (const observation of client.observeRunEvents(
          activeRunConnection.conversationId,
          activeRunConnection.runId,
          {
            afterSequence: activeRunConnection.afterSequence,
            signal: abortController.signal
          }
        )) {
          if (cancelled) {
            return;
          }
          sawObservation = true;
          rememberRunCursor(activeRunConnection.conversationId, activeRunConnection.runId, observation.sequence);
          let refreshRequired = false;
          setState((current) => {
            const applied = applyRunObservationToControllerState(current, observation);
            refreshRequired = applied.refreshRequired;
            return applied.state;
          });
          if (isTerminalObservation(observation)) {
            onTerminalObservation?.(observation);
          }
          if (refreshRequired) {
            abortController.abort();
            await refreshSnapshot();
            return;
          }
        }
        if (!cancelled) {
          setState((current) => ({
            ...current,
            connectionStatus: sawObservation ? "caught_up" : "disconnected"
          }));
        }
      } catch (error) {
        if (cancelled || isAbortLikeError(error)) {
          return;
        }
        setState((current) => ({
          ...current,
          connectionStatus: "disconnected",
          error: {
            class: "stream_disconnected",
            message: error instanceof Error ? error.message : "Run observation stream disconnected"
          }
        }));
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [activeRunConnection, client, onTerminalObservation, refreshSnapshot]);

  return state;
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
  const preservedTerminalRun = terminalRunForSnapshot(snapshot, previousState);
  return {
    snapshotStatus: "ready",
    connectionStatus: snapshot.activeRun ? "connecting" : "idle",
    conversation: snapshot.conversation,
    messages: snapshot.messages,
    ...(snapshot.activeRun
      ? {
          activeRun: {
            run: snapshot.activeRun.run,
            projection: snapshot.activeRun.projection,
            lastAppliedSequence: snapshot.activeRun.projection.lastSequence
          }
        }
      : preservedTerminalRun
        ? {
            activeRun: preservedTerminalRun,
            ...(previousState?.error ? { error: previousState.error } : {})
          }
        : {})
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

export function clearRunCursors(): void {
  if (typeof window === "undefined") {
    return;
  }
  for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
    const key = window.sessionStorage.key(index);
    if (key?.startsWith(RUN_CURSOR_STORAGE_PREFIX)) {
      window.sessionStorage.removeItem(key);
    }
  }
}

function applyObservationToProjection(
  projection: AgentRunProjection,
  observation: RunObservation
): AgentRunProjection {
  const event = observation.payload;
  const reasoning = projection.reasoning.map((entry) => ({ ...entry }));
  const toolCalls = projection.activeToolCalls.map((entry) => ({ ...entry }));
  let text = projection.text;
  let error = projection.error;

  if (event.type === "message_delta") {
    text += event.delta;
  }
  if (event.type === "message_completed") {
    text = event.message.text;
  }
  if (event.type === "reasoning_delta") {
    const existing = reasoning.find((entry) => entry.id === event.id);
    if (existing) {
      existing.text += event.delta;
      existing.open = true;
    } else {
      reasoning.push({ id: event.id, text: event.delta, open: true });
    }
  }
  if (event.type === "tool_call_started") {
    upsertToolCall(toolCalls, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      state: "input_available"
    });
  }
  if (event.type === "tool_permission_requested") {
    const existing = toolCalls.find((entry) => entry.toolCallId === event.toolCallId);
    upsertToolCall(toolCalls, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: existing?.input,
      state: "waiting_for_permission"
    });
  }
  if (event.type === "tool_call_completed") {
    const existing = toolCalls.find((entry) => entry.toolCallId === event.toolCallId);
    const result = isRecord(event.result) ? event.result : undefined;
    upsertToolCall(toolCalls, {
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
    });
  }
  if (event.type === "tool_call_failed") {
    const existing = toolCalls.find((entry) => entry.toolCallId === event.toolCallId);
    const result = isRecord(event.result) ? event.result : undefined;
    const error = isRecord(result?.error) ? result.error : undefined;
    upsertToolCall(toolCalls, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: existing?.input,
      state: "output_error",
      errorText: typeof error?.message === "string" ? error.message : "Tool call failed"
    });
  }
  if (event.type === "run_failed") {
    error = event.error;
  }
  if (isTerminalObservation(observation)) {
    for (const entry of reasoning) {
      entry.open = false;
    }
  }

  return {
    ...projection,
    lastSequence: Math.max(projection.lastSequence, observation.sequence),
    status: applyObservationStatus(projection.status, observation),
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

function terminalRunForSnapshot(
  snapshot: ConversationThreadSnapshot,
  previousState: ConversationControllerState | undefined
): ConversationControllerState["activeRun"] | undefined {
  if (snapshot.activeRun || !previousState?.activeRun) {
    return undefined;
  }
  const previousRun = previousState.activeRun.run;
  if (
    previousRun.conversationId !== snapshot.conversation.id ||
    !isUserVisibleTerminalRunStatus(previousRun.status)
  ) {
    return undefined;
  }
  return previousState.activeRun;
}

function isUserVisibleTerminalRunStatus(status: AgentRun["status"]): boolean {
  return status === "cancelled" || status === "failed";
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

function isTerminalObservation(observation: RunObservation): boolean {
  return (
    observation.payload.type === "run_completed" ||
    observation.payload.type === "run_cancelled" ||
    observation.payload.type === "run_failed"
  );
}

function isAbortLikeError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /abort/u.test(error.message.toLowerCase()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const RUN_CURSOR_STORAGE_PREFIX = "vivd-catalyst:run-cursor";

function rememberRunCursor(conversationId: string, runId: string, sequence: number): void {
  if (typeof window === "undefined") {
    return;
  }
  window.sessionStorage.setItem(
    `${RUN_CURSOR_STORAGE_PREFIX}:${conversationId}:${runId}`,
    String(sequence)
  );
}
