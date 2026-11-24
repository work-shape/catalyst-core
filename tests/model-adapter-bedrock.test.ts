import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, reasoningEffortChoiceForBinding } from "@work-shape/catalyst-core";
import {
  ModelProviderError,
  type ModelAdapter,
  type ModelCallStreamEvent,
  type ModelMessage,
  type ModelProviderContinuation,
  type ModelTool
} from "@work-shape/catalyst-model-provider";
import {
  BEDROCK_TEST_ACCOUNT_ID,
  answerWith,
  bedrock,
  bedrockEventStream,
  bedrockFactory,
  bedrockGateway,
  bedrockRefusal,
  captured,
  collect,
  hello,
  message
} from "./support/bedrock-adapter";
import {
  bedrockChunk,
  bedrockEventStreamMessage,
  bedrockStreamException
} from "./support/bedrock-event-stream";
import {
  RECORDED_BEDROCK_PROFILE,
  loadModelAdapterRecording,
  replayModelAdapterRecording
} from "./support/model-adapter-recordings";
/**
 * What the Bedrock adapter guarantees on the wire, on exchanges built by hand from the Anthropic
 * Messages format and Bedrock's stream framing. The shapes of the streamed tool call and of the
 * refusals were read from live answers to synthetic prompts; no answer is stored here.
 */

const ACCOUNT_ID = BEDROCK_TEST_ACCOUNT_ID;
const user = (content: ModelMessage["content"]): ModelMessage => ({ role: "user", content });
const weatherTool: ModelTool = {
  name: "get_weather",
  description: "Reads the weather of a city.",
  inputJsonSchema: { type: "object", properties: { city: { type: "string" } } }
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Bedrock adapter: what it reads", () => {
  it("counts cache reads and writes into the input and reports the read and the written share", async () => {
    answerWith(() =>
      Response.json(
        message([{ type: "text", text: "Hello." }], "end_turn", {
          input_tokens: 8,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 3,
          output_tokens: 5
        })
      )
    );

    const completion = await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      ...hello
    });

    expect(completion.usage).toEqual({
      inputTokens: 15,
      cachedInputTokens: 4,
      cacheWriteInputTokens: 3,
      outputTokens: 5,
      totalTokens: 20,
      source: "provider_reported",
      webSearchCallCount: 0
    });
  });

  it("passes over thinking blocks and block types it does not know", async () => {
    answerWith(() =>
      Response.json(
        message([
          { type: "thinking", thinking: "", signature: "c2lnbmF0dXJl" },
          { type: "redacted_thinking", data: "b3BhcXVl" },
          { type: "block_of_a_later_release", payload: { nested: true } },
          { type: "text", text: "Hello." },
          "not a block"
        ])
      )
    );

    const completion = await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      ...hello
    });

    expect(completion).toMatchObject({ text: "Hello.", toolCalls: [] });
  });

  it("assembles parallel tool calls from fragments, whatever the bytes of the stream are cut into", async () => {
    const stream = concatBytes([
      bedrockChunk({ type: "message_start", message: { usage: { input_tokens: 40 } } }),
      bedrockChunk({ type: "ping" }),
      toolStart(0, "toolu_a", "get_weather"),
      jsonDelta(0, ""),
      jsonDelta(0, '{"ci'),
      toolStart(1, "toolu_b", "get_weather"),
      jsonDelta(1, '{"city": "Par'),
      jsonDelta(0, 'ty": "Ber'),
      jsonDelta(1, 'is"}'),
      jsonDelta(0, 'lin"}'),
      bedrockChunk({ type: "content_block_stop", index: 0 }),
      bedrockChunk({ type: "content_block_stop", index: 1 }),
      bedrockChunk({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { input_tokens: 40, output_tokens: 18 }
      }),
      bedrockChunk({ type: "message_stop" })
    ]);
    // Seven bytes at a time: every prelude, header and payload is cut somewhere.
    answerWith(() => bedrockEventStream(slices(stream, 7)));

    const events = await collect(
      (await bedrock()).stream({
        model: RECORDED_BEDROCK_PROFILE,
        messages: [user("Weather in Berlin and Paris?")],
        tools: [weatherTool]
      })
    );

    expect(events.filter((event) => event.type === "tool_call_preparing")).toEqual([
      { type: "tool_call_preparing", toolCallId: "toolu_a", toolName: "get_weather" },
      { type: "tool_call_preparing", toolCallId: "toolu_b", toolName: "get_weather" }
    ]);
    expect(events.at(-2)).toMatchObject({ type: "usage_reported" });
    expect(events.at(-1)).toEqual({
      type: "completed",
      completion: {
        text: "",
        toolCalls: [
          { toolCallId: "toolu_a", toolName: "get_weather", input: { city: "Berlin" } },
          { toolCallId: "toolu_b", toolName: "get_weather", input: { city: "Paris" } }
        ],
        sources: [],
        citations: [],
        usage: {
          inputTokens: 40,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          outputTokens: 18,
          totalTokens: 58,
          source: "provider_reported",
          webSearchCallCount: 0
        }
      }
    });
  });

  it("keeps the broken input of a tool call the output limit cut off", async () => {
    answerWith(() =>
      bedrockEventStream([
        toolStart(0, "toolu_a", "get_weather"),
        jsonDelta(0, '{"city": "Ber'),
        bedrockChunk({
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { input_tokens: 40, output_tokens: 16_000 }
        }),
        bedrockChunk({ type: "message_stop" })
      ])
    );

    const events = await collect(
      (await bedrock()).stream({
        model: RECORDED_BEDROCK_PROFILE,
        messages: [user("Weather?")],
        tools: [weatherTool]
      })
    );

    const completed = events.at(-1);
    if (completed?.type !== "completed") throw new Error("The stream did not complete");
    expect(completed.completion.toolCalls).toEqual([
      {
        toolCallId: "toolu_a",
        toolName: "get_weather",
        input: {},
        inputParseError: {
          code: "invalid_json",
          message: "Tool input must be valid JSON",
          rawInput: '{"city": "Ber'
        }
      }
    ]);
  });

  it.each([
    ["a list", '["Berlin"]'],
    ["nothing", "null"]
  ])("hands on a tool call whose input is %s as one with invalid arguments", async (_name, raw) => {
    const invalid = {
      toolCallId: "toolu_a",
      toolName: "get_weather",
      input: {},
      inputParseError: {
        code: "invalid_json",
        message: "Tool input must be a JSON object",
        rawInput: raw
      }
    };
    const request = {
      model: RECORDED_BEDROCK_PROFILE,
      messages: [user("Weather?")],
      tools: [weatherTool]
    };
    const ending = [
      bedrockChunk({
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { input_tokens: 40, output_tokens: 9 }
      }),
      bedrockChunk({ type: "message_stop" })
    ];

    // The input in fragments, as a stream sends it.
    answerWith(() =>
      bedrockEventStream([
        toolStart(0, "toolu_a", "get_weather"),
        jsonDelta(0, raw.slice(0, 1)),
        jsonDelta(0, raw.slice(1)),
        ...ending
      ])
    );
    const streamed = (await collect((await bedrock()).stream(request))).at(-1);
    expect(streamed).toMatchObject({ type: "completed", completion: { toolCalls: [invalid] } });
    vi.unstubAllGlobals();

    // The input whole, in the block's start and in an answer that is not streamed.
    const block: unknown = {
      type: "tool_use",
      id: "toolu_a",
      name: "get_weather",
      input: JSON.parse(raw)
    };
    answerWith(() =>
      bedrockEventStream([
        bedrockChunk({ type: "content_block_start", index: 0, content_block: block }),
        ...ending
      ])
    );
    if (raw !== "null") {
      const whole = (await collect((await bedrock()).stream(request))).at(-1);
      expect(whole).toMatchObject({ type: "completed", completion: { toolCalls: [invalid] } });
    }
    vi.unstubAllGlobals();
    answerWith(() => Response.json(message([block], "tool_use")));
    if (raw !== "null") {
      expect((await (await bedrock()).complete(request)).toolCalls).toEqual([invalid]);
    }
  });

  it("ignores events, deltas, blocks and stream messages of types it does not know", async () => {
    answerWith(() =>
      bedrockEventStream([
        bedrockEventStreamMessage(
          { ":event-type": "metadata_of_a_later_release", ":message-type": "event" },
          new TextEncoder().encode('{"anything":true}')
        ),
        bedrockEventStreamMessage(
          { ":event-type": "chunk", ":message-type": "event" },
          new TextEncoder().encode('{"no_bytes_here":1}')
        ),
        bedrockChunk({ type: "message_start", message: { usage: { input_tokens: 8 } } }),
        bedrockChunk({ type: "event_of_a_later_release", index: 0, delta: { type: "x" } }),
        bedrockChunk({
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" }
        }),
        bedrockChunk({
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "Considering." }
        }),
        bedrockChunk({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "c2lnbmF0dXJl" }
        }),
        bedrockChunk({
          type: "content_block_start",
          index: 1,
          content_block: { type: "block_of_a_later_release" }
        }),
        bedrockChunk({
          type: "content_block_delta",
          index: 1,
          delta: { type: "delta_of_a_later_release", partial_json: 7 }
        }),
        bedrockChunk({ type: "content_block_start", index: 2, content_block: { type: "text" } }),
        bedrockChunk({
          type: "content_block_delta",
          index: 2,
          delta: { type: "text_delta", text: "Hello." }
        }),
        bedrockChunk({
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 }
        }),
        bedrockChunk({ type: "message_stop", "amazon-bedrock-invocationMetrics": {} })
      ])
    );

    const events = await collect(
      (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
    );

    expect(events.map((event) => event.type)).toEqual([
      "reasoning_delta",
      "text_delta",
      "usage_reported",
      "completed"
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      // The input count came with `message_start`, the output count with the end.
      completion: { text: "Hello.", toolCalls: [], usage: { inputTokens: 8, outputTokens: 5 } }
    });
  });
});

