import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError, asClientInstanceId, asConversationId } from "@vivd-catalyst/core";
import {
  ModelProviderError,
  createModelGateway,
  type ModelCall,
  type ModelCallStreamEvent,
  type ModelGateway,
  type ModelMessage,
  type ModelTool
} from "@vivd-catalyst/model-provider";
import { advanceFakeClockUntilSettled } from "./support/fake-clock";
import {
  conformanceAdapters,
  loadModelAdapterRecording,
  replayModelAdapterRecording,
  type ConformanceAdapter,
  type ReplayedRequests
} from "./support/model-adapter-recordings";
import {
  createRecordingGovernance,
  silentTestLogger,
  type RecordingGovernance
} from "./support/model-gateway";

/**
 * The contract every model adapter keeps, run for each of them against recorded exchanges and
 * through the gateway, without a database or a network.
 *
 * The recordings under `tests/fixtures/model-adapter-recordings` are written from the wire
 * formats the providers publish. None was captured from a live call. A case states what the
 * product sends and what it gets; the recording states what that is on the wire of one provider.
 */

const clientInstanceId = asClientInstanceId("client-adapter-conformance");
// What the provider wrote into a recorded refusal. No error, message or serialized form may hold it.
const PLANTED_PROVIDER_TEXT = "PLANTED-PROVIDER-TEXT";
// Shorter than the first wait before a retry, so each wait of a retried call passes once.
const RETRY_CLOCK_STEP_MS = 500;
// What a token endpoint answers a key it does not take.
const REFUSED_CREDENTIAL_STATUS = 401;

const SYNTHETIC_PDF = new TextEncoder().encode("%PDF-1.4\n% synthetic conformance document\n");
// A one-pixel PNG.
const SYNTHETIC_PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64"
  )
);

const weatherTools: ModelTool[] = [
  {
    name: "get_weather",
    description: "Reads the weather of a city.",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["city"],
      properties: { city: { type: "string", description: "The name of the city." } }
    }
  },
  {
    name: "get_time",
    description: "Reads the time of a zone.",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["zone"],
      properties: { zone: { type: "string" } }
    }
  }
];

const summarySchema = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "pages"],
  properties: {
    summary: { type: "string" },
    note: { type: ["string", "null"] },
    pages: { type: "array", items: { type: "integer" } }
  }
};

const user = (content: ModelMessage["content"]): ModelMessage => ({ role: "user", content });

// Every gateway a case built. Whatever became of a call, it was settled once and only once.
const governed: RecordingGovernance[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const governance of governed.splice(0)) {
    expect(governance.settled, "one settlement for each admitted call").toBe(governance.admitted);
  }
});

