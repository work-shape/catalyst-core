import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@vivd-catalyst/core";
import {
  ModelProviderError,
  type ModelAdapter,
  type ModelMessage,
  type ModelTool
} from "@vivd-catalyst/model-provider";
import {
  BEDROCK_TEST_ACCOUNT_ID,
  answerWith,
  bedrock,
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
const HOST = "https://bedrock-runtime.eu-central-1.amazonaws.com";
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

describe("Bedrock adapter: what it sends", () => {
  it("calls the Frankfurt runtime with the profile ARN, the key as a bearer token and no cache", async () => {
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
      max_tokens: 64_000,
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
    // The route forbids explicit caches: nothing in a request asks for one.
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
          { type: "image", mimeType: "image/png", data: new Uint8Array(3_750_001) }
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
            text: "[1 image was too large to include in the model input and was left out.]"
          }
        ]
      }
    ]);
  });
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
    answerWith(() => eventStream(slices(stream, 7)));

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
      eventStream([
        toolStart(0, "toolu_a", "get_weather"),
        jsonDelta(0, '{"city": "Ber'),
        bedrockChunk({
          type: "message_delta",
          delta: { stop_reason: "max_tokens" },
          usage: { input_tokens: 40, output_tokens: 64_000 }
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

  it("ignores events, deltas, blocks and stream messages of types it does not know", async () => {
    answerWith(() =>
      eventStream([
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
      refusal(429, "ThrottlingException", "Too many requests, please wait before trying again.", {
        "retry-after": "7"
      })
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
    ["serviceUnavailableException", "server_error", 503, true],
    ["modelTimeoutException", "timeout", 408, true],
    ["validationException", "invalid_request", 400, false],
    ["exceptionOfALaterRelease", "server_error", undefined, true]
  ] as const)(
    "reports %s inside a stream that had begun as %s",
    async (type, kind, status, retryable) => {
      answerWith(() =>
        eventStream([
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

  it("reports an overloaded model inside a stream as a server error that is sent again", async () => {
    answerWith(() =>
      eventStream([
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
    answerWith(() => refusal(status, "ModelErrorException", "The model failed."));

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
      answerWith(() => refusal(403, "AccessDeniedException", body));
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
      refusal(400, "ValidationException", "prompt is too long: 1200000 tokens > 1000000 maximum")
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
      eventStream(
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

  it("fails a stream that ends before the answer does, so the call is sent again", async () => {
    const cut = bedrockChunk({ type: "content_block_delta", index: 0, delta: {} });
    for (const pieces of [
      [bedrockChunk({ type: "message_start", message: {} })],
      [cut.subarray(0, cut.byteLength - 3)]
    ]) {
      answerWith(() => eventStream(pieces));
      const failure = await collect(
        (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "TIMEOUT" });
      vi.unstubAllGlobals();
    }
  });

  it("refuses a stream message whose checksum or length is wrong", async () => {
    const flipped = Uint8Array.from(bedrockChunk({ type: "message_stop" }));
    flipped[flipped.byteLength - 6] = (flipped[flipped.byteLength - 6] ?? 0) ^ 0xff;
    const oversized = Uint8Array.from(bedrockChunk({ type: "message_stop" }));
    oversized[0] = 0xff;
    for (const piece of [flipped, oversized]) {
      answerWith(() => eventStream([piece]));
      const failure = await collect(
        (await bedrock()).stream({ model: RECORDED_BEDROCK_PROFILE, ...hello })
      ).catch((error: unknown) => error);
      expect(failure).toMatchObject({ kind: "invalid_response", retryable: false });
      vi.unstubAllGlobals();
    }
  });
});

function refusal(
  status: number,
  type: string,
  body: string | Record<string, string>,
  headers: Record<string, string> = {}
): Response {
  return Response.json(typeof body === "string" ? { message: body } : body, {
    status,
    headers: {
      "x-amzn-errortype": `${type}:http://internal.amazon.com/coral/com.amazon.bedrock/`,
      "x-amzn-requestid": "0f8fad5b-d9cb-469f-a165-70867728950e",
      ...headers
    }
  });
}

function eventStream(
  pieces: Uint8Array[],
  options: { staysOpen?: boolean; onCancel?: () => void } = {}
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(piece);
        if (!options.staysOpen) controller.close();
      },
      cancel() {
        options.onCancel?.();
      }
    }),
    { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } }
  );
}

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

/** The objects in the list `key` of a request body or of one of its parts. */
function records(value: unknown, key: string): Record<string, unknown>[] {
  const isRecord = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === "object" && !Array.isArray(item);
  const items: unknown = isRecord(value) ? value[key] : undefined;
  if (!Array.isArray(items)) throw new Error(`Expected a list '${key}'`);
  return items.filter(isRecord);
}