describe("Bedrock adapter: failures", () => {
  it("reports throttling as a rate limit, with Bedrock's words kept for the log alone", async () => {
    answerWith(() =>
      bedrockRefusal(
        429,
        "ThrottlingException",
        "Too many requests, please wait before trying again.",
        {
          "retry-after": "7"
        }
      )
    );

    const failure = await complete(await bedrock());

    expect(failure).toMatchObject({
      kind: "rate_limit",
      status: 429,
      retryable: true,
      retryAfterMs: 7_000,
      providerCode: "ThrottlingException",
      providerRequestId: "0f8fad5b-d9cb-469f-a165-70867728950e",
      message: "Model provider request failed"
    });
    expect(failure.providerMessage).toBe("Too many requests, please wait before trying again.");
    expect(readable(failure)).not.toContain("Too many requests");
  });

  it.each([
    ["throttlingException", "rate_limit", 429, true],
    ["modelStreamErrorException", "server_error", 424, true],
    ["modelTimeoutException", "timeout", 408, true],
    ["accessDeniedException", "invalid_request", 403, false],
    ["exceptionOfALaterRelease", "server_error", undefined, false]
  ] as const)(
    "types %s inside a stream that had begun as %s",
    async (type, kind, status, retryable) => {
      answerWith(() =>
        bedrockEventStream([
          bedrockChunk({ type: "message_start", message: { usage: { input_tokens: 8 } } }),
          bedrockStreamException(type, "SECRET-PROVIDER-WORDS")
        ])
      );

      const failure = await collect(
        (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
      ).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelProviderError);
      expect(failure).toMatchObject({ kind, status, retryable, providerCode: type });
      expect(readable(failure)).not.toContain("SECRET-PROVIDER-WORDS");
    }
  );

  it("types an overloaded model inside a stream as a server error", async () => {
    answerWith(() =>
      bedrockEventStream([
        bedrockChunk({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })
      ])
    );

    const failure = await collect(
      (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      kind: "server_error",
      retryable: true,
      providerCode: "overloaded_error"
    });
  });

  it.each([503, 529])("reports status %i as a server error", async (status) => {
    answerWith(() => bedrockRefusal(status, "ModelErrorException", "The model failed."));

    expect(await complete(await bedrock())).toMatchObject({
      kind: "server_error",
      status,
      retryable: true
    });
  });

  it("reports denied model access as a request that is not sent again, without the account id", async () => {
    const denied =
      `User: arn:aws:iam::${ACCOUNT_ID}:user/workshape/bedrock/consumer is not authorized to perform: ` +
      `bedrock:InvokeModel on resource: arn:aws:bedrock:eu-central-1:${ACCOUNT_ID}:application-inference-profile/abc`;
    const bodies: Record<string, string>[] = [{ message: denied }, { Message: denied }];
    for (const body of bodies) {
      answerWith(() => bedrockRefusal(403, "AccessDeniedException", body));
      const adapter = await bedrock();

      for (const failure of [
        await complete(adapter),
        await collect(adapter.stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })).catch(
          (error: unknown) => error
        )
      ]) {
        if (!(failure instanceof ModelProviderError)) throw new Error("Expected a provider error");
        expect(failure).toMatchObject({
          kind: "invalid_request",
          status: 403,
          retryable: false,
          providerCode: "AccessDeniedException",
          message: "Model provider request failed"
        });
        // Nothing a caller reads holds Bedrock's words or an ARN.
        expect(readable(failure)).not.toMatch(/arn:aws|not authorized|\d{12}/u);
        // The log line keeps the words, with the account id masked.
        expect(failure.providerMessage).toContain("is not authorized to perform");
        expect(failure.providerMessage).not.toContain(ACCOUNT_ID);
      }
      vi.unstubAllGlobals();
    }
  });

  it("tells the user when the conversation is longer than the model's context", async () => {
    answerWith(() =>
      bedrockRefusal(
        400,
        "ValidationException",
        "prompt is too long: 1200000 tokens > 1000000 maximum"
      )
    );

    const failure = await complete(await bedrock());

    expect(failure).toMatchObject({
      kind: "context_length_exceeded",
      code: "VALIDATION_FAILED",
      retryable: false,
      message: "This conversation is too long for the model. Start a new conversation."
    });
  });

  it("fails a refused answer without the model's explanation and keeps its usage", async () => {
    answerWith(() =>
      Response.json({
        ...message([], "refusal", { input_tokens: 30, output_tokens: 6 }),
        stop_details: { type: "refusal", category: "cyber", explanation: "SECRET-PROVIDER-WORDS" }
      })
    );

    const failure = await complete(await bedrock());

    expect(failure).toMatchObject({
      kind: "invalid_response",
      retryable: false,
      providerCode: "refusal",
      message: "Model provider returned no answer"
    });
    expect(failure.usage).toMatchObject({ inputTokens: 30, outputTokens: 6 });
    expect(readable(failure)).not.toContain("SECRET-PROVIDER-WORDS");
  });

  it("gives up a stream that sends nothing for ten minutes as a timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let cancelled = 0;
    answerWith(() =>
      bedrockEventStream(
        [bedrockChunk({ type: "message_start", message: { usage: { input_tokens: 8 } } })],
        {
          staysOpen: true,
          onCancel: () => {
            cancelled += 1;
          }
        }
      )
    );

    const pending = collect(
      (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
    expect(cancelled).toBe(0);
    await vi.advanceTimersByTimeAsync(1);

    const failure = await pending;
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: "TIMEOUT",
      message: "Model provider stream sent no data for 10 minutes"
    });
    // The request is ended, so the provider stops writing an answer nobody reads.
    expect(cancelled).toBe(1);
  });

  it("fails a stream that ends before the answer does as a timeout", async () => {
    const cut = bedrockChunk({ type: "content_block_delta", index: 0, delta: {} });
    for (const pieces of [
      [bedrockChunk({ type: "message_start", message: {} })],
      [cut.subarray(0, cut.byteLength - 3)]
    ]) {
      answerWith(() => bedrockEventStream(pieces));
      const failure = await collect(
        (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "TIMEOUT" });
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["a wrong message checksum", (frame: Uint8Array) => flipByte(frame, frame.byteLength - 2)],
    // The message's checksum is made to hold, so only the prelude's own check refuses this.
    ["a wrong prelude checksum", (frame: Uint8Array) => withMessageChecksum(flipByte(frame, 9))],
    // The prelude's own checksum holds, so only the bound on the length refuses these two.
    ["a length above the largest message", () => prelude(0x7fffffff, 0)],
    ["a length below its own headers", () => prelude(20, 64)]
  ])("refuses a stream message with %s and does not wait for the rest", async (_name, corrupt) => {
    answerWith(() => bedrockEventStream([corrupt(bedrockChunk({ type: "message_stop" }))]));

    const failure = await collect(
      (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
    ).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      kind: "invalid_response",
      retryable: false,
      message: "Model provider returned a malformed stream"
    });
  });

  it("refuses a wrong prelude checksum from the prelude alone, before the message has arrived", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let cancelled = 0;
    const frame = flipByte(bedrockChunk({ type: "message_stop" }), 9);
    // Twelve bytes and then silence: a decoder that trusted the lengths would wait for the rest.
    answerWith(() =>
      bedrockEventStream([frame.subarray(0, 12)], {
        staysOpen: true,
        onCancel: () => {
          cancelled += 1;
        }
      })
    );

    const pending = collect(
      (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toMatchObject({
      kind: "invalid_response",
      retryable: false,
      message: "Model provider returned a malformed stream"
    });
    expect(cancelled).toBe(1);
  });

  it("refuses a request above Bedrock's size before it is sent", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));
    const adapter = await bedrock();
    // Eight images below the limit of one image, together above the limit of a request.
    const image = {
      type: "image" as const,
      mimeType: "image/png" as const,
      data: new Uint8Array(3_000_000)
    };
    const request = {
      model: RECORDED_BEDROCK_PROFILE,
      messages: [user(Array.from({ length: 8 }, () => image))],
      tools: []
    };

    for (const failure of [
      await adapter.complete(request).catch((error: unknown) => error),
      await collect(adapter.stream(request)).catch((error: unknown) => error)
    ]) {
      expect(failure).toMatchObject({
        kind: "context_length_exceeded",
        retryable: false,
        message: "This conversation is too long for the model. Start a new conversation."
      });
    }
    expect(sent).toHaveLength(0);
  });
});

