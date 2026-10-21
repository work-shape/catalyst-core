import { describe, expect, it } from "vitest";
import type { ModelAdapterRequest, ModelTool } from "@work-shape/catalyst-model-provider";
import { toBedrockRequest } from "../packages/model-provider/src/adapters/bedrock-mapping";
import { toVertexRequest } from "../packages/model-provider/src/adapters/google-vertex-mapping";
import {
  createProviderToolMetadata,
  toOpenAiChatMessages,
  toOpenAiResponsesInput
} from "../packages/model-provider/src/openai-compatible-mapping";

// FU-2: a steered message is a user message after all tool results of a step. Each provider
// takes it in the order its rules require: the results answer the calls first, then the text
// (events-workflows-and-guardrails check 85).

const tool: ModelTool = {
  name: "get_weather",
  description: "Reads the weather of a city.",
  inputJsonSchema: { type: "object", properties: { city: { type: "string" } } }
};

const steered: ModelAdapterRequest = {
  model: "test-model",
  tools: [tool],
  messages: [
    { role: "system", content: "Answer briefly." },
    { role: "user", content: "Weather in Berlin and Hamburg?" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { toolCallId: "call_1", toolName: "get_weather", input: { city: "Berlin" } },
        { toolCallId: "call_2", toolName: "get_weather", input: { city: "Hamburg" } }
      ]
    },
    { role: "tool", toolCallId: "call_1", content: "Sunny" },
    { role: "tool", toolCallId: "call_2", content: "Rain" },
    { role: "user", content: "Also Munich, please." }
  ]
};

describe("a steered message after a step's tool results", () => {
  it("lands on Bedrock after both results in the same user turn", () => {
    const { body } = toBedrockRequest(steered, "bedrock");
    expect(body.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    const turn = body.messages.at(-1)?.content;
    expect(Array.isArray(turn) ? turn.map((block) => block.type) : turn).toEqual([
      "tool_result",
      "tool_result",
      "text"
    ]);
    expect(JSON.stringify(turn)).toContain("Also Munich, please.");
  });

  it("follows every tool message on an OpenAI-compatible chat request and in the Responses input", () => {
    const names = createProviderToolMetadata(steered.tools);
    const chat = toOpenAiChatMessages(steered.messages, names);
    expect(chat.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "tool",
      "user"
    ]);
    expect(JSON.stringify(chat.at(-1))).toContain("Also Munich, please.");

    const input = toOpenAiResponsesInput(steered.messages, names);
    const kinds = input.map((item) =>
      "type" in item && item.type ? item.type : "role" in item ? item.role : "?"
    );
    const lastOutput = kinds.lastIndexOf("function_call_output");
    expect(lastOutput).toBeGreaterThan(kinds.indexOf("function_call"));
    expect(kinds.slice(lastOutput + 1)).toHaveLength(1);
    expect(JSON.stringify(input.at(-1))).toContain("Also Munich, please.");
  });

  it("follows the function responses on Vertex, in the same user turn", () => {
    const { contents } = toVertexRequest(steered);
    expect(contents.map((content) => content.role)).toEqual(["user", "model", "user"]);
    const parts = contents.at(-1)?.parts ?? [];
    expect(parts.map((part) => Object.keys(part)[0])).toEqual([
      "functionResponse",
      "functionResponse",
      "text"
    ]);
    expect(parts.at(-1)).toEqual({ text: "Also Munich, please." });
  });
});