describe.each(conformanceAdapters)("model adapter conformance: $type", (adapter) => {
  it("answers with text and reports the provider's usage", async () => {
    const f = await fixture(adapter, "text");

    const completion = await f.gateway.complete(
      f.call({ messages: [{ role: "system", content: "Answer briefly." }, user("Say hello.")] })
    );

    expect(completion.text).toBe("Hello from the recording.");
    expect(completion.toolCalls).toEqual([]);
    expect(f.replayed.credentials).toEqual([adapter.credential]);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({
        providerId: adapter.provider.id,
        model: adapter.provider.model,
        region: "eu",
        attribution: expect.objectContaining({ kind: "system", purpose: "document_extraction" }),
        inputTokens: 12,
        cachedInputTokens: 4,
        outputTokens: 5,
        totalTokens: 17,
        source: "provider_reported"
      })
    ]);
  });

  it("streams text as it arrives and completes with the same usage", async () => {
    const f = await fixture(adapter, "text-stream");

    const events = await collect(f.gateway.stream(f.call({ messages: [user("Say hello.")] })));

    expect(
      events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : [])).join("")
    ).toBe("Hello from the recording.");
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      type: "completed",
      completion: { text: "Hello from the recording.", toolCalls: [] }
    });
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({
        inputTokens: 12,
        cachedInputTokens: 4,
        outputTokens: 5,
        totalTokens: 17,
        source: "provider_reported"
      })
    ]);
  });

  it("returns several tool calls with their inputs", async () => {
    const f = await fixture(adapter, "tools", true);

    const completion = await f.gateway.complete(
      f.call({ messages: [user("Weather and time in Berlin?")], tools: weatherTools })
    );

    expect(completion.toolCalls).toEqual([
      { toolCallId: expect.any(String), toolName: "get_weather", input: { city: "Berlin" } },
      { toolCallId: expect.any(String), toolName: "get_time", input: { zone: "Europe/Berlin" } }
    ]);
    expect(new Set(completion.toolCalls.map((toolCall) => toolCall.toolCallId)).size).toBe(2);
    expect(f.governance.recorded[0]).toMatchObject({ inputTokens: 40, outputTokens: 18 });
  });

  it("announces streamed tool calls before it completes with them", async () => {
    const f = await fixture(adapter, "tools-stream", true);

    const events = await collect(
      f.gateway.stream(
        f.call({ messages: [user("Weather and time in Berlin?")], tools: weatherTools })
      )
    );

    const completed = events.at(-1);
    if (completed?.type !== "completed") throw new Error("The stream did not complete");
    expect(completed.completion.toolCalls).toEqual([
      { toolCallId: expect.any(String), toolName: "get_weather", input: { city: "Berlin" } },
      { toolCallId: expect.any(String), toolName: "get_time", input: { zone: "Europe/Berlin" } }
    ]);
    expect(
      events.flatMap((event) =>
        event.type === "tool_call_preparing" ? [[event.toolCallId, event.toolName]] : []
      )
    ).toEqual(
      completed.completion.toolCalls.map((toolCall) => [toolCall.toolCallId, toolCall.toolName])
    );
    expect(f.governance.recorded[0]).toMatchObject({ inputTokens: 40, outputTokens: 18 });
  });

  it("sends an earlier tool call and its result back to the model", async () => {
    const f = await fixture(adapter, "tool-result", true);

    const completion = await f.gateway.complete(
      f.call({
        messages: [
          user("What is the weather in Berlin?"),
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { toolCallId: "call_weather_1", toolName: "get_weather", input: { city: "Berlin" } }
            ]
          },
          { role: "tool", toolCallId: "call_weather_1", content: '{"temperatureC":18}' }
        ],
        tools: weatherTools
      })
    );

    // The replay refuses a request that differs from the recorded one, so an answer means the
    // call and its result went out in the provider's form.
    expect(completion.text).toBe("It is 18 degrees in Berlin.");
  });

  it("sends an image with the request", async () => {
    const f = await fixture(adapter, "image");
    expect(f.gateway.capabilities(f.binding).imageInput).toBe(true);

    const completion = await f.gateway.complete(
      f.call({
        messages: [
          user([
            { type: "text", text: "What colour is this pixel?" },
            { type: "image", mimeType: "image/png", data: SYNTHETIC_PNG }
          ])
        ]
      })
    );

    expect(completion.text).toBe("The pixel is transparent.");
  });

  it("sends a document where the model reads documents, and is refused where it does not", async () => {
    const reads = (await adapter.create()).capabilities(adapter.provider.model).documentInput;
    const f = await fixture(adapter, reads ? "document" : undefined);
    const call = f.call({
      messages: [
        user([
          { type: "document", mimeType: "application/pdf", data: SYNTHETIC_PDF },
          { type: "text", text: "Summarize the document." }
        ])
      ]
    });

    if (reads) {
      expect((await f.gateway.complete(call)).text).toBe("The document is a synthetic page.");
      return;
    }
    await expect(f.gateway.complete(call)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("document input")
    });
    expect(f.replayed.count()).toBe(0);
    expect(f.governance.admitted).toBe(0);
  });

  it("answers in JSON for an answer format, and is refused where the model has none", async () => {
    const structured = (await adapter.create()).capabilities(
      adapter.provider.model
    ).structuredOutput;
    const f = await fixture(adapter, structured ? "structured-output" : undefined);
    const call = f.call({
      messages: [user("Summarize the report.")],
      output: { jsonSchema: summarySchema }
    });

    if (structured) {
      const completion = await f.gateway.complete(call);
      expect(JSON.parse(completion.text)).toEqual({
        summary: "A synthetic report.",
        note: null,
        pages: [1, 2]
      });
      return;
    }
    await expect(f.gateway.complete(call)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("structured output")
    });
    expect(f.replayed.count()).toBe(0);
    expect(f.governance.admitted).toBe(0);
  });

  it("fails a call whose answer in an answer format is not JSON, and keeps its usage", async () => {
    const structured = (await adapter.create()).capabilities(
      adapter.provider.model
    ).structuredOutput;
    if (!structured) {
      // The gateway refuses the call before it is sent: the case above shows that.
      return;
    }
    const f = await fixture(adapter, "structured-output-invalid");

    const failure = await f.gateway
      .complete(
        f.call({ messages: [user("Summarize the report.")], output: { jsonSchema: summarySchema } })
      )
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({
      kind: "invalid_response",
      retryable: false,
      message: "Model answer is not valid JSON"
    });
    expect(f.replayed.count()).toBe(1);
    // The provider billed the answer it cut off.
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ inputTokens: 30, outputTokens: 8, source: "provider_reported" })
    ]);
  });

  it("is refused a call with tools, or with a tool call in its history, where it declares no tool calls", async () => {
    const declares = (await adapter.create()).capabilities(adapter.provider.model).toolCalls;
    if (declares) {
      // The tool cases above run on the adapter's own declaration.
      return;
    }
    const f = await fixture(adapter, undefined);
    const history: ModelMessage[] = [
      user("What is the weather in Berlin?"),
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { toolCallId: "call_weather_1", toolName: "get_weather", input: { city: "Berlin" } }
        ]
      },
      { role: "tool", toolCallId: "call_weather_1", content: '{"temperatureC":18}' }
    ];

    for (const call of [
      f.call({ messages: [user("Weather in Berlin?")], tools: weatherTools }),
      f.call({ messages: history })
    ]) {
      await expect(f.gateway.complete(call)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("tool calls")
      });
      await expect(collect(f.gateway.stream(call))).rejects.toMatchObject({
        code: "VALIDATION_FAILED"
      });
    }
    expect(f.replayed.count()).toBe(0);
    expect(f.governance.admitted).toBe(0);
  });

  it.each(["rejected-answer-blocked", "rejected-answer-malformed-call"])(
    "settles an answer the provider counted and then refused with that usage: %s",
    async (name) => {
      if (!hasRecording(adapter.type, name)) {
        // This provider answers such a refusal with an error status and counts nothing.
        return;
      }
      const f = await fixture(adapter, name);

      const failure = await f.gateway
        .complete(f.call({ messages: [user("Summarize the report.")] }))
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ModelProviderError);
      expect(failure).toMatchObject({
        kind: "invalid_response",
        retryable: false,
        message: "Model provider returned no answer"
      });
      expectNoProviderText(failure);
      expect(JSON.stringify(failure)).not.toMatch(/inputTokens|outputTokens/u);
      expect(f.replayed.count()).toBe(1);
      expect(f.governance.recorded).toEqual([
        expect.objectContaining({
          inputTokens: 30,
          outputTokens: 6,
          totalTokens: 36,
          source: "provider_reported"
        })
      ]);
      expect(f.governance.settled).toBe(1);
    }
  );

  it("ends the provider's stream when the reader stops reading, and settles what had arrived once", async () => {
    const f = await fixture(adapter, "abort-stream");
    const received: string[] = [];

    // No signal and no error: the consumer leaves the loop and reads no further.
    for await (const event of f.gateway.stream(f.call({ messages: [user("Say hello.")] }))) {
      if (event.type === "text_delta") {
        received.push(event.delta);
        break;
      }
    }

    expect(received).toEqual(["Hello from"]);
    expect(f.replayed.count()).toBe(1);
    // The answer was still open. Left alone, the provider would write and bill the rest.
    expect(f.replayed.cancelled()).toBe(1);
    expect(f.governance.settled).toBe(1);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ source: "estimated", outputTokens: expect.any(Number) })
    ]);
    expect(f.governance.recorded[0]?.outputTokens).toBeGreaterThan(0);
  });

  it("checks the provider without a generation, and names a refused credential by its class", async () => {
    // A check asks what costs nothing: the list of models, or a token for the key. The replay
    // refuses every other request, so a check that called a model would not come back as ok.
    replayModelAdapterRecording(loadModelAdapterRecording(adapter.type, "check"));
    expect(await adapter.check()).toEqual({ ok: true });
    vi.unstubAllGlobals();

    replayModelAdapterRecording(
      loadModelAdapterRecording(adapter.type, "check-refused"),
      REFUSED_CREDENTIAL_STATUS
    );
    expect(await adapter.check()).toEqual({ ok: false, errorClass: "access_denied" });
  });

  it("stops a completion when the caller stops, and sends it once", async () => {
    const f = await fixture(adapter, "abort");
    const stop = new AbortController();

    const pending = f.gateway.complete(
      f.call({ messages: [user("Say hello.")], signal: stop.signal })
    );
    await vi.waitFor(() => expect(f.replayed.count()).toBe(1));
    stop.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(f.replayed.count()).toBe(1);
    expect(f.governance.recorded).toHaveLength(1);
  });

  it("stops a stream when the caller stops, and settles what had arrived as an estimate", async () => {
    const f = await fixture(adapter, "abort-stream");
    const stop = new AbortController();
    const received: string[] = [];

    const failure = await (async () => {
      for await (const event of f.gateway.stream(
        f.call({ messages: [user("Say hello.")], signal: stop.signal })
      )) {
        if (event.type === "text_delta") {
          received.push(event.delta);
          stop.abort();
        }
      }
    })().catch((error: unknown) => error);

    expect(received).toEqual(["Hello from"]);
    expect(failure).toMatchObject({ name: "AbortError" });
    expect(f.replayed.count()).toBe(1);
    // The provider reported nothing before the stop, so the usage is the gateway's estimate.
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ source: "estimated", outputTokens: expect.any(Number) })
    ]);
    expect(f.governance.recorded[0]?.outputTokens).toBeGreaterThan(0);
  });

  it("reports a rate limit as one, with the pause the provider asked for", async () => {
    const recording = loadModelAdapterRecording(adapter.type, "rate-limit");
    // Not every provider names a pause. Where the recording has none, the error has none.
    const pause = recording.exchanges[0]?.response.headers?.["retry-after"];
    replayModelAdapterRecording(recording);
    const instance = await adapter.create();

    const failure = await instance
      .complete({ model: adapter.provider.model, messages: [user("Say hello.")], tools: [] })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({
      kind: "rate_limit",
      status: 429,
      retryable: true,
      retryAfterMs: pause === undefined ? undefined : Number(pause) * 1000
    });
    expectNoProviderText(failure);
  });

  it("sends a call again after a rate limit and tells the user when the limit holds", async () => {
    const f = await fixture(adapter, "rate-limit");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const failure = await advanceFakeClockUntilSettled(
      f.gateway
        .complete(f.call({ messages: [user("Say hello.")] }))
        .catch((error: unknown) => error),
      RETRY_CLOCK_STEP_MS
    );

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: "RATE_LIMITED" });
    expect(f.replayed.count()).toBeGreaterThan(1);
    expectNoProviderText(failure);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    ]);
  });

  it("sends a call again after a server error and answers once the provider does", async () => {
    const f = await fixture(adapter, "server-error-then-text");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const completion = await advanceFakeClockUntilSettled(
      f.gateway.complete(f.call({ messages: [user("Say hello.")] })),
      RETRY_CLOCK_STEP_MS
    );

    expect(completion.text).toBe("Hello from the recording.");
    expect(f.replayed.count()).toBe(2);
    // One call, one usage record, whatever the number of attempts.
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ inputTokens: 12, outputTokens: 5, source: "provider_reported" })
    ]);
  });

  it("fails with a typed server error that carries none of the provider's text", async () => {
    const f = await fixture(adapter, "server-error");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    const failure = await advanceFakeClockUntilSettled(
      f.gateway
        .complete(f.call({ messages: [user("Say hello.")] }))
        .catch((error: unknown) => error),
      RETRY_CLOCK_STEP_MS
    );

    expect(failure).toBeInstanceOf(ModelProviderError);
    expect(failure).toMatchObject({
      kind: "server_error",
      status: 503,
      retryable: true,
      message: "Model provider request failed"
    });
    expect(f.replayed.count()).toBe(3);
    expectNoProviderText(failure);
    // The provider's own words are kept for the gateway's log line, cut to the log limit.
    if (!(failure instanceof ModelProviderError)) throw new Error("unreachable");
    expect(failure.providerMessage).toContain(PLANTED_PROVIDER_TEXT);
    expect(failure.providerMessage?.length).toBeLessThanOrEqual(300);
  });
});