function toolStart(index: number, id: string, name: string): Uint8Array {
  return bedrockChunk({
    type: "content_block_start",
    index,
    content_block: { type: "tool_use", id, name, input: {} }
  });
}

function jsonDelta(index: number, partialJson: string): Uint8Array {
  return bedrockChunk({
    type: "content_block_delta",
    index,
    delta: { type: "input_json_delta", partial_json: partialJson }
  });
}

function flipByte(frame: Uint8Array, index: number): Uint8Array {
  const copy = Uint8Array.from(frame);
  copy[index] = (copy[index] ?? 0) ^ 0xff;
  return copy;
}

/** The frame with the checksum of the whole message written again over what it holds now. */
function withMessageChecksum(frame: Uint8Array): Uint8Array {
  const bytes = Buffer.from(frame);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, bytes.byteLength - 4)), bytes.byteLength - 4);
  return Uint8Array.from(bytes);
}

/** The first twelve bytes of a stream message: two lengths and their checksum. */
function prelude(totalLength: number, headersLength: number): Uint8Array {
  const bytes = Buffer.alloc(12);
  bytes.writeUInt32BE(totalLength, 0);
  bytes.writeUInt32BE(headersLength, 4);
  bytes.writeUInt32BE(crc32(bytes.subarray(0, 8)), 8);
  return Uint8Array.from(bytes);
}

