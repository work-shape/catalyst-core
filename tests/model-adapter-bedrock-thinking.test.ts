import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReasoningEffortConfig } from "@vivd-catalyst/core";
import type {
  ModelMessage,
  ModelProviderContinuation,
  ModelTool
} from "@vivd-catalyst/model-provider";
import { answerWith, bedrock, collect, hello, message } from "./support/bedrock-adapter";
import {
  RECORDED_BEDROCK_PROFILE,
  loadModelAdapterRecording,
  replayModelAdapterRecording
} from "./support/model-adapter-recordings";

/**
 * Thinking through the Bedrock adapter: what a reasoning effort sends, what the model's thinking
 * becomes, and how the thinking of a turn that called a tool goes back with the tool's result.
 * The recording is built by hand from the Messages format; its signature and its redacted block
 * are made up and open nothing.
 */

const weatherTool: ModelTool = {
  name: "get_weather",
  description: "Reads the weather of a city.",
  inputJsonSchema: { type: "object", properties: { city: { type: "string" } } }
};
const question: ModelMessage = { role: "user", content: "What is the weather in Berlin?" };
const SIGNATURE = "cmVjb3JkZWQtc2lnbmF0dXJl";
const REDACTED = "cmVjb3JkZWQtcmVkYWN0ZWQtdGhpbmtpbmc=";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Bedrock adapter: thinking", () => {
  it.each(["low", "medium", "high"] as const)(
    "asks for adaptive thinking with the effort '%s' and sends no thinking budget",
    async (effort) => {
      const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));

      await (
        await bedrock()
      ).complete({ model: RECORDED_BEDROCK_PROFILE, ...hello, reasoningEffort: effort });

      expect(sent[0]?.body).toMatchObject({
        // The one hard limit on thinking and answer together.
        max_tokens: 16_000,
        thinking: { type: "adaptive" },
        output_config: { effort }
      });
      expect(JSON.stringify(sent[0]?.body)).not.toContain("budget_tokens");
    }
  );

  it.each([undefined, "none"] as const)(
    "sends no thinking setting for the effort '%s'",
    async (effort: ReasoningEffortConfig | undefined) => {
      const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));

      await (
        await bedrock()
      ).complete({
        model: RECORDED_BEDROCK_PROFILE,
        ...hello,
        ...(effort === undefined ? {} : { reasoningEffort: effort })
      });

      expect(sent[0]?.body).not.toHaveProperty("thinking");
      expect(sent[0]?.body).not.toHaveProperty("output_config");
    }
  );

  it("streams thinking as reasoning and sends the turn back unchanged with the tool's result", async () => {
    const replayed = replayModelAdapterRecording(
      loadModelAdapterRecording("aws-bedrock", "thinking-tool-loop")
    );
    const adapter = await bedrock();

    const events = await collect(
      adapter.stream({
        model: RECORDED_BEDROCK_PROFILE,
        messages: [question],
        tools: [weatherTool],
        reasoningEffort: "medium"
      })
    );

    // The model's thinking reaches the product as reasoning. The signature and the redacted
    // block are never shown.
    expect(events.filter((event) => event.type === "reasoning_delta")).toEqual([
      { type: "reasoning_delta", id: "thinking_0", delta: "The user asks for the weather. " },
      { type: "reasoning_delta", id: "thinking_0", delta: "The tool reads it." }
    ]);
    expect(JSON.stringify(events.filter((event) => event.type !== "completed"))).not.toMatch(
      new RegExp(`${SIGNATURE}|${REDACTED}`, "u")
    );
    const completed = events.at(-1);
    if (completed?.type !== "completed") throw new Error("The stream did not complete");
    const { completion } = completed;
    expect(completion.text).toBe("I will look it up.");
    expect(completion.toolCalls).toEqual([
      { toolCallId: "toolu_bdrk_recorded_1", toolName: "get_weather", input: { city: "Berlin" } }
    ]);
    // Thinking is output: Bedrock counts it into the output tokens, and so does the usage.
    expect(completion.usage).toMatchObject({
      inputTokens: 60,
      outputTokens: 140,
      totalTokens: 200,
      source: "provider_reported"
    });
    expect(completion.continuation).toEqual({
      providerId: "bedrock",
      state: {
        kind: "bedrock_messages",
        turns: [
          {
            toolCallIds: ["toolu_bdrk_recorded_1"],
            blocks: [
              {
                type: "thinking",
                thinking: "The user asks for the weather. The tool reads it.",
                signature: SIGNATURE
              },
              { type: "redacted_thinking", data: REDACTED },
              { type: "text", text: "I will look it up." },
              { type: "tool_use", id: "toolu_bdrk_recorded_1" }
            ]
          }
        ]
      }
    });

    // The second exchange of the recording holds the turn as Bedrock must get it back: the
    // replay fails the call when one block differs or stands in another place.
    const answer = await adapter.complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        question,
        { role: "assistant", content: completion.text, toolCalls: completion.toolCalls },
        { role: "tool", toolCallId: "toolu_bdrk_recorded_1", content: '{"temperatureC":18}' }
      ],
      tools: [weatherTool],
      reasoningEffort: "medium",
      ...(completion.continuation ? { continuation: completion.continuation } : {})
    });

    expect(replayed.count()).toBe(2);
    expect(answer.text).toBe("It is 18 degrees in Berlin.");
    expect(answer.usage).toMatchObject({ inputTokens: 150, outputTokens: 45 });
    // The run's tool-use turn is still in the conversation, so its thinking is handed on. The
    // answer itself called no tool: its own thinking is not kept.
    expect(answer.continuation).toEqual(completion.continuation);
  });

  it("keeps the thinking of an answer that is not streamed, in the order of its blocks", async () => {
    answerWith(() =>
      Response.json(
        message(
          [
            { type: "thinking", thinking: "First.", signature: SIGNATURE },
            { type: "tool_use", id: "toolu_a", name: "get_weather", input: { city: "Berlin" } },
            { type: "thinking", thinking: "No signature, so it is not sent back." },
            { type: "block_of_a_later_release" },
            { type: "tool_use", id: "toolu_b", name: "get_weather", input: { city: "Paris" } }
          ],
          "tool_use"
        )
      )
    );

    const completion = await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [question],
      tools: [weatherTool],
      reasoningEffort: "high"
    });

    expect(turnsOf(completion.continuation)).toEqual([
      {
        toolCallIds: ["toolu_a", "toolu_b"],
        blocks: [
          { type: "thinking", thinking: "First.", signature: SIGNATURE },
          { type: "tool_use", id: "toolu_a" },
          { type: "tool_use", id: "toolu_b" }
        ]
      }
    ]);
  });

  it("hands on nothing for an answer that thought and called no tool", async () => {
    answerWith(() =>
      Response.json(
        message([
          { type: "thinking", thinking: "Considering.", signature: SIGNATURE },
          { type: "text", text: "Hello." }
        ])
      )
    );

    const completion = await (
      await bedrock()
    ).complete({ model: RECORDED_BEDROCK_PROFILE, ...hello, reasoningEffort: "low" });

    expect(completion).not.toHaveProperty("continuation");
  });

  it.each([
    [
      "another provider entry handed it on",
      { providerId: "other", state: thinkingState(["toolu_a"]) }
    ],
    [
      "it holds the turn of other tool calls",
      { providerId: "bedrock", state: thinkingState(["toolu_z"]) }
    ],
    [
      "one of its blocks is not a block of the format",
      {
        providerId: "bedrock",
        state: {
          kind: "bedrock_messages",
          turns: [{ toolCallIds: ["toolu_a"], blocks: [{ type: "thinking", thinking: "Cut." }] }]
        }
      }
    ],
    ["it is the state of another format", { providerId: "bedrock", state: { kind: "responses" } }]
  ] satisfies [string, ModelProviderContinuation][])(
    "sends a tool-use turn without thinking when %s",
    async (_name, continuation) => {
      const sent = answerWith(() => Response.json(message([{ type: "text", text: "18." }])));

      const completion = await (
        await bedrock()
      ).complete({
        model: RECORDED_BEDROCK_PROFILE,
        messages: [
          question,
          {
            role: "assistant",
            content: "I will look it up.",
            toolCalls: [{ toolCallId: "toolu_a", toolName: "get_weather", input: {} }]
          },
          { role: "tool", toolCallId: "toolu_a", content: "18" }
        ],
        tools: [weatherTool],
        reasoningEffort: "medium",
        continuation
      });

      expect(sent[0]?.body).toMatchObject({
        messages: [
          { role: "user" },
          {
            role: "assistant",
            content: [
              { type: "text", text: "I will look it up." },
              { type: "tool_use", id: "toolu_a", name: "get_weather", input: {} }
            ]
          },
          { role: "user" }
        ]
      });
      expect(JSON.stringify(sent[0]?.body)).not.toContain(SIGNATURE);
      // A turn that was not sent is not handed on again.
      expect(completion).not.toHaveProperty("continuation");
    }
  );
});

function thinkingState(toolCallIds: string[]): unknown {
  return {
    kind: "bedrock_messages",
    turns: [
      {
        toolCallIds,
        blocks: [
          { type: "thinking", thinking: "Considering.", signature: SIGNATURE },
          ...toolCallIds.map((id) => ({ type: "tool_use", id }))
        ]
      }
    ]
  };
}

function turnsOf(continuation: ModelProviderContinuation | undefined): unknown {
  const state: unknown = continuation?.state;
  return state !== null && typeof state === "object" && "turns" in state ? state.turns : undefined;
}
