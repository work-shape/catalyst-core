import { crc32 } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@work-shape/catalyst-core";
import {
  ModelProviderError,
  type ModelAdapter,
  type ModelMessage,
  type ModelTool
} from "@work-shape/catalyst-model-provider";
import {
  BEDROCK_TEST_ACCOUNT_ID,
  answerWith,
  bedrock,
  bedrockEventStream,
  bedrockRefusal,
  collect,
  hello,
  message
} from "./support/bedrock-adapter";
import {
  bedrockChunk,
  bedrockEventStreamMessage,
  bedrockStreamException
} from "./support/bedrock-event-stream";
import { RECORDED_BEDROCK_PROFILE } from "./support/model-adapter-recordings";

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
  vi.unstubAllGlobals();
});

describe("Bedrock adapter: what it reads", () => {
  it("counts cache reads and writes into the input and reports the read share as cached", async () => {
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
    ["a text", '"Berlin"'],
    ["a number", "7"],
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
    ["modelNotReadyException", "rate_limit", 429, true],
    ["modelStreamErrorException", "server_error", 424, true],
    ["modelErrorException", "server_error", 424, true],
    ["serviceUnavailableException", "server_error", 503, true],
    ["modelTimeoutException", "timeout", 408, true],
    ["validationException", "invalid_request", 400, false],
    ["accessDeniedException", "invalid_request", 403, false],
    ["serviceQuotaExceededException", "invalid_request", 400, false],
    ["resourceNotFoundException", "invalid_request", 404, false],
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

  it.each([424, 500, 503, 529])("reports status %i as a server error", async (status) => {
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