function concatBytes(pieces: Uint8Array[]): Uint8Array {
  return Uint8Array.from(Buffer.concat(pieces));
}

function slices(bytes: Uint8Array, size: number): Uint8Array[] {
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    pieces.push(bytes.slice(offset, offset + size));
  }
  return pieces;
}

async function complete(adapter: ModelAdapter): Promise<ModelProviderError> {
  const failure = await adapter
    .complete({ model: RECORDED_BEDROCK_PROFILE, ...hello })
    .catch((error: unknown) => error);
  if (!(failure instanceof ModelProviderError)) throw new Error("Expected a provider error");
  return failure;
}

/** Everything a caller, a response or a serializer reads from an error. */
function readable(error: unknown): string {
  if (!(error instanceof Error)) throw new Error("Expected an error");
  return [
    error.message,
    JSON.stringify(error),
    JSON.stringify(error instanceof AppError ? error.details : undefined),
    String(error),
    error.stack ?? ""
  ].join("\n");
}

/**
 * Prompt caching through the Bedrock adapter: where a call of a conversation sets its cache
 * breakpoints, and what the usage says was read from and written to the cache.
 */

const BREAKPOINT = { type: "ephemeral" };
const tools: ModelTool[] = [
  { name: "get_weather", description: "Reads the weather of a city." },
  { name: "get_time", description: "Reads the time of a city." }
];

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

/** What an `aws-bedrock` entry may name: the EU, and a profile that attributes its calls. */

const OTHER_ACCOUNT_ID = "999999999999";

describe("Bedrock adapter: what a config may name", () => {
  it.each([
    ["a model id", "anthropic.claude-sonnet-5-5", "not attributed to this consumer"],
    ["a global profile", "global.anthropic.claude-sonnet-5-5", "not attributed to this consumer"],
    [
      "a profile in a US region",
      `arn:aws:bedrock:us-east-1:${ACCOUNT_ID}:application-inference-profile/abc123`,
      "calls go to eu-central-1 only"
    ],
    [
      "a profile of another AWS account",
      `arn:aws:bedrock:eu-central-1:${OTHER_ACCOUNT_ID}:application-inference-profile/recordedprofile`,
      "the profile belongs to another AWS account than the provider's 'accountId'"
    ],
    [
      "a profile with a path that leaves it",
      `arn:aws:bedrock:eu-central-1:${ACCOUNT_ID}:application-inference-profile/abc/../x`,
      "not attributed to this consumer"
    ]
  ])(
    "refuses %s as the entry's model, a binding's model and a call's model",
    async (_, model, reason) => {
      const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));
      const factory = await bedrockFactory();
      const expected = {
        code: "VALIDATION_FAILED",
        message: expect.stringContaining(reason)
      };

      // The entry's own model: creating the adapter stops startup.
      const entry = captured(() =>
        factory({ id: "bedrock", type: "aws-bedrock", region: "eu", model })
      );
      expect(entry).toMatchObject(expected);
      // The message names the reason and never the id: an ARN holds the account id.
      expect(entry instanceof Error ? entry.message : "").not.toMatch(/\d{12}/u);

      // A binding's model: startup asks the capabilities of every binding.
      const adapter = factory({
        id: "bedrock",
        type: "aws-bedrock",
        region: "eu",
        model: RECORDED_BEDROCK_PROFILE
      });
      expect(captured(() => adapter.capabilities(model))).toMatchObject(expected);

      // A call that names the model past both: nothing is sent.
      await expect(adapter.complete({ model, ...hello })).rejects.toMatchObject(expected);
      await expect(collect(adapter.stream({ model, ...hello }))).rejects.toMatchObject(expected);
      expect(sent).toHaveLength(0);
    }
  );

  it("refuses an entry outside the EU, and has no setting for another host", async () => {
    const factory = await bedrockFactory();
    expect(
      captured(() =>
        factory({
          id: "bedrock",
          type: "aws-bedrock",
          region: "global",
          model: RECORDED_BEDROCK_PROFILE
        })
      )
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "'infrastructure.models.bedrock.region' must be 'eu': the 'aws-bedrock' provider calls Bedrock in eu-central-1 and nowhere else"
    });

    for (const setting of ["baseUrl", "endpoint", "awsRegion"]) {
      await expect(
        bedrockFactory({ [setting]: "https://bedrock-runtime.us-east-1.amazonaws.com" })
      ).rejects.toMatchObject({
        message: expect.stringContaining(
          `'infrastructure.models.bedrock.${setting}' is not a setting of the 'aws-bedrock' provider`
        )
      });
    }
    // A model entry may leave its region unset; the factory then refuses it as not 'eu'.
    const unset = await bedrockFactory({ region: undefined });
    expect(
      captured(() =>
        unset({
          id: "bedrock",
          type: "aws-bedrock",
          region: undefined,
          model: RECORDED_BEDROCK_PROFILE
        })
      )
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("'infrastructure.models.bedrock.region' must be 'eu'")
    });
  });

  it("declares tool calls, images, documents, answer formats and thinking, and nothing it does not map", async () => {
    const adapter = await bedrock();
    expect(adapter.capabilities(RECORDED_BEDROCK_PROFILE)).toEqual({
      reasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      nativeTools: [],
      toolCalls: true,
      serverCompaction: false,
      // Carries the thinking of a run's tool-use turns to the run's next request.
      continuation: true,
      fastTier: false,
      imageInput: true,
      documentInput: true,
      structuredOutput: true,
      streaming: true,
      priceRequired: true
    });
  });

  it("offers the chat picker all five efforts, unless the binding lists fewer", async () => {
    const { reasoningEfforts } = (await bedrock()).capabilities(RECORDED_BEDROCK_PROFILE);

    expect(reasoningEffortChoiceForBinding({}, reasoningEfforts, undefined)).toEqual({
      defaultEffort: "medium",
      selectable: ["low", "medium", "high", "xhigh", "max"]
    });
    // A model that refuses `xhigh` and `max`, such as Claude Sonnet 4.6, is restricted by its binding.
    expect(
      reasoningEffortChoiceForBinding(
        { userSelectableReasoningEfforts: ["low", "medium", "high"] },
        reasoningEfforts,
        undefined
      ).selectable
    ).toEqual(["low", "medium", "high"]);
  });

  it("needs the account id of the instance, and takes nothing but twelve digits", async () => {
    await expect(bedrockFactory({ accountId: undefined })).rejects.toMatchObject({
      message: expect.stringContaining("'infrastructure.models.bedrock.accountId'")
    });
    for (const accountId of ["12345678901", "1234567890123", "account-one", 123456789012]) {
      await expect(bedrockFactory({ accountId })).rejects.toMatchObject({
        message: expect.stringContaining("'infrastructure.models.bedrock.accountId'")
      });
    }
    // The same profile is taken by the entry of its account and refused by another's.
    const factory = await bedrockFactory({ accountId: OTHER_ACCOUNT_ID });
    expect(
      captured(() =>
        factory({
          id: "bedrock",
          type: "aws-bedrock",
          region: "eu",
          model: RECORDED_BEDROCK_PROFILE
        })
      )
    ).toMatchObject({ message: expect.stringContaining("another AWS account") });
  });
});

