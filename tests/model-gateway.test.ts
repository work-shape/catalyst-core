import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  ProviderRegistry,
  type Logger,
  type ModelProviderConfig
} from "@vivd-catalyst/core";
import {
  MODEL_PROVIDER_MESSAGE_MAX_CHARS,
  ModelProviderError,
  createInstanceModelGateway,
  createModelGateway,
  isModelProviderContinuationRejected,
  modelProviderDefinitions,
  type ModelAdapter,
  type ModelAdapterRequest,
  type ModelCall,
  type ModelCallStreamEvent,
  type ModelCapabilities,
  type ModelCompletion,
  type ModelCompletionStreamEvent
} from "@vivd-catalyst/model-provider";
import { createFakeSecrets } from "./support/fixtures";
import { ALL_MODEL_CAPABILITIES, createRecordingGovernance } from "./support/model-gateway";

const provider: ModelProviderConfig = {
  id: "main",
  type: "fake",
  model: "entry-model",
  region: "eu"
};
const clientInstanceId = asClientInstanceId("gateway-test");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("model gateway", () => {
  it("resolves a binding to its provider entry and model, and an entry to its own model", async () => {
    const f = fixture({ complete: async () => completion("ok") });

    await f.gateway.complete(call({ binding: { bindingId: "fast" } }));
    await f.gateway.complete(call({ binding: { providerId: "main" } }));
    await f.gateway.complete(call({ binding: { providerId: "main", model: "other-model" } }));

    expect(f.requests.map((request) => request.model)).toEqual([
      "bound-model",
      "entry-model",
      "other-model"
    ]);
    expect(
      f.governance.recorded.map((event) => [event.providerId, event.model, event.region])
    ).toEqual([
      ["main", "bound-model", "eu"],
      ["main", "entry-model", "eu"],
      ["main", "other-model", "eu"]
    ]);
    await expect(f.gateway.complete(call({ binding: { bindingId: "missing" } }))).rejects.toThrow(
      "Model binding 'missing' is not defined"
    );
    expect(f.gateway.capabilities({ bindingId: "fast" })).toBe(f.capabilities);
  });

  it.each([
    ["a reasoning effort", { reasoningEffort: "high" as const }, "reasoning effort 'high'"],
    [
      "a native tool",
      {
        tools: [
          {
            kind: "provider" as const,
            name: "web_search" as const
          }
        ]
      },
      "native tool 'web_search'"
    ],
    ["a continuation", { continuation: { providerId: "main", state: {} } }, "continuation"],
    ["the fast tier", { fastTier: true }, "fast tier"],
    ["structured output", { output: { jsonSchema: { type: "object" } } }, "structured output"]
  ])(
    "refuses %s the adapter does not declare before it calls the adapter",
    async (_name, ask, named) => {
      const f = fixture(
        { complete: async () => completion("never") },
        {
          reasoningEfforts: [],
          nativeTools: [],
          continuation: false,
          fastTier: false,
          structuredOutput: false
        }
      );

      const error = await f.gateway.complete(call(ask)).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({
        code: "VALIDATION_FAILED",
        message: expect.stringContaining(named)
      });
      expect(f.requests).toHaveLength(0);
      expect(f.governance.admitted).toBe(0);
      expect(f.governance.recorded).toHaveLength(0);
    }
  );

  it("refuses a streamed call to an adapter that does not stream", async () => {
    const f = fixture({ complete: async () => completion("never") }, { streaming: false });

    await expect(drain(f.gateway.stream(call()))).rejects.toThrow("does not support: streaming");
    expect(f.requests).toHaveLength(0);
  });

  it("sends a retryable error again after the two waits and then throws it", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const attemptTimes: number[] = [];
    const f = fixture({
      async complete() {
        attemptTimes.push(Date.now());
        throw new ModelProviderError({
          kind: "server_error",
          status: 503,
          message: "Model provider request failed"
        });
      }
    });

    const failed = f.gateway.complete(call()).catch((thrown: unknown) => thrown);
    await vi.advanceTimersByTimeAsync(10_000);
    const error = await failed;

    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ kind: "server_error", status: 503 });
    expect(waitsBetween(attemptTimes)).toEqual([1_000, 4_000]);
    expect(f.governance.admitted).toBe(1);
    expect(f.governance.recorded).toHaveLength(1);
  });

  it("answers with the attempt that succeeds and records the call once", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const f = fixture({
      async complete() {
        attempts += 1;
        if (attempts < 3) {
          throw new ModelProviderError({
            kind: "network",
            message: "Model provider connection failed"
          });
        }
        return completion("third time", 7);
      }
    });

    const answered = f.gateway.complete(call());
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(answered).resolves.toMatchObject({ text: "third time" });
    expect(attempts).toBe(3);
    expect(f.governance.admitted).toBe(1);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ totalTokens: 7, source: "provider_reported" })
    ]);
  });

  it("does not send an error again that is not retryable", async () => {
    const f = fixture({
      async complete() {
        throw new ModelProviderError({
          kind: "invalid_request",
          status: 400,
          message: "Model provider request failed"
        });
      }
    });

    await expect(f.gateway.complete(call())).rejects.toMatchObject({ kind: "invalid_request" });
    expect(f.requests).toHaveLength(1);
  });

  it("reads an untyped error by its code and never by its text", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const f = fixture({
      async complete() {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new TypeError("anything"), { cause: { code: "ECONNRESET" } });
        }
        throw new Error("fetch failed: socket hang up, timed out, terminated");
      }
    });

    const failed = f.gateway.complete(call()).catch((thrown: unknown) => thrown);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await failed).toMatchObject({ message: expect.stringContaining("fetch failed") });
    expect(attempts).toBe(2);
  });

  it("waits as long as a rate limit's Retry-After asks, within a minute and the deadline", async () => {
    vi.useFakeTimers();
    const attemptTimes: number[] = [];
    let retryAfterMs = 30_000;
    const f = fixture({
      async complete() {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          throw new ModelProviderError({
            kind: "rate_limit",
            status: 429,
            retryAfterMs,
            message: "Model provider request failed"
          });
        }
        return completion("after the pause");
      }
    });

    const answered = f.gateway.complete(call());
    await vi.advanceTimersByTimeAsync(31_000);
    await expect(answered).resolves.toMatchObject({ text: "after the pause" });
    expect(waitsBetween(attemptTimes)).toEqual([30_000]);

    // More than the minute a call may wait on a rate limit: it fails at once, readable.
    attemptTimes.length = 0;
    retryAfterMs = 60_001;
    await expect(f.gateway.complete(call())).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "The model is receiving too many requests. Try again in a minute."
    });
    expect(attemptTimes).toHaveLength(1);

    // A pause that would end after the caller's deadline is not started either.
    attemptTimes.length = 0;
    retryAfterMs = 30_000;
    const startedAt = Date.now();
    await expect(
      f.gateway.complete(call({ deadline: new Date(startedAt + 20_000) }))
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(attemptTimes).toHaveLength(1);
    expect(Date.now()).toBe(startedAt);

    // A deadline that has passed admits nothing and records nothing.
    const recordedBefore = f.governance.recorded.length;
    await expect(
      f.gateway.complete(call({ deadline: new Date(Date.now() - 1) }))
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(f.governance.recorded).toHaveLength(recordedBefore);
  });

  it("sends a stream again while the caller has only seen an announced tool call", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const f = fixture({
      async *stream() {
        attempts += 1;
        if (attempts === 1) {
          yield { type: "tool_call_preparing", toolCallId: "call_1", toolName: "lookup" };
          throw new ModelProviderError({
            kind: "network",
            message: "Model provider connection failed"
          });
        }
        yield { type: "text_delta", delta: "Hello" };
        yield { type: "completed", completion: completion("Hello") };
      }
    });

    const events = drain(f.gateway.stream(call()));
    await vi.advanceTimersByTimeAsync(2_000);

    expect((await events).map((event) => event.type)).toEqual([
      "tool_call_preparing",
      "tool_call_preparation_cancelled",
      "text_delta",
      "completed"
    ]);
    expect(f.governance.recorded).toHaveLength(1);
  });

  it("does not send a stream again once the caller has received output", async () => {
    let attempts = 0;
    const f = fixture({
      async *stream() {
        attempts += 1;
        yield { type: "text_delta", delta: "Visible" };
        throw new ModelProviderError({
          kind: "server_error",
          status: 500,
          message: "Model provider stream failed"
        });
      }
    });
    const seen: ModelCallStreamEvent[] = [];

    await expect(
      (async () => {
        for await (const event of f.gateway.stream(call())) {
          seen.push(event);
        }
      })()
    ).rejects.toMatchObject({ kind: "server_error" });

    expect(attempts).toBe(1);
    expect(seen).toEqual([{ type: "text_delta", delta: "Visible" }]);
    expect(f.governance.recorded).toHaveLength(1);
  });

  it("throws the abort of a stopped call and records it once", async () => {
    const stop = new AbortController();
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const f = fixture({
      complete: (request) =>
        new Promise<ModelCompletion>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(abort), { once: true });
        })
    });

    const stopped = f.gateway.complete(call({ signal: stop.signal }));
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    stop.abort();

    await expect(stopped).rejects.toBe(abort);
    expect(f.requests).toHaveLength(1);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
    ]);

    // A call that is already stopped reaches neither admission nor the adapter.
    await expect(f.gateway.complete(call({ signal: stop.signal }))).rejects.toMatchObject({
      code: "CONFLICT"
    });
    expect(f.requests).toHaveLength(1);
    expect(f.governance.recorded).toHaveLength(1);
  });

  // Without the gateway's check of the caller's signal this fails: the transport reports the cut
  // response body as a lost connection, which was logged as a provider's error and thrown.
  it("treats a stream stopped with a plain reason as a stop, through the real adapter", async () => {
    const stop = new AbortController();
    const encoder = new TextEncoder();
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n')
            );
            // As the platform's fetch does: the body fails with the reason the caller gave.
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true
            });
          }
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const logged: unknown[] = [];
    const logger: Logger = {
      debug() {},
      info() {},
      warn: (input) => void logged.push(input),
      error: (input) => void logged.push(input),
      child: () => logger
    };
    const governance = createRecordingGovernance();
    const gateway = await createInstanceModelGateway({
      registry: new ProviderRegistry(modelProviderDefinitions),
      providers: [{ id: "main", type: "openai-compatible", model: "test-model" }],
      entries: {
        main: {
          provider: "openai-compatible",
          region: "eu",
          model: "test-model",
          baseUrl: "https://models.example.test/v1",
          credentialSecret: "MODEL_KEY"
        }
      },
      context: { logger, secrets: createFakeSecrets({ MODEL_KEY: "model-key-value" }) },
      bindings: [],
      governance
    });
    const seen: ModelCallStreamEvent[] = [];

    const error: unknown = await (async () => {
      for await (const event of gateway.stream(call({ signal: stop.signal }))) {
        seen.push(event);
        stop.abort("Agent run was cancelled");
      }
    })().catch((thrown: unknown) => thrown);

    expect(seen).toEqual([{ type: "text_delta", delta: "Hel" }]);
    expect(error).not.toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ name: "AbortError", message: "Agent run was cancelled" });
    expect(logged).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // "hello" went out and "Hel" arrived: two tokens and one, at three characters a token.
    expect(governance.recorded).toEqual([
      expect.objectContaining({
        source: "estimated",
        inputTokens: 2,
        cachedInputTokens: 0,
        outputTokens: 1,
        totalTokens: 3
      })
    ]);
  });

  it("clears the wait and fails when the call is stopped while it waits", async () => {
    vi.useFakeTimers();
    const stop = new AbortController();
    const f = fixture({
      async complete() {
        throw new ModelProviderError({
          kind: "rate_limit",
          status: 429,
          message: "Model provider request failed"
        });
      }
    });

    const failed = f.gateway
      .complete(call({ signal: stop.signal }))
      .catch((thrown: unknown) => thrown);
    await vi.advanceTimersByTimeAsync(100);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(await failed).toMatchObject({ code: "RATE_LIMITED" });
    expect(vi.getTimerCount()).toBe(0);
    expect(f.requests).toHaveLength(1);
    expect(f.governance.recorded).toHaveLength(1);
  });

  it("records the answer of a stream its caller stops reading at the completion", async () => {
    const f = fixture({
      async *stream() {
        yield { type: "completed", completion: completion("done", 11) };
      }
    });

    for await (const event of f.gateway.stream(call())) {
      if (event.type === "completed") break;
    }

    expect(f.governance.recorded).toEqual([expect.objectContaining({ totalTokens: 11 })]);
  });

  it("fails a completed call whose usage cannot be recorded, without calling the model again", async () => {
    const f = fixture({ complete: async () => completion("answered") });
    f.governance.failSettlement = new Error("usage store is down");

    await expect(f.gateway.complete(call())).rejects.toThrow("usage store is down");
    expect(f.requests).toHaveLength(1);
  });

  it("records nothing and calls nothing when admission refuses the call", async () => {
    const f = fixture({ complete: async () => completion("never") });
    f.governance.refuseAdmission = new AppError(
      "FORBIDDEN",
      "Daily model call safeguard has been reached"
    );

    await expect(f.gateway.complete(call())).rejects.toBe(f.governance.refuseAdmission);
    await expect(drain(f.gateway.stream(call()))).rejects.toBe(f.governance.refuseAdmission);
    expect(f.requests).toHaveLength(0);
    expect(f.governance.recorded).toHaveLength(0);
  });

  it("keeps the provider's message out of the error and logs it cut to the limit", async () => {
    const secret = "PRIVATE the provider repeats what the user sent ";
    const providerMessage = secret.repeat(20);
    const f = fixture({
      async complete() {
        throw new ModelProviderError({
          kind: "invalid_request",
          status: 400,
          providerCode: "invalid_input",
          providerRequestId: "req-1",
          providerMessage,
          message: "Model provider request failed"
        });
      }
    });

    const error: unknown = await f.gateway.complete(call()).catch((thrown: unknown) => thrown);

    if (!(error instanceof ModelProviderError)) {
      throw new Error("The call did not fail with the provider's error");
    }
    const thrown = error;
    for (const view of [
      thrown.message,
      String(thrown),
      thrown.stack ?? "",
      JSON.stringify(thrown)
    ]) {
      expect(view).not.toContain("PRIVATE");
    }
    expect(JSON.stringify(Object.entries(thrown))).not.toContain("PRIVATE");
    expect(thrown.cause).toBeUndefined();

    const logged = f.warnings.find((entry) => entry.type === "model_provider.error");
    expect(logged).toMatchObject({
      providerId: "main",
      kind: "invalid_request",
      status: 400,
      providerCode: "invalid_input",
      providerRequestId: "req-1",
      runId: "run_gateway"
    });
    expect(logged?.providerMessage).toBe(
      providerMessage.replace(/\s+/gu, " ").trim().slice(0, MODEL_PROVIDER_MESSAGE_MAX_CHARS)
    );
    expect(String(logged?.providerMessage)).toHaveLength(MODEL_PROVIDER_MESSAGE_MAX_CHARS);
  });

  it("tells a rejected continuation apart by its kind", () => {
    expect(
      isModelProviderContinuationRejected(
        new ModelProviderError({ kind: "continuation_rejected", message: "rejected" })
      )
    ).toBe(true);
    expect(
      isModelProviderContinuationRejected(
        new AppError("INTERNAL", "rejected", { continuationRejected: true })
      )
    ).toBe(false);
  });

  it("admits and records a call the product makes for itself, with its purpose", async () => {
    const f = fixture({ complete: async () => completion("A title") });
    const attribution = {
      kind: "system" as const,
      purpose: "conversation_title" as const,
      conversationId: asConversationId("conv_gateway"),
      userId: "user-1"
    };

    await expect(f.gateway.complete(call({ attribution }))).resolves.toMatchObject({
      text: "A title"
    });

    expect(f.governance.admitted).toBe(1);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ attribution, totalTokens: 3 })
    ]);
  });

  it("names the purpose of a system call in the provider error log", async () => {
    const f = fixture({
      async complete() {
        throw new ModelProviderError({ kind: "invalid_request", status: 400, message: "refused" });
      }
    });

    await expect(
      f.gateway.complete(call({ attribution: { kind: "system", purpose: "guardrail_judge" } }))
    ).rejects.toMatchObject({ kind: "invalid_request" });

    expect(f.warnings).toEqual([expect.objectContaining({ purpose: "guardrail_judge" })]);
  });

  it("gives up a completion at the deadline even when the adapter ignores the stop", async () => {
    vi.useFakeTimers();
    const f = fixture({ complete: () => new Promise<ModelCompletion>(() => {}) });

    let ended = false;
    const pending = f.gateway
      .complete(call({ deadline: new Date(Date.now() + 5_000) }))
      .catch((thrown: unknown) => thrown)
      .finally(() => {
        ended = true;
      });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(f.requests[0]?.signal?.aborted).toBe(false);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(await pending).toMatchObject({ code: "TIMEOUT" });
    // The adapter was told to stop, the call is not sent again, and it is recorded once.
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.signal?.aborted).toBe(true);
    expect(f.governance.recorded).toEqual([
      expect.objectContaining({ totalTokens: 0, source: "estimated" })
    ]);
    expect(f.warnings).toEqual([]);
  });

  it("fails a stream as timed out when its adapter stops at the deadline", async () => {
    vi.useFakeTimers();
    const f = fixture({
      stream: (request) => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<ModelCompletionStreamEvent>>((_resolve, reject) => {
              request.signal?.addEventListener(
                "abort",
                () => reject(new DOMException("This operation was aborted", "AbortError")),
                { once: true }
              );
            })
        })
      })
    });

    const pending = drain(f.gateway.stream(call({ deadline: new Date(Date.now() + 5_000) }))).catch(
      (thrown: unknown) => thrown
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toMatchObject({ code: "TIMEOUT" });
    expect(f.requests).toHaveLength(1);
    expect(f.governance.recorded).toHaveLength(1);
  });

  it("keeps a caller's stop a stop when the call also has a deadline", async () => {
    const stop = new AbortController();
    const abort = new DOMException("This operation was aborted", "AbortError");
    const f = fixture({
      complete: (request) =>
        new Promise<ModelCompletion>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(abort), { once: true });
        })
    });

    const stopped = f.gateway.complete(
      call({ signal: stop.signal, deadline: new Date(Date.now() + 60_000) })
    );
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    stop.abort();

    await expect(stopped).rejects.toBe(abort);
    expect(f.governance.recorded).toHaveLength(1);
  });
});

