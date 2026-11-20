import { describe, expect, it } from "vitest";
import type { AgentRunProjection, Message } from "@work-shape/catalyst-api-client";
import {
  createAssistantToolCallsMetadata,
  createToolResultMetadata
} from "@work-shape/catalyst-core";
import {
  createVisibleFinalAssistantPartIndices,
  findFinalAssistantTextPartIndex,
  toUiMessages
} from "./support/chat-ui";
import { required } from "./support/assertions";

// A view the agent shows, then a question about it, in one run. A question ends the run's turn
// (ASK-1), so the run has no final answer. The view still stands with the run's answer, above
// the question, as it does under a final answer. Fails without the change: the run's view stood
// only in a row of the work, and the thread showed the question without it.

const runId = "run_question";
const view = {
  kind: "html.rendered",
  version: 1,
  mode: "inline",
  displayId: "display_proposal",
  title: "Proposal",
  data: { title: "Proposal", html: "<p>Split the skill in two.</p>" }
};
const question = {
  question: "Where should the mail go?",
  options: [{ label: "Into part one", recommended: true }, { label: "Into part two" }]
};

function message(id: string, role: Message["role"], text: string, metadata: Message["metadata"]) {
  return {
    id,
    conversationId: "conv_test",
    clientInstanceId: "client_test",
    role,
    text,
    createdAt: `2026-11-20T15:26:${String(id.length).padStart(2, "0")}.000Z`,
    metadata
  } satisfies Message;
}

function persistedRun(): Message[] {
  const showCall = { toolCallId: "call_show", toolName: "show_view", input: { title: "Proposal" } };
  const askCall = { toolCallId: "call_ask", toolName: "ask_question", input: question };
  return [
    message("msg_user", "user", "Split the skill", {}),
    message(
      "msg_show",
      "assistant",
      "Here is my proposal.",
      createAssistantToolCallsMetadata({ runId, toolCalls: [showCall] })
    ),
    message(
      "msg_show_result",
      "tool",
      "{}",
      createToolResultMetadata({
        runId,
        toolCall: showCall,
        result: { status: "success", output: { displayed: true }, display: view },
        modelOutput: { text: "{}" }
      })
    ),
    message(
      "msg_ask",
      "assistant",
      "",
      createAssistantToolCallsMetadata({ runId, toolCalls: [askCall] })
    ),
    message(
      "msg_ask_result",
      "tool",
      "{}",
      createToolResultMetadata({
        runId,
        toolCall: askCall,
        result: { status: "success", output: question },
        modelOutput: { text: "{}" }
      })
    )
  ];
}

function partKinds(parts: readonly { type: string; toolName?: string }[]): string[] {
  return parts.map((part) => (part.type === "dynamic-tool" ? `tool:${part.toolName}` : part.type));
}

describe("a view shown before a question of the same run", () => {
  it("stands with the run's answer, above the question, once the run is stored", () => {
    const projected = toUiMessages(persistedRun());
    const answers = projected.filter((entry) => entry.role === "assistant");

    // The run is one answer, as a run with a final answer is.
    expect(answers).toHaveLength(1);
    const answer = required(answers[0]);
    expect(partKinds(answer.parts)).toEqual([
      "text",
      "tool:show_view",
      "data-workspace-promoted-surfaces",
      "tool:ask_question"
    ]);
    expect(answer.parts[2]).toMatchObject({
      data: { surfaces: [{ surfaceId: "display_proposal", title: "Proposal" }] }
    });
    // It names its run as finished, so it collapses its work and shows its view as one does.
    expect(answer.metadata).toMatchObject({ custom: { completedRunId: runId } });

    // The thread shows the answer's text, then the view, then the question; the call that
    // showed the view is a step of the work.
    const outline = answer.parts.map((part) => ({
      type: part.type === "dynamic-tool" ? "tool-call" : part.type,
      ...("toolName" in part ? { toolName: part.toolName } : {}),
      ...("text" in part ? { text: part.text } : {}),
      ...("output" in part ? { result: part.output } : {}),
      ...("data" in part ? { data: part.data } : {})
    }));
    const finalTextIndex = findFinalAssistantTextPartIndex(outline);
    expect(createVisibleFinalAssistantPartIndices(outline, finalTextIndex)).toEqual([0, 2, 3]);
  });

  it("stands above the question while the finished run is still the live one", () => {
    const projection: AgentRunProjection = {
      runId,
      lastSequence: 6,
      status: "completed",
      text: "Here is my proposal.",
      reasoning: [],
      activeToolCalls: [],
      parts: [
        { type: "text", text: "Here is my proposal." },
        {
          type: "tool_call",
          toolCallId: "call_show",
          toolName: "show_view",
          input: {},
          state: "output_available",
          output: { status: "success", output: { displayed: true }, display: view }
        },
        {
          type: "tool_call",
          toolCallId: "call_ask",
          toolName: "ask_question",
          input: question,
          state: "output_available",
          output: { status: "success", output: question }
        }
      ]
    };
    const [answer] = toUiMessages([], { run: { id: runId, status: "completed" }, projection });
    expect(partKinds(required(answer).parts)).toEqual([
      "text",
      "tool:show_view",
      "data-workspace-promoted-surfaces",
      "tool:ask_question"
    ]);
  });

  it("leaves a run that is still going without its own end", () => {
    // The question's message is the last of the run only once the run stopped there; a run
    // that went on after it ends with its final answer, as before.
    const messages = persistedRun().slice(0, 3);
    const answers = toUiMessages(messages).filter((entry) => entry.role === "assistant");
    expect(answers).toHaveLength(1);
    expect(partKinds(required(answers[0]).parts)).toEqual(["text", "tool:show_view"]);
  });
});
