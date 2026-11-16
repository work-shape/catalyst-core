import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelMessage, ModelTool } from "@work-shape/catalyst-model-provider";
import {
  answerWith,
  bedrock,
  bedrockEventStream,
  collect,
  message
} from "./support/bedrock-adapter";
import { bedrockChunk } from "./support/bedrock-event-stream";
import { RECORDED_BEDROCK_PROFILE } from "./support/model-adapter-recordings";

/**
 * Prompt caching through the Bedrock adapter: where a call of a conversation sets its cache
 * breakpoints, and what the usage says was read from and written to the cache.
 */

const BREAKPOINT = { type: "ephemeral" };
const SIGNATURE = "cmVjb3JkZWQtc2lnbmF0dXJl";
const tools: ModelTool[] = [
  { name: "get_weather", description: "Reads the weather of a city." },
  { name: "get_time", description: "Reads the time of a city." }
];
const user = (content: string): ModelMessage => ({ role: "user", content });

afterEach(() => {
  vi.unstubAllGlobals();
});

type Block = Record<string, unknown>;

const isBlock = (value: unknown): value is Block => typeof value === "object" && value !== null;

/** The objects of a list in the sent body, or none where the body holds no list there. */
const blocksOf = (value: unknown): Block[] => (Array.isArray(value) ? value.filter(isBlock) : []);

/** The content blocks of the sent body's message at `index`. */
const contentOf = (body: unknown, index: number): Block[] =>
  blocksOf(blocksOf(isBlock(body) ? body.messages : undefined)[index]?.content);

/** Every block of the request that carries a breakpoint, by where it stands. */
function breakpoints(body: unknown): string[] {
  if (!isBlock(body)) return [];
  const marked = (blocks: unknown, where: string): string[] =>
    blocksOf(blocks).flatMap((block, index) =>
      block.cache_control === undefined ? [] : [`${where}[${index}]`]
    );
  return [
    ...marked(body.tools, "tools"),
    ...marked(body.system, "system"),
    ...blocksOf(body.messages).flatMap((entry, index) =>
      marked(entry.content, `messages[${index}]`)
    )
  ];
}

describe("Bedrock adapter: prompt cache", () => {
  it("marks the tools, the instructions, the previous request's end and its own end", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Sunny." }])));
    const adapter = await bedrock();

    await adapter.complete({
      model: RECORDED_BEDROCK_PROFILE,
      cacheKey: "conv_1",
      tools,
      reasoningEffort: "medium",
      continuation: {
        providerId: "bedrock",
        state: {
          kind: "bedrock_messages",
          turns: [
            {
              toolCallIds: ["toolu_1"],
              blocks: [
                { type: "thinking", thinking: "", signature: SIGNATURE },
                { type: "tool_use", id: "toolu_1" }
              ]
            }
          ]
        }
      },
      messages: [
        { role: "system", content: "You answer questions about the weather." },
        user("Hello."),
        { role: "assistant", content: "Hello. Ask me about the weather." },
        user("What is the weather in Berlin?"),
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "toolu_1", toolName: "get_weather", input: { city: "Berlin" } }]
        },
        // A note a later system message adds is sent with the system prompt.
        { role: "system", content: "The person approved the call." },
        { role: "tool", toolCallId: "toolu_1", content: "Sunny, 21 degrees." }
      ]
    });

    const body = sent[0]?.body;
    expect(breakpoints(body)).toEqual([
      "tools[1]",
      // The instructions, not the note after them.
      "system[0]",
      // Where the previous request of the run ended, before the model's latest answer.
      "messages[2][0]",
      "messages[4][0]"
    ]);
    // The thinking of the tool-use turn goes back unchanged and without a breakpoint.
    expect(contentOf(body, 3)[0]).toEqual({
      type: "thinking",
      thinking: "",
      signature: SIGNATURE
    });
    expect(contentOf(body, 4).at(-1)).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_1",
      content: [{ type: "text", text: "Sunny, 21 degrees." }],
      cache_control: BREAKPOINT
    });
  });

  it("marks the end of the first request of a conversation, with no earlier end to mark", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      cacheKey: "conv_2",
      tools: [],
      messages: [{ role: "system", content: "Answer briefly." }, user("Say hello.")]
    });

    const body = sent[0]?.body;
    expect(breakpoints(body)).toEqual(["system[0]", "messages[0][0]"]);
    expect(body).not.toHaveProperty("tools");
  });

  it("sends a call of no conversation without a breakpoint", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "A title." }])));

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      tools,
      messages: [{ role: "system", content: "Write a title." }, user("Say hello.")]
    });

    expect(JSON.stringify(sent[0]?.body)).not.toContain("cache_control");
  });

  it("reports what a stream read from and wrote to the cache", async () => {
    answerWith(() =>
      bedrockEventStream([
        bedrockChunk({
          type: "message_start",
          message: {
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 2_000,
              cache_creation_input_tokens: 300,
              output_tokens: 1
            }
          }
        }),
        bedrockChunk({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" }
        }),
        bedrockChunk({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "Hello." }
        }),
        bedrockChunk({ type: "content_block_stop", index: 0 }),
        bedrockChunk({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 7 }
        }),
        bedrockChunk({ type: "message_stop" })
      ])
    );

    const events = await collect(
      (await bedrock()).stream({
        model: RECORDED_BEDROCK_PROFILE,
        cacheKey: "conv_3",
        tools: [],
        messages: [user("Say hello.")]
      })
    );

    const completed = events.at(-1);
    if (completed?.type !== "completed") throw new Error("The stream did not complete");
    expect(completed.completion.usage).toEqual({
      inputTokens: 2_312,
      cachedInputTokens: 2_000,
      cacheWriteInputTokens: 300,
      outputTokens: 7,
      totalTokens: 2_319,
      source: "provider_reported",
      webSearchCallCount: 0
    });
  });
});