/**
 * The Bedrock adapter behind the gateway: how often a failed call is sent, and what a log line
 * and a refusal name the model by. Every case counts the requests that left.
 */

const HOUR_MS = 60 * 60 * 1000;

const streamStart = bedrockChunk({
  type: "message_start",
  message: { usage: { input_tokens: 8 } }
});
const streamedError = (type: string, text = "SECRET-PROVIDER-WORDS"): Uint8Array =>
  bedrockChunk({ type: "error", error: { type, message: text } });

/** The failure of a streamed call, after as much time as any retry could wait. */
async function failureOfStream(pieces: Uint8Array[]): Promise<{ sent: number; failure: unknown }> {
  vi.useFakeTimers();
  const sent = answerWith(() => bedrockEventStream(pieces));
  const { gateway, call } = await bedrockGateway();
  const failed = drain(gateway.stream(call)).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  return { sent: sent.length, failure: await failed };
}

describe("Bedrock adapter behind the gateway: what is sent again", () => {
  it.each([
    ["an overloaded model", streamedError("overloaded_error")],
    [
      "a model that failed while it streamed",
      bedrockStreamException("modelStreamErrorException", "x")
    ],
    ["an unavailable service", bedrockStreamException("serviceUnavailableException", "x")]
  ])("sends a stream that reports %s three times and then fails", async (_name, piece) => {
    const { sent, failure } = await failureOfStream([streamStart, piece]);

    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({ retryable: true });
    expect(sent).toBe(3);
  });

  it.each([
    ["a throttled stream", "throttlingException"],
    // A model that is still loading is ready a moment later: sent again like a throttled call.
    ["a stream whose model is not ready", "modelNotReadyException"]
  ])("sends %s again within a minute and then tells the user", async (_name, type) => {
    const { sent, failure } = await failureOfStream([
      streamStart,
      bedrockStreamException(type, "x")
    ]);

    expect(failure).toMatchObject({
      code: "RATE_LIMITED",
      message: "The model is receiving too many requests. Try again in a minute."
    });
    expect(sent).toBeGreaterThan(1);
  });

  it.each([
    ["a key that is not taken", streamedError("authentication_error"), "invalid_request", 401],
    ["denied access", bedrockStreamException("accessDeniedException", "x"), "invalid_request", 403],
    [
      "a quota that is used up",
      bedrockStreamException("serviceQuotaExceededException", "x"),
      "invalid_request",
      400
    ],
    [
      "an error type of a later release",
      streamedError("error_of_a_later_release"),
      "server_error",
      undefined
    ],
    [
      "an exception of a later release",
      bedrockStreamException("exceptionOfALaterRelease", "x"),
      "server_error",
      undefined
    ]
  ])("sends a stream that reports %s once", async (_name, piece, kind, status) => {
    const { sent, failure } = await failureOfStream([streamStart, piece]);

    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({ kind, status, retryable: false });
    expect(sent).toBe(1);
  });

  it.each([
    ["the model's error", streamedError("invalid_request_error", "prompt is too long: 9 > 8")],
    [
      "Bedrock's exception",
      bedrockStreamException("validationException", "Input is too long for requested model.")
    ],
    ["a request that is too large", streamedError("request_too_large")]
  ])(
    "tells the user that the conversation is too long when a stream reports it by %s",
    async (_name, piece) => {
      const { sent, failure } = await failureOfStream([streamStart, piece]);

      expect(failure).toMatchObject({
        kind: "context_length_exceeded",
        retryable: false,
        message: "This conversation is too long for the model. Start a new conversation."
      });
      expect(sent).toBe(1);
    }
  );

  it("sends a call whose stream stays silent once: the idle limit bounds the whole call", async () => {
    vi.useFakeTimers();
    // Nothing arrives at all, not even the start of the answer.
    const sent = answerWith(() => bedrockEventStream([], { staysOpen: true }));
    const { gateway, call } = await bedrockGateway();
    const started = Date.now();
    let failedAfterMs: number | undefined;
    const failed = drain(gateway.stream(call)).catch((error: unknown) => {
      failedAfterMs = Date.now() - started;
      return error;
    });

    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(await failed).toMatchObject({
      code: "TIMEOUT",
      retryable: false,
      message: "Model provider stream sent no data for 10 minutes"
    });
    expect(failedAfterMs).toBe(10 * 60 * 1000);
    expect(sent).toHaveLength(1);
  });

  it("sends a throttled request again and answers with the attempt that succeeds", async () => {
    vi.useFakeTimers();
    const sent = answerWith(() =>
      sent.length < 2
        ? bedrockRefusal(429, "ThrottlingException", "Too many requests.")
        : Response.json(message([{ type: "text", text: "Hello." }]))
    );
    const { gateway, call } = await bedrockGateway();

    const answered = gateway.complete(call);
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect((await answered).text).toBe("Hello.");
    expect(sent).toHaveLength(2);
  });

  it.each([401, 403])("sends a request refused with status %i once", async (status) => {
    vi.useFakeTimers();
    const sent = answerWith(() => bedrockRefusal(status, "AccessDeniedException", "Refused."));
    const { gateway, call } = await bedrockGateway();

    const failed = gateway.complete(call).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(await failed).toMatchObject({ kind: "invalid_request", status, retryable: false });
    expect(sent).toHaveLength(1);
  });
});

