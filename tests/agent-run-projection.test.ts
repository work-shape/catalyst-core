import { describe, expect, it } from "vitest";
import {
  applyAgentRunObservation,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asMessageId,
  asToolCallId,
  projectAgentRun,
  type AgentRun,
  type AgentRuntimeEvent,
  type RunObservation
} from "@vivd-catalyst/core";

describe("agent run projection", () => {
  it("uses the same ordered projection for replay and incremental observations", () => {
    const run = createRun();
    const observations = [
      observe({
        type: "message_delta",
        runId: run.id,
        sequence: 1,
        createdAt: at(1),
        delta: "Checking."
      }),
      observe({
        type: "reasoning_delta",
        runId: run.id,
        sequence: 2,
        createdAt: at(2),
        id: "reasoning_1",
        delta: "Need a source."
      }),
      observe({
        type: "tool_call_preparing",
        runId: run.id,
        sequence: 3,
        createdAt: at(3),
        toolCallId: asToolCallId("call_1"),
        toolName: "web_search"
      }),
      observe({
        type: "tool_call_started",
        runId: run.id,
        sequence: 4,
        createdAt: at(4),
        toolCallId: asToolCallId("call_1"),
        toolName: "web_search",
        input: { query: "official source" }
      }),
      observe({
        type: "tool_call_completed",
        runId: run.id,
        sequence: 5,
        createdAt: at(5),
        toolCallId: asToolCallId("call_1"),
        toolName: "web_search",
        result: { status: "success", output: { sources: 1 } },
        modelOutput: "{\"sources\":1}"
      }),
      observe({
        type: "message_completed",
        runId: run.id,
        sequence: 6,
        createdAt: at(6),
        message: {
          id: asMessageId("message_final"),
          role: "assistant",
          text: "Checking.Done."
        }
      }),
      observe({
        type: "run_completed",
        runId: run.id,
        sequence: 7,
        createdAt: at(7)
      })
    ];

    const replayed = projectAgentRun(run, observations);
    let incremental = projectAgentRun(run, []);
    for (const observation of observations) {
      incremental = applyAgentRunObservation(incremental, observation);
    }

    expect(incremental).toEqual(replayed);
    expect(replayed).toMatchObject({
      status: "completed",
      lastSequence: 7,
      durationMs: 7_000,
      text: "Checking.Done.",
      preparingTool: undefined,
      reasoning: [{ id: "reasoning_1", text: "Need a source.", open: false }]
    });
    expect(replayed.parts).toEqual([
      { type: "text", text: "Checking." },
      { type: "reasoning", id: "reasoning_1", text: "Need a source.", open: false },
      expect.objectContaining({
        type: "tool_call",
        toolCallId: "call_1",
        state: "output_available",
        input: { query: "official source" },
        output: expect.objectContaining({ status: "success", output: { sources: 1 } })
      }),
      { type: "text", text: "Done." }
    ]);
  });
});

function createRun(): AgentRun {
  return {
    id: asAgentRunId("run_1"),
    clientInstanceId: asClientInstanceId("client_1"),
    conversationId: asConversationId("conversation_1"),
    ownerUserId: "user_1",
    inputMessageId: asMessageId("message_input"),
    agentName: "assistant",
    status: "completed",
    startedAt: at(0),
    updatedAt: at(7),
    completedAt: at(7),
    lastSequence: 7,
    correlationId: "correlation_1"
  };
}

function observe(event: AgentRuntimeEvent): RunObservation {
  return {
    clientInstanceId: asClientInstanceId("client_1"),
    runId: event.runId,
    conversationId: asConversationId("conversation_1"),
    ownerUserId: "user_1",
    sequence: event.sequence,
    type: event.type,
    payload: event,
    createdAt: event.createdAt
  };
}

function at(second: number): string {
  return `2026-08-03T10:00:${String(second).padStart(2, "0")}.000Z`;
}
