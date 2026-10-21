import { agentRunProjectionSchema } from "@work-shape/catalyst-api-contract";
import type { AgentRunProjection, Message } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asMessageId,
  asToolCallId,
  createAssistantFinalMetadata,
  createAssistantToolCallsMetadata,
  createUserMessageMetadata,
  projectAgentRun,
  type AgentRun,
  type AgentRuntimeEvent,
  type RunObservation
} from "@work-shape/catalyst-core";
import { toUiMessages } from "./support/chat-ui";

// A message the run's person steered into it (FU-2) stands where the run took it in: after
// the step whose results it followed, before the answer it led to. The thread shows it there
// while the run goes, once it completed, and after a reload from the stored rows (check 85).

const runId = asAgentRunId("run_1");
const at = (second: number) => `2026-10-21T10:00:${String(second).padStart(2, "0")}.000Z`;

function observe(event: AgentRuntimeEvent): RunObservation {
  return {
    clientInstanceId: asClientInstanceId("client_1"),
    runId,
    conversationId: asConversationId("conv_1"),
    ownerUserId: "user_1",
    sequence: event.sequence,
    type: event.type,
    payload: event,
    createdAt: event.createdAt
  };
}

function run(status: AgentRun["status"]): AgentRun {
  return {
    id: runId,
    clientInstanceId: asClientInstanceId("client_1"),
    conversationId: asConversationId("conv_1"),
    ownerUserId: "user_1",
    inputMessageId: asMessageId("msg_go"),
    agentName: "assistant",
    status,
    startedAt: at(0),
    updatedAt: at(9),
    lastSequence: 0,
    correlationId: "correlation_1"
  };
}

const steeredMetadata = createUserMessageMetadata({
  steered: { runId, followUpId: "fu_1", authorUserId: "user_1", typedAt: at(2) }
});

/** The run read the house, took the steer in after the result, then answered. */
function steeredProjection(status: AgentRun["status"], answered: boolean): AgentRunProjection {
  const events: AgentRuntimeEvent[] = [
    { type: "message_delta", runId, sequence: 1, createdAt: at(1), delta: "Looking at the house." },
    {
      type: "tool_call_started",
      runId,
      sequence: 2,
      createdAt: at(1),
      toolCallId: asToolCallId("call_1"),
      toolName: "demo.look",
      input: {}
    },
    {
      type: "user_message_steered",
      runId,
      sequence: 3,
      createdAt: at(3),
      followUpId: "fu_1",
      message: {
        id: asMessageId("msg_steer"),
        role: "user",
        text: "Also check the attic",
        createdAt: at(3),
        ...(steeredMetadata ? { metadata: steeredMetadata } : {})
      }
    },
    // The step's last result can arrive after the steer: it stays with its call.
    {
      type: "tool_call_completed",
      runId,
      sequence: 4,
      createdAt: at(3),
      toolCallId: asToolCallId("call_1"),
      toolName: "demo.look",
      result: { status: "success", output: { rooms: 3 } }
    } as AgentRuntimeEvent,
    ...(answered
      ? [
          {
            type: "message_delta",
            runId,
            sequence: 5,
            createdAt: at(4),
            delta: "The attic is dry."
          } as AgentRuntimeEvent
        ]
      : [])
  ];
  return agentRunProjectionSchema.parse(
    projectAgentRun(run(status), events.map(observe))
  ) as AgentRunProjection;
}

const base = { conversationId: "conv_1", clientInstanceId: "client_1" };
const userGo: Message = { ...base, id: "msg_go", role: "user", text: "Go", createdAt: at(0) };
const steerRow: Message = {
  ...base,
  id: "msg_steer",
  role: "user",
  text: "Also check the attic",
  createdAt: at(3),
  ...(steeredMetadata ? { metadata: steeredMetadata } : {})
};

/** The rows a reload reads: the step, its result, the steer, the answer. */
const storedRows: Message[] = [
  userGo,
  {
    ...base,
    id: "msg_step",
    role: "assistant",
    text: "Looking at the house.",
    createdAt: at(1),
    metadata: createAssistantToolCallsMetadata({
      runId,
      toolCalls: [{ toolCallId: "call_1", toolName: "demo.look", input: {} }]
    })
  },
  steerRow,
  {
    ...base,
    id: "msg_final",
    role: "assistant",
    text: "The attic is dry.",
    createdAt: at(4),
    metadata: createAssistantFinalMetadata({ runId })
  }
];

function shape(messages: ReturnType<typeof toUiMessages>) {
  return messages.map((message) => ({
    role: message.role,
    text: message.parts
      .map((part) => (part.type === "text" ? part.text : part.type))
      .filter((text) => text !== "")
      .join(" | ")
  }));
}

describe("a steered message in the thread", () => {
  it("stands between the run's step and its answer while the run goes", () => {
    const projection = steeredProjection("running", true);
    expect(projection.parts.map((part) => part.type)).toEqual([
      "text",
      "tool_call",
      "user_message",
      "text"
    ]);
    // The tab was told of the steer: the row is in its list, and shown only once.
    const shown = toUiMessages([userGo, steerRow], {
      run: { id: runId, status: "running" },
      projection
    });
    expect(shape(shown)).toEqual([
      { role: "user", text: "Go" },
      { role: "assistant", text: "Looking at the house. | dynamic-tool" },
      { role: "user", text: "Also check the attic" },
      { role: "assistant", text: "The attic is dry." }
    ]);
    // The run goes on in its last answer, which keeps the run's id.
    expect(shown.at(-1)?.id).toBe(runId);
  });

  it("keeps an empty answer after the steer while the next step has not begun", () => {
    const shown = toUiMessages([userGo], {
      run: { id: runId, status: "running" },
      projection: steeredProjection("running", false)
    });
    expect(shape(shown).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant"
    ]);
  });

  it("stands in place once the run completed, from its projection", () => {
    const shown = toUiMessages(storedRows, undefined, {
      [runId]: steeredProjection("completed", true)
    });
    expect(shape(shown)).toEqual([
      { role: "user", text: "Go" },
      { role: "assistant", text: "Looking at the house. | dynamic-tool" },
      { role: "user", text: "Also check the attic" },
      { role: "assistant", text: "The attic is dry." }
    ]);
  });

  it("stands in place after a reload, from the stored rows", () => {
    const shown = toUiMessages(storedRows);
    expect(shape(shown)).toEqual([
      { role: "user", text: "Go" },
      { role: "assistant", text: "Looking at the house. | dynamic-tool" },
      { role: "user", text: "Also check the attic" },
      { role: "assistant", text: "The attic is dry." }
    ]);
    expect(shown.map((message) => message.id)).toEqual([
      "msg_go",
      "msg_step",
      "msg_steer",
      "msg_final"
    ]);
  });
});