describe("Bedrock adapter behind the gateway: redirects", () => {
  it.each(["complete", "stream"] as const)(
    "does not follow a redirect of a %s request, and does not send it again",
    async (mode) => {
      vi.useFakeTimers();
      const requested: string[] = [];
      // Answers as `fetch` does: it follows a redirect unless the request forbids it.
      vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
        requested.push(String(input));
        const redirect = new Response(null, {
          status: 307,
          headers: { location: "https://bedrock-runtime.us-east-1.amazonaws.com/elsewhere" }
        });
        if (init?.redirect === "manual") return redirect;
        if (init?.redirect === "error") throw new TypeError("fetch failed");
        requested.push("https://bedrock-runtime.us-east-1.amazonaws.com/elsewhere");
        return Response.json(message([{ type: "text", text: "From elsewhere." }]));
      });
      const { gateway, call } = await bedrockGateway();

      const failed = (
        mode === "complete" ? gateway.complete(call) : drain(gateway.stream(call))
      ).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(HOUR_MS);

      expect(await failed).toMatchObject({
        kind: "invalid_request",
        status: 307,
        retryable: false
      });
      expect(requested).toHaveLength(1);
      expect(requested[0]).toMatch(/^https:\/\/bedrock-runtime\.eu-central-1\.amazonaws\.com\//u);
    }
  );
});

describe("Bedrock adapter behind the gateway: what names the model", () => {
  it("names the binding, never the profile, in a refusal and in the log line of an error", async () => {
    answerWith(() => bedrockRefusal(403, "AccessDeniedException", "Denied."));
    const { gateway, call, warnings } = await bedrockGateway();

    const refused = await gateway
      .complete({ ...call, fastTier: true })
      .catch((error: unknown) => error);
    await gateway.complete(call).catch(() => undefined);

    expect(refused).toMatchObject({
      message: "Model binding 'claude' of provider 'bedrock' does not support: fast tier"
    });
    expect(warnings).toEqual([
      expect.objectContaining({ type: "model_provider.error", bindingId: "claude", status: 403 })
    ]);
    expect(JSON.stringify(warnings)).not.toMatch(/arn:aws/u);
    expect(JSON.stringify(warnings)).not.toContain(BEDROCK_TEST_ACCOUNT_ID);
  });
});

describe("Bedrock adapter behind the gateway: usage that cannot be recorded", () => {
  it("names the binding, never the profile, in the log line of a failed call that could not be settled", async () => {
    answerWith(() => bedrockRefusal(403, "AccessDeniedException", "Denied."));
    const { gateway, call, errors, governance } = await bedrockGateway();
    governance.failSettlement = new Error("The usage store is down");

    const failure = await gateway.complete(call).catch((error: unknown) => error);

    // The caller reads why the call failed, not why its usage was not recorded.
    expect(failure).toMatchObject({ kind: "invalid_request", status: 403 });
    expect(governance.settled).toBe(1);
    expect(errors).toEqual([
      expect.objectContaining({
        type: "model_usage.record_failed",
        providerId: "bedrock",
        bindingId: "claude"
      })
    ]);
    expect(errors[0]).not.toHaveProperty("model");
    expect(JSON.stringify(errors)).not.toMatch(/arn:aws/u);
    expect(JSON.stringify(errors)).not.toContain(BEDROCK_TEST_ACCOUNT_ID);
  });
});

async function drain(stream: AsyncIterable<ModelCallStreamEvent>): Promise<void> {
  for await (const _event of stream) void _event;
}

/** What the Bedrock adapter sends: the host, the key, and a request in the Messages format. */

const HOST = "https://bedrock-runtime.eu-central-1.amazonaws.com";

describe("Bedrock adapter: what it sends", () => {
  it("calls the Frankfurt runtime with the profile ARN, the key as a bearer token and no cache for a call of no conversation", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));
    const adapter = await bedrock();

    await adapter.complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        { role: "system", content: "Answer briefly." },
        user("Say hello."),
        { role: "assistant", content: "  " },
        user("Again.")
      ],
      tools: [weatherTool]
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe(
      `${HOST}/model/${encodeURIComponent(RECORDED_BEDROCK_PROFILE)}/invoke`
    );
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer test-bedrock-key");
    expect(sent[0]?.body).toEqual({
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 16_000,
      system: [{ type: "text", text: "Answer briefly." }],
      // An assistant turn of white space alone is no turn, so the two user turns are one.
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Say hello." },
            { type: "text", text: "Again." }
          ]
        }
      ],
      tools: [
        {
          name: "get_weather",
          description: "Reads the weather of a city.",
          input_schema: { type: "object", properties: { city: { type: "string" } } }
        }
      ]
    });
    // A call without a cache key starts no prompt a later call repeats: nothing asks for a cache.
    expect(JSON.stringify(sent[0]?.body)).not.toMatch(/cache_control|cachePoint/u);
  });

  it("sends tool names through the name table and reads them back", async () => {
    const tools: ModelTool[] = [
      { name: "data.query", description: "Runs a query." },
      { name: "data_query", description: "Runs another query." }
    ];
    let wireName = "";
    const sent = answerWith((request) => {
      wireName = String(records(request.body, "tools")[0]?.name);
      return Response.json(
        message([{ type: "tool_use", id: "toolu_1", name: wireName, input: { sql: "select 1" } }])
      );
    });
    const adapter = await bedrock();

    const completion = await adapter.complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user("Query."),
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "call:1/a", toolName: "data.query", input: "not an object" }]
        },
        { role: "tool", toolCallId: "call:1/a", content: "" }
      ],
      tools
    });

    const offered = records(sent[0]?.body, "tools").map((tool) => String(tool.name));
    for (const name of offered) expect(name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(new Set(offered).size).toBe(2);
    expect(completion.toolCalls).toEqual([
      { toolCallId: "toolu_1", toolName: "data.query", input: { sql: "select 1" } }
    ]);
    const [, assistant, result] = records(sent[0]?.body, "messages");
    const call = records(assistant, "content")[0];
    // An id another provider gave is sent in the format's characters, the same in both places.
    expect(call).toMatchObject({ type: "tool_use", name: wireName, input: {} });
    expect(call?.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);
    expect(records(result, "content")[0]).toEqual({ type: "tool_result", tool_use_id: call?.id });
  });

  it("leaves out an image above Bedrock's limit and says so in its place", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Seen." }])));
    const adapter = await bedrock();

    await adapter.complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user([
          { type: "text", text: "Look." },
          { type: "image", mimeType: "image/png" as const, data: new Uint8Array(3_750_001) }
        ])
      ],
      tools: []
    });

    expect(records(sent[0]?.body, "messages")).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Look." },
          {
            type: "text",
            text: "[1 image could not be included in the model input and was left out.]"
          }
        ]
      }
    ]);
  });

  it("keeps the newest twenty images and says that the older ones were left out", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Seen." }])));
    const image = (index: number) => ({
      type: "image" as const,
      mimeType: "image/png" as const,
      data: Uint8Array.from([index])
    });

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user([image(0), image(1), { type: "text", text: "First." }]),
        { role: "assistant", content: "Seen." },
        user(Array.from({ length: 20 }, (_unused, index) => image(index + 2)))
      ],
      tools: []
    });

    const [first, , last] = records(sent[0]?.body, "messages");
    expect(records(first, "content")).toEqual([
      { type: "text", text: "First." },
      {
        type: "text",
        text: "[2 images could not be included in the model input and were left out.]"
      }
    ]);
    const kept = records(last, "content");
    expect(kept).toHaveLength(20);
    expect(kept[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/png", data: Buffer.from([2]).toString("base64") }
    });
  });

  // FU-2: a message steered into a running turn follows every tool result of the step it came in
  // on (events-workflows-and-guardrails check 85).
  it("sends a steered message after both results of a step, in the same user turn", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Done." }])));
    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user("Weather in Berlin and Hamburg?"),
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { toolCallId: "toolu_1", toolName: "get_weather", input: { city: "Berlin" } },
            { toolCallId: "toolu_2", toolName: "get_weather", input: { city: "Hamburg" } }
          ]
        },
        { role: "tool", toolCallId: "toolu_1", content: "Sunny" },
        { role: "tool", toolCallId: "toolu_2", content: "Rain" },
        user("Also Munich, please.")
      ],
      tools: [weatherTool]
    });

    const turns = records(sent[0]?.body, "messages");
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    const last = records(turns.at(-1), "content");
    expect(last.map((block) => block.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(last.at(-1)).toMatchObject({ text: "Also Munich, please." });
  });
});