describe("model adapter recordings", () => {
  it("hold no credential, and plant the provider text in every recorded refusal", () => {
    const directory = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/model-adapter-recordings"
    );
    for (const adapter of conformanceAdapters) {
      for (const file of readdirSync(resolve(directory, adapter.type))) {
        const text = readFileSync(resolve(directory, adapter.type, file), "utf8");
        expect(text, file).not.toMatch(/authorization|bearer|api-key|private_key|access_token/iu);
        if (/"status": (?:429|503)/u.test(text)) {
          expect(text, file).toContain(PLANTED_PROVIDER_TEXT);
        }
      }
    }
  });
});

function hasRecording(adapter: string, name: string): boolean {
  return existsSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "fixtures/model-adapter-recordings",
      adapter,
      `${name}.json`
    )
  );
}

interface Fixture {
  gateway: ModelGateway;
  governance: RecordingGovernance;
  replayed: ReplayedRequests;
  binding: { providerId: string };
  call(input: Pick<ModelCall, "messages"> & Partial<ModelCall>): ModelCall;
}

/**
 * One adapter behind the gateway, answering from the named recording, or from none.
 *
 * `withToolCalls` declares tool calls for an adapter that withholds the declaration, so that
 * the tool cases still prove what it sends and reads on the wire. Without it the gateway
 * refuses the call, which the case on the declaration shows.
 */
