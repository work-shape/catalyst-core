import { describe, expect, it } from "vitest";
import type { ConversationThreadSnapshot, RunObservation } from "@vivd-catalyst/api-client";
import { toUiMessages } from "../packages/chat-ui/src/assistant-ui-adapter";
import {
  applyRunObservationToControllerState,
  completeRunObservationStreamInControllerState,
  createControllerStateFromSnapshot
} from "../packages/chat-ui/src/conversation/conversation-controller-state";

describe("chat UI conversation controller", () => {
  it("ignores duplicate or already-applied run observations", () => {
    const state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 2, text: "Hello" }));
    const duplicate = createObservation({
      sequence: 2,
      type: "message_delta",
      payload: {
        delta: " again"
      }
    });

    const result = applyRunObservationToControllerState(state, duplicate);

    expect(result).toMatchObject({
      applied: false,
      refreshRequired: false
    });
    expect(result.state).toBe(state);
  });

  it("requires a snapshot refresh before applying a sequence gap", () => {
    const state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 2, text: "Hello" }));
    const skipped = createObservation({
      sequence: 4,
      type: "message_delta",
      payload: {
        delta: " after a missing event"
      }
    });

    const result = applyRunObservationToControllerState(state, skipped);

    expect(result).toMatchObject({
      applied: false,
      refreshRequired: true,
      state: {
        connectionStatus: "reconnecting",
        error: {
          class: "stream_disconnected"
        }
      }
    });
    expect(result.state.activeRun?.projection.text).toBe("Hello");
  });

  it("reconciles completed assistant messages by canonical id", () => {
    const snapshot = createSnapshot({
      lastSequence: 2,
      text: "Draft",
      messages: [
        {
          id: "msg_assistant",
          conversationId: "conv_1",
          clientInstanceId: "client_1",
          role: "assistant",
          text: "Old final",
          createdAt: "2026-06-26T10:00:00.000Z",
          metadata: {
            agentRuntime: {
              version: 1,
              kind: "assistant_final",
              runId: "run_1"
            }
          }
        }
      ]
    });
    const state = createControllerStateFromSnapshot(snapshot);
    const completed = createObservation({
      sequence: 3,
      type: "message_completed",
      payload: {
        message: {
          id: "msg_assistant",
          role: "assistant",
          text: "Canonical final",
          metadata: {
            agentRuntime: {
              version: 1,
              kind: "assistant_final",
              runId: "run_1"
            }
          }
        }
      }
    });

    const result = applyRunObservationToControllerState(state, completed);

    expect(result.applied).toBe(true);
    expect(result.state.messages.filter((message) => message.id === "msg_assistant")).toHaveLength(1);
    expect(result.state.messages).toContainEqual(
      expect.objectContaining({
        id: "msg_assistant",
        text: "Canonical final"
      })
    );
    expect(result.state.activeRun?.projection.text).toBe("Canonical final");
    expect(result.state.activeRun?.lastAppliedSequence).toBe(3);
  });

  it("preserves live text and tool call chronology for active-run rendering", () => {
    let state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 0, text: "" }));
    for (const observation of [
      createObservation({
        sequence: 1,
        type: "message_delta",
        payload: {
          delta: "First step."
        }
      }),
      createObservation({
        sequence: 2,
        type: "tool_call_started",
        payload: {
          toolCallId: "tool_1",
          toolName: "demo.lookup",
          input: { query: "first" }
        }
      }),
      createObservation({
        sequence: 3,
        type: "tool_call_completed",
        payload: {
          toolCallId: "tool_1",
          toolName: "demo.lookup",
          result: {
            status: "success",
            output: { ok: true }
          },
          modelOutput: "{\"ok\":true}"
        }
      }),
      createObservation({
        sequence: 4,
        type: "message_delta",
        payload: {
          delta: "Second step."
        }
      })
    ]) {
      state = applyRunObservationToControllerState(state, observation).state;
    }

    expect(state.activeRun?.projection.parts).toEqual([
      {
        type: "text",
        text: "First step."
      },
      expect.objectContaining({
        type: "tool_call",
        toolCallId: "tool_1",
        state: "output_available"
      }),
      {
        type: "text",
        text: "Second step."
      }
    ]);

    const [message] = toUiMessages([], state.activeRun);
    expect(message?.parts.map((part) => part.type)).toEqual([
      "text",
      "dynamic-tool",
      "text"
    ]);
  });

  it("keeps a newer local active-run projection when a stale same-run snapshot arrives", () => {
    const staleSnapshot = createSnapshot({ lastSequence: 0, text: "" });
    const live = applyRunObservationToControllerState(
      createControllerStateFromSnapshot(staleSnapshot),
      createObservation({
        sequence: 1,
        type: "message_delta",
        payload: {
          delta: "Live text"
        }
      })
    ).state;

    const refreshed = createControllerStateFromSnapshot(staleSnapshot, live);

    expect(refreshed.activeRun?.lastAppliedSequence).toBe(1);
    expect(refreshed.activeRun?.projection.text).toBe("Live text");
    expect(refreshed.activeRun?.projection.parts).toEqual([
      {
        type: "text",
        text: "Live text"
      }
    ]);
  });

  it("keeps failed terminal run state visible across snapshot refresh", () => {
    const state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 2, text: "Partial answer" }));
    const failed = applyRunObservationToControllerState(
      state,
      createObservation({
        sequence: 3,
        type: "run_failed",
        payload: {
          error: {
            category: "internal_error",
            code: "MODEL_FAILED",
            message: "Model provider failed"
          }
        }
      })
    ).state;

    const refreshed = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "", activeRun: false }),
      failed
    );

    expect(refreshed.activeRun?.run.status).toBe("failed");
    expect(refreshed.activeRun?.projection.text).toBe("Partial answer");
    expect(refreshed.error).toMatchObject({
      class: "run_failed",
      message: "Model provider failed"
    });
  });

  it("keeps cancelled terminal run state visible across snapshot refresh", () => {
    const state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 2, text: "Partial answer" }));
    const cancelled = applyRunObservationToControllerState(
      state,
      createObservation({
        sequence: 3,
        type: "run_cancelled",
        payload: {
          reason: "user_requested"
        }
      })
    ).state;

    const refreshed = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "", activeRun: false }),
      cancelled
    );

    expect(refreshed.activeRun?.run.status).toBe("cancelled");
    expect(refreshed.activeRun?.projection.text).toBe("Partial answer");
    expect(refreshed.error).toMatchObject({
      class: "run_cancelled",
      message: "user_requested"
    });
  });

  it("renders recovered terminal run snapshots without opening a live connection state", () => {
    const recovered = createControllerStateFromSnapshot(
      createSnapshot({
        lastSequence: 2,
        text: "Partial answer",
        runStatus: "failed",
        error: {
          code: "AGENT_RUN_RUNTIME_INTERRUPTED",
          message: "Agent run was interrupted after the local runtime state was lost",
          category: "runtime_interrupted"
        }
      })
    );

    expect(recovered.connectionStatus).toBe("caught_up");
    expect(recovered.activeRun?.run.status).toBe("failed");
    expect(recovered.activeRun?.projection.error).toMatchObject({
      code: "AGENT_RUN_RUNTIME_INTERRUPTED",
      category: "runtime_interrupted"
    });
    expect(recovered.error).toMatchObject({
      class: "run_failed",
      message: "Agent run was interrupted after the local runtime state was lost"
    });
  });

  it("treats caught-up no-observation streams as caught up rather than disconnected", () => {
    const state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 3, text: "Final" }));
    const reconnected = completeRunObservationStreamInControllerState(
      {
        ...state,
        connectionStatus: "reconnecting",
        error: {
          class: "stream_disconnected",
          message: "Previous stream disconnected"
        }
      },
      {
        sawObservation: false,
        streamCaughtUp: true
      }
    );

    expect(reconnected.connectionStatus).toBe("caught_up");
    expect(reconnected.error).toBeUndefined();
    expect(reconnected.activeRun?.lastAppliedSequence).toBe(3);
  });

  it("keeps real no-observation stream closures user-visible as disconnected", () => {
    const state = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 3, text: "Waiting" }));
    const disconnected = completeRunObservationStreamInControllerState(state, {
      sawObservation: false,
      streamCaughtUp: false
    });

    expect(disconnected.connectionStatus).toBe("disconnected");
    expect(disconnected.error).toMatchObject({
      class: "stream_disconnected",
      message: "Run observation stream disconnected"
    });
  });

  it("uses refreshed snapshots to resolve stale active run state after caught-up streams", () => {
    const stale = createControllerStateFromSnapshot(createSnapshot({ lastSequence: 3, text: "Final" }));
    const caughtUp = completeRunObservationStreamInControllerState(stale, {
      sawObservation: false,
      streamCaughtUp: true
    });
    const refreshed = createControllerStateFromSnapshot(
      createSnapshot({ lastSequence: 3, text: "", activeRun: false }),
      caughtUp
    );

    expect(refreshed.connectionStatus).toBe("idle");
    expect(refreshed.activeRun).toBeUndefined();
    expect(refreshed.error).toBeUndefined();
  });
});