describe("Bedrock adapter: documents", () => {
  const pdf = (data: Uint8Array) => ({
    type: "document" as const,
    mimeType: "application/pdf" as const,
    data
  });
  const ask = (documents: Uint8Array[]) => ({
    model: RECORDED_BEDROCK_PROFILE,
    messages: [user([...documents.map(pdf), { type: "text" as const, text: "Summarize." }])],
    tools: []
  });

  it("sends a PDF as a document block where it stands, also in the result of a tool", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Read." }])));
    const data = syntheticPdf(100);
    const block = {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from(data).toString("base64")
      }
    };

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        user("Load the report."),
        {
          role: "assistant",
          content: "",
          toolCalls: [{ toolCallId: "toolu_1", toolName: "get_weather", input: {} }]
        },
        { role: "tool", toolCallId: "toolu_1", content: [pdf(data)] }
      ],
      tools: [weatherTool]
    });

    const [, , result] = records(sent[0]?.body, "messages");
    expect(records(result, "content")).toEqual([
      { type: "tool_result", tool_use_id: "toolu_1", content: [block] }
    ]);
  });

  it.each([
    [
      "a document above 4.5 MB",
      [new Uint8Array(4_500_001)],
      "document_too_large",
      "BEDROCK_DOCUMENT_MAX_BYTES",
      "A document is too large for the model. Split it and send the parts."
    ],
    [
      "documents of more than 100 pages together",
      [syntheticPdf(60), syntheticPdf(41)],
      "document_too_many_pages",
      "BEDROCK_DOCUMENT_MAX_PAGES",
      "The documents have too many pages for the model. Split them and send the parts."
    ]
  ])("refuses %s by name and sends nothing", async (_name, documents, reason, limit, sentence) => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Read." }])));
    const adapter = await bedrock();
    const request = ask(documents);

    for (const failure of [
      await adapter.complete(request).catch((error: unknown) => error),
      await collect(adapter.stream(request)).catch((error: unknown) => error)
    ]) {
      expect(failure).toBeInstanceOf(ModelProviderError);
      expect(failure).toMatchObject({
        kind: "invalid_request",
        retryable: false,
        message: sentence,
        details: { providerId: "bedrock", reason, limit }
      });
    }
    // Refused whole: the document is not left out of a request that is sent without it.
    expect(sent).toHaveLength(0);
  });

  it("sends documents at the limits", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Read." }])));

    await (await bedrock()).complete(ask([syntheticPdf(100), new Uint8Array(4_500_000)]));

    expect(sent).toHaveLength(1);
    expect(records(records(sent[0]?.body, "messages")[0], "content")).toHaveLength(3);
  });
});

describe("Bedrock adapter: answer formats", () => {
  it("sends the format as the Messages format's own structured output, beside the effort", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "{}" }])));

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [user("Extract.")],
      tools: [weatherTool],
      reasoningEffort: "low",
      output: {
        jsonSchema: {
          type: "object",
          required: ["findings"],
          additionalProperties: true,
          properties: {
            // A property may carry the name of a keyword. It is a name here and stays.
            maximum: { type: "integer", minimum: 0, maximum: 9, multipleOf: 3 },
            label: { type: "string", minLength: 1, maxLength: 80, enum: ["a", "b"] },
            findings: {
              type: "array",
              minItems: 1,
              maxItems: 20,
              uniqueItems: true,
              items: {
                type: ["object", "null"],
                properties: {
                  pages: { type: "array", minItems: 2, items: { $ref: "#/$defs/page" } }
                }
              }
            },
            either: { anyOf: [{ type: "object", properties: {} }, { type: "null" }] }
          },
          $defs: { page: { type: "integer", exclusiveMinimum: 0 } }
        }
      }
    });

    const body = sent[0]?.body;
    expect(body).toMatchObject({
      thinking: { type: "adaptive" },
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            required: ["findings"],
            // The one value Bedrock takes, on every object of the schema.
            additionalProperties: false,
            properties: {
              maximum: { type: "integer" },
              label: { type: "string", enum: ["a", "b"] },
              findings: {
                type: "array",
                minItems: 1,
                items: {
                  type: ["object", "null"],
                  additionalProperties: false,
                  properties: { pages: { type: "array", items: { $ref: "#/$defs/page" } } }
                }
              },
              either: {
                anyOf: [
                  { type: "object", properties: {}, additionalProperties: false },
                  { type: "null" }
                ]
              }
            },
            $defs: { page: { type: "integer" } }
          }
        }
      }
    });
    // Nothing Bedrock refuses to compile is left, and no tool is forced for the format.
    expect(JSON.stringify(body)).not.toMatch(
      /"(minimum|multipleOf|minLength|maxLength|maxItems|uniqueItems|exclusiveMinimum)":/u
    );
    expect(body).not.toHaveProperty("tool_choice");
    expect(records(body, "tools")).toHaveLength(1);
  });

  it("sends no output setting for a call without a format and without an effort", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));

    await (
      await bedrock()
    ).complete({ model: RECORDED_BEDROCK_PROFILE, messages: [user("Say hello.")], tools: [] });

    expect(sent[0]?.body).not.toHaveProperty("output_config");
  });
});