function fixture(
  script: {
    complete?: (request: ModelAdapterRequest) => Promise<ModelCompletion>;
    stream?: (request: ModelAdapterRequest) => AsyncIterable<ModelCompletionStreamEvent>;
  },
  capabilities: Partial<ModelCapabilities> = {}
) {
  const declared: ModelCapabilities = { ...ALL_MODEL_CAPABILITIES, ...capabilities };
  const requests: ModelAdapterRequest[] = [];
  const adapter: ModelAdapter = {
    capabilities: () => declared,
    complete(request) {
      requests.push(request);
      if (!script.complete) {
        throw new Error("The scripted adapter does not complete");
      }
      return script.complete(request);
    },
    stream(request) {
      requests.push(request);
      if (!script.stream) {
        throw new Error("The scripted adapter does not stream");
      }
      return script.stream(request);
    }
  };
  const warnings: Record<string, unknown>[] = [];
  const logger: Logger = {
    debug() {},
    info() {},
    warn(input) {
      if (typeof input === "object" && input !== null) {
        warnings.push({ ...input });
      }
    },
    error() {},
    child() {
      return logger;
    }
  };
  const governance = createRecordingGovernance();
  const state = { requests, warnings, capabilities: declared, governance };
  return Object.assign(state, {
    gateway: createModelGateway({
      providers: [provider],
      bindings: [{ id: "fast", providerId: "main", model: "bound-model" }],
      adapters: new Map([["main", adapter]]),
      governance,
      logger
    })
  });
}

function call(overrides: Partial<ModelCall> = {}): ModelCall {
  return {
    binding: { providerId: "main" },
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    attribution: {
      kind: "agent_run",
      conversationId: asConversationId("conv_gateway"),
      runId: asAgentRunId("run_gateway"),
      agentName: "agent",
      userId: "user-1"
    },
    clientInstanceId,
    correlationId: "corr-gateway",
    ...overrides
  };
}

function completion(text: string, totalTokens = 3): ModelCompletion {
  return {
    text,
    toolCalls: [],
    usage: {
      inputTokens: totalTokens - 1,
      outputTokens: 1,
      totalTokens,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  };
}

async function drain(events: AsyncIterable<ModelCallStreamEvent>): Promise<ModelCallStreamEvent[]> {
  const seen: ModelCallStreamEvent[] = [];
  for await (const event of events) {
    seen.push(event);
  }
  return seen;
}

function waitsBetween(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - (times[index] ?? 0));
}