function createSnapshot({
  lastSequence,
  text,
  messages = [],
  activeRun = true,
  runStatus = "running",
  error
}: {
  lastSequence: number;
  text: string;
  messages?: ConversationThreadSnapshot["messages"];
  activeRun?: boolean;
  runStatus?: NonNullable<ConversationThreadSnapshot["activeRun"]>["run"]["status"];
  error?: NonNullable<ConversationThreadSnapshot["activeRun"]>["projection"]["error"];
}): ConversationThreadSnapshot {
  return {
    conversation: {
      id: "conv_1",
      clientInstanceId: "client_1",
      ownerUserId: "user_1",
      ownerExternalUserId: "external_1",
      title: "Test",
      status: "active",
      createdAt: "2026-06-26T10:00:00.000Z",
      updatedAt: "2026-06-26T10:00:00.000Z",
      retainedUntil: "2026-07-26T10:00:00.000Z"
    },
    messages,
    ...(activeRun
      ? {
          activeRun: {
            run: {
              id: "run_1",
              conversationId: "conv_1",
              agentName: "test_agent",
              status: runStatus,
              startedAt: "2026-06-26T10:00:00.000Z",
              updatedAt: "2026-06-26T10:00:00.000Z",
              lastSequence
            },
            projection: {
              runId: "run_1",
              lastSequence,
              status: runStatus,
              parts: text.length > 0
                ? [
                    {
                      type: "text",
                      text
                    }
                  ]
                : [],
              text,
              reasoning: [],
              activeToolCalls: [],
              ...(error ? { error } : {})
            }
          }
        }
      : {}),
    userState: {
      clientInstanceId: "client_1",
      conversationId: "conv_1",
      userId: "user_1",
      updatedAt: "2026-06-26T10:00:00.000Z"
    },
    serverTime: "2026-06-26T10:00:00.000Z"
  };
}

function createObservation<TType extends RunObservation["payload"]["type"]>({
  sequence,
  type,
  payload
}: {
  sequence: number;
  type: TType;
  payload: Record<string, unknown>;
}): RunObservation {
  const createdAt = `2026-06-26T10:00:0${sequence}.000Z`;
  return {
    clientInstanceId: "client_1",
    conversationId: "conv_1",
    ownerUserId: "user_1",
    runId: "run_1",
    sequence,
    type,
    payload: {
      ...payload,
      type,
      runId: "run_1",
      sequence,
      createdAt
    } as RunObservation["payload"],
    createdAt
  };
}