/** A PDF in outline only: a page tree and that many page objects. No reader opens it. */
function syntheticPdf(pages: number): Uint8Array {
  const kids = Array.from({ length: pages }, (_unused, index) => `${index + 3} 0 R`).join(" ");
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      `2 0 obj << /Type /Pages /Count ${pages} /Kids [${kids}] >> endobj`,
      ...Array.from(
        { length: pages },
        (_unused, index) => `${index + 3} 0 obj << /Type/Page /Parent 2 0 R >> endobj`
      ),
      "%%EOF"
    ].join("\n")
  );
}

/** The objects in the list `key` of a request body or of one of its parts. */
function records(value: unknown, key: string): Record<string, unknown>[] {
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const items: unknown = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(items)) throw new Error(`Expected a list '${key}'`);
  return items.filter(isRecord);
}

/**
 * Thinking through the Bedrock adapter: what a reasoning effort sends, what the model's thinking
 * becomes, and how the thinking of a turn that called a tool goes back with the tool's result.
 * The recording is built by hand from the Messages format; its signature and its redacted block
 * are made up and open nothing.
 */

const question: ModelMessage = { role: "user", content: "What is the weather in Berlin?" };
const SIGNATURE = "cmVjb3JkZWQtc2lnbmF0dXJl";
const REDACTED = "cmVjb3JkZWQtcmVkYWN0ZWQtdGhpbmtpbmc=";

describe("Bedrock adapter: thinking", () => {
  it.each([
    ["high", 16_000],
    // Below 64,000 a long thought at these efforts fills the limit before the answer starts.
    ["xhigh", 64_000]
  ] as const)(
    "asks for adaptive thinking with the effort '%s' and sends no thinking budget",
    async (effort, maxTokens) => {
      const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));

      await (
        await bedrock()
      ).complete({ model: RECORDED_BEDROCK_PROFILE, ...hello, reasoningEffort: effort });

      expect(sent[0]?.body).toMatchObject({
        // The one hard limit on thinking and answer together.
        max_tokens: maxTokens,
        thinking: { type: "adaptive" },
        output_config: { effort }
      });
      expect(JSON.stringify(sent[0]?.body)).not.toContain("budget_tokens");
    }
  );

  it("streams a call at 'max' with the larger output limit", async () => {
    const sent = answerWith(() =>
      bedrockEventStream([
        bedrockChunk({ type: "message_start", message: { usage: { input_tokens: 8 } } }),
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
          usage: { output_tokens: 5 }
        }),
        bedrockChunk({ type: "message_stop" })
      ])
    );

    const events = await collect(
      (await bedrock()).stream({
        model: RECORDED_BEDROCK_PROFILE,
        ...hello,
        reasoningEffort: "max"
      })
    );

    expect(events.at(-1)).toMatchObject({ type: "completed", completion: { text: "Hello." } });
    expect(sent[0]?.url).toMatch(/\/invoke-with-response-stream$/u);
    expect(sent[0]?.body).toMatchObject({
      max_tokens: 64_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" }
    });
  });

  it("keeps the output limit a call states at 'xhigh'", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));

    await (
      await bedrock()
    ).complete({
      model: RECORDED_BEDROCK_PROFILE,
      ...hello,
      reasoningEffort: "xhigh",
      maxOutputTokens: 2_000
    });

    expect(sent[0]?.body).toMatchObject({ max_tokens: 2_000, output_config: { effort: "xhigh" } });
  });

  it("sends no thinking setting for the effort 'none'", async () => {
    const sent = answerWith(() => Response.json(message([{ type: "text", text: "Hello." }])));

    await (
      await bedrock()
    ).complete({ model: RECORDED_BEDROCK_PROFILE, ...hello, reasoningEffort: "none" });

    expect(sent[0]?.body).not.toHaveProperty("thinking");
    expect(sent[0]?.body).not.toHaveProperty("output_config");
  });

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

  // A run that paused on a call for its person's decision goes on in another worker, later:
  // the turn comes from the stored messages and the continuation from the run's resume state.
  it("sends the turn of a resumed run back unchanged from what the run stored when it paused", async () => {
    const replayed = replayModelAdapterRecording(
      loadModelAdapterRecording("aws-bedrock", "thinking-tool-loop")
    );
    const streamed = (
      await collect(
        (await bedrock()).stream({
          model: RECORDED_BEDROCK_PROFILE,
          messages: [question],
          tools: [weatherTool],
          reasoningEffort: "medium"
        })
      )
    ).at(-1);
    if (streamed?.type !== "completed") throw new Error("The stream did not complete");
    const first = streamed.completion;
    // What the run kept is JSON in the database; nothing of the first adapter is left.
    const stored: { continuation: ModelProviderContinuation } = JSON.parse(
      JSON.stringify({ continuation: first.continuation })
    );
    const resumed = await bedrock();

    const answer = await resumed.complete({
      model: RECORDED_BEDROCK_PROFILE,
      messages: [
        question,
        { role: "assistant", content: first.text, toolCalls: first.toolCalls },
        { role: "tool", toolCallId: "toolu_bdrk_recorded_1", content: '{"temperatureC":18}' }
      ],
      tools: [weatherTool],
      reasoningEffort: "medium",
      continuation: stored.continuation
    });

    // The replay refuses the second exchange when one block of the turn differs.
    expect(replayed.count()).toBe(2);
    expect(answer.text).toBe("It is 18 degrees in Berlin.");
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
    ]
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
