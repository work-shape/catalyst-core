import type {
  AgentRun,
  AgentRunProjection,
  AgentRunProjectionPart,
  AgentRuntimeEvent,
  RunObservation
} from "./agent-runtime";

export function projectAgentRun(run: AgentRun, observations: RunObservation[]): AgentRunProjection {
  let projection = createAgentRunProjection(run);
  for (const observation of observations) {
    projection = applyAgentRunObservation(projection, observation);
  }
  return projection;
}

export function applyAgentRunObservation(
  projection: AgentRunProjection,
  observation: RunObservation
): AgentRunProjection {
  const event = observation.payload;
  const parts = cloneParts(projection);
  const reasoning = projection.reasoning.map((entry) => ({ ...entry }));
  const activeToolCalls = projection.activeToolCalls.map((entry) => ({ ...entry }));
  let text = projection.text;
  let error = projection.error;
  let preparingTool = projection.preparingTool ? { ...projection.preparingTool } : undefined;

  if (event.type === "message_delta") {
    text += event.delta;
    appendText(parts, event.delta);
  }
  if (event.type === "message_completed") {
    text = event.message.text;
    reconcileCompletedText(parts, text);
  }
  if (event.type === "reasoning_delta") {
    const entry = reasoning.find((candidate) => candidate.id === event.id) ?? {
      id: event.id,
      text: "",
      open: true
    };
    entry.text += event.delta;
    entry.open = true;
    if (!reasoning.includes(entry)) {
      reasoning.push(entry);
    }
    upsertPart(parts, {
      type: "reasoning",
      ...entry
    });
  }
  if (event.type === "tool_call_preparing") {
    preparingTool = {
      toolCallId: event.toolCallId,
      toolName: event.toolName
    };
  }
  if (event.type === "tool_call_started") {
    if (preparingTool?.toolCallId === event.toolCallId) {
      preparingTool = undefined;
    }
    upsertToolCall(activeToolCalls, parts, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
      state: "input_available"
    });
  }
  if (event.type === "tool_permission_requested") {
    upsertToolCall(activeToolCalls, parts, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: findToolCallInput(activeToolCalls, event.toolCallId),
      state: "waiting_for_permission"
    });
  }
  if (event.type === "tool_call_completed") {
    upsertToolCall(activeToolCalls, parts, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: findToolCallInput(activeToolCalls, event.toolCallId),
      state: "output_available",
      output: toToolOutput(event)
    });
  }
  if (event.type === "tool_call_failed") {
    upsertToolCall(activeToolCalls, parts, {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: findToolCallInput(activeToolCalls, event.toolCallId),
      state: "output_error",
      errorText: toToolError(event)
    });
  }
  if (event.type === "run_failed") {
    error = event.error;
  }
  if (isTerminalEvent(event)) {
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
    status: statusAfterEvent(projection.status, event),
    parts,
    text,
    reasoning,
    activeToolCalls,
    preparingTool,
    ...(error ? { error } : {})
  };
}

function createAgentRunProjection(run: AgentRun): AgentRunProjection {
  const endedAt = run.completedAt ?? run.cancelledAt ?? run.failedAt;
  return {
    runId: run.id,
    lastSequence: run.lastSequence,
    status: run.status,
    ...(endedAt
      ? { durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(run.startedAt)) }
      : {}),
    parts: [],
    text: "",
    reasoning: [],
    activeToolCalls: [],
    ...(run.error ? { error: run.error } : {})
  };
}

function cloneParts(projection: AgentRunProjection): AgentRunProjection["parts"] {
  if (projection.parts.length > 0) {
    return projection.parts.map((part) => ({ ...part }));
  }
  const parts: AgentRunProjection["parts"] = [
    ...projection.reasoning.map((entry) => ({ type: "reasoning" as const, ...entry })),
    ...projection.activeToolCalls.map((entry) => ({ type: "tool_call" as const, ...entry }))
  ];
  if (projection.text.length > 0 || parts.length === 0) {
    parts.push({ type: "text", text: projection.text });
  }
  return parts;
}

function appendText(parts: AgentRunProjection["parts"], delta: string): void {
  if (delta.length === 0) {
    return;
  }
  const lastPart = parts.at(-1);
  if (lastPart?.type === "text") {
    lastPart.text += delta;
    return;
  }
  parts.push({ type: "text", text: delta });
}

function reconcileCompletedText(parts: AgentRunProjection["parts"], completedText: string): void {
  const observedText = parts
    .filter(
      (part): part is Extract<AgentRunProjectionPart, { type: "text" }> => part.type === "text"
    )
    .map((part) => part.text)
    .join("");
  if (observedText.length === 0) {
    if (completedText.length > 0 || parts.length === 0) {
      parts.push({ type: "text", text: completedText });
    }
    return;
  }
  if (
    completedText === observedText ||
    (completedText.length > 0 && observedText.endsWith(completedText))
  ) {
    return;
  }
  if (completedText.startsWith(observedText)) {
    appendText(parts, completedText.slice(observedText.length));
  } else if (completedText.length > 0) {
    appendText(parts, completedText);
  }
}

function upsertToolCall(
  toolCalls: AgentRunProjection["activeToolCalls"],
  parts: AgentRunProjection["parts"],
  toolCall: AgentRunProjection["activeToolCalls"][number]
): void {
  const index = toolCalls.findIndex((entry) => entry.toolCallId === toolCall.toolCallId);
  if (index >= 0) {
    toolCalls[index] = toolCall;
  } else {
    toolCalls.push(toolCall);
  }
  upsertPart(parts, { type: "tool_call", ...toolCall });
}

function upsertPart(parts: AgentRunProjection["parts"], part: AgentRunProjectionPart): void {
  const index = parts.findIndex(
    (candidate) =>
      candidate.type === part.type &&
      (part.type === "tool_call"
        ? candidate.type === "tool_call" && candidate.toolCallId === part.toolCallId
        : part.type === "reasoning"
          ? candidate.type === "reasoning" && candidate.id === part.id
          : false)
  );
  if (index >= 0) {
    parts[index] = part;
  } else {
    parts.push(part);
  }
}

function findToolCallInput(
  toolCalls: AgentRunProjection["activeToolCalls"],
  toolCallId: string
): unknown {
  return toolCalls.find((entry) => entry.toolCallId === toolCallId)?.input;
}

function toToolOutput(event: Extract<AgentRuntimeEvent, { type: "tool_call_completed" }>): unknown {
  return event.result.status === "success"
    ? {
        status: "success",
        output: event.result.output,
        display: event.result.display,
        structuredResult: event.result.structuredResult,
        artifacts: event.result.artifacts,
        projectionNotice: event.projectionNotice
      }
    : {
        status: event.result.status,
        error: event.result.error,
        projectionNotice: event.projectionNotice
      };
}

function toToolError(event: Extract<AgentRuntimeEvent, { type: "tool_call_failed" }>): string {
  return event.result.status === "success" ? "Tool call failed" : event.result.error.message;
}

function isTerminalEvent(event: AgentRuntimeEvent): boolean {
  return (
    event.type === "run_completed" || event.type === "run_cancelled" || event.type === "run_failed"
  );
}

function statusAfterEvent(
  currentStatus: AgentRun["status"],
  event: AgentRuntimeEvent
): AgentRun["status"] {
  if (event.type === "run_completed") {
    return "completed";
  }
  if (event.type === "run_cancelled") {
    return "cancelled";
  }
  if (event.type === "run_failed") {
    return "failed";
  }
  return currentStatus;
}