async function fixture(
  adapter: ConformanceAdapter,
  recording: string | undefined,
  withToolCalls = false
): Promise<Fixture> {
  const replayed = replayModelAdapterRecording(
    recording ? loadModelAdapterRecording(adapter.type, recording) : { exchanges: [] }
  );
  const governance = createRecordingGovernance();
  governed.push(governance);
  const binding = { providerId: adapter.provider.id };
  const created = await adapter.create();
  return {
    gateway: createModelGateway({
      providers: [adapter.provider],
      bindings: [],
      adapters: new Map([
        [
          adapter.provider.id,
          withToolCalls
            ? {
                ...created,
                capabilities: (model) => ({ ...created.capabilities(model), toolCalls: true })
              }
            : created
        ]
      ]),
      governance,
      logger: silentTestLogger
    }),
    governance,
    replayed,
    binding,
    call: (input) => ({
      binding,
      tools: [],
      attribution: {
        kind: "system",
        purpose: "document_extraction",
        conversationId: asConversationId("conv_adapter_conformance")
      },
      clientInstanceId,
      correlationId: "adapter-conformance",
      ...input
    })
  };
}

async function collect(
  stream: AsyncIterable<ModelCallStreamEvent>
): Promise<ModelCallStreamEvent[]> {
  const events: ModelCallStreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

/** Nothing a caller, a response or a serializer reads from the error holds the provider's text. */
function expectNoProviderText(error: unknown): void {
  if (!(error instanceof Error)) throw new Error("Expected an error");
  const readable = [
    error.message,
    JSON.stringify(error),
    JSON.stringify(error instanceof AppError ? error.details : undefined),
    String(error),
    error.stack ?? ""
  ].join("\n");
  expect(readable).not.toContain(PLANTED_PROVIDER_TEXT);
}
