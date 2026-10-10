import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AppError,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type ModelProviderConfig,
  type ModelUsageEvent,
  type UsageCostConfig
} from "@vivd-catalyst/core";
import {
  ModelProviderError,
  createModelGateway,
  isModelProviderContinuationRejected,
  type ModelAdapter,
  type ModelAdapterRequest,
  type ModelCall,
  type ModelCompletion,
  type ModelCompletionStreamEvent
} from "@vivd-catalyst/model-provider";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { advanceFakeClockUntilSettled, useFakeClockBesidePostgres } from "./support/fake-clock";
import { ALL_MODEL_CAPABILITIES, silentTestLogger } from "./support/model-gateway";
import { createTestInstance } from "./support/test-instance";
import { ensureTestUser } from "./support/test-store";

const provider: ModelProviderConfig = { id: "main", type: "fake", model: "entry-model" };
const clientInstanceId = asClientInstanceId("client-gateway-usage");
// Longer than the two waits of a retried call, in steps short enough to pass each wait once.
const RETRY_CLOCK_STEP_MS = 500;

afterEach(() => {
  vi.useRealTimers();
});

describe("model gateway usage recording", () => {
  it("leaves one event with the provider's usage for a call that succeeds", async () => {
    const f = await fixture(async () => completion(120));

    await f.gateway.complete(call());

    expect(await f.events()).toEqual([
      expect.objectContaining({
        providerId: "main",
        model: "entry-model",
        agentRunId: "run_gateway_usage",
        conversationId: "conv_gateway_usage",
        agentName: "agent",
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        source: "provider_reported"
      })
    ]);
  });

  it("leaves one event without usage for a call the provider fails", async () => {
    const f = await fixture(async () => {
      throw new ModelProviderError({
        kind: "invalid_request",
        status: 400,
        message: "Model provider request failed"
      });
    });

    await expect(f.gateway.complete(call())).rejects.toMatchObject({ kind: "invalid_request" });

    expect(await f.events()).toEqual([uncompletedEvent()]);
  });

  it("leaves one event for a cancelled call", async () => {
    const stop = new AbortController();
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    const f = await fixture(
      (request) =>
        new Promise<ModelCompletion>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(abort), { once: true });
        })
    );

    const stopped = f.gateway.complete(call({ signal: stop.signal }));
    await vi.waitFor(() => expect(f.requests).toHaveLength(1));
    stop.abort();

    await expect(stopped).rejects.toBe(abort);
    expect(await f.events()).toEqual([uncompletedEvent()]);
  });

  it("leaves one event for a call whose every attempt times out", async () => {
    const f = await fixture(async () => {
      throw new AppError("TIMEOUT", "Model provider request timed out");
    });
    useFakeClockBesidePostgres();

    const error = await advanceFakeClockUntilSettled(
      f.gateway.complete(call()).catch((thrown: unknown) => thrown),
      RETRY_CLOCK_STEP_MS
    );
    vi.useRealTimers();

    expect(error).toMatchObject({ kind: "timeout", code: "TIMEOUT" });
    expect(f.requests).toHaveLength(3);
    expect(await f.events()).toEqual([uncompletedEvent()]);
  });

  it("leaves one event with the last attempt's usage for a retried call", async () => {
    let attempts = 0;
    const f = await fixture(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new ModelProviderError({
          kind: "server_error",
          status: 502,
          message: "Model provider request failed"
        });
      }
      return completion(120);
    });
    useFakeClockBesidePostgres();

    await advanceFakeClockUntilSettled(f.gateway.complete(call()), RETRY_CLOCK_STEP_MS);
    vi.useRealTimers();

    expect(attempts).toBe(2);
    expect(await f.events()).toEqual([
      expect.objectContaining({ totalTokens: 120, source: "provider_reported" })
    ]);
  });

  it("counts the usage once for a call recovered after its continuation was dropped", async () => {
    const f = await fixture(async (request) => {
      if (request.continuation) {
        throw new ModelProviderError({
          kind: "continuation_rejected",
          status: 400,
          message: "Model provider request failed"
        });
      }
      return completion(120);
    });
    const continued = call({ continuation: { providerId: "main", state: { id: "resp_1" } } });

    // The run drops the rejected continuation and calls again from the conversation's history.
    const rejected: unknown = await f.gateway
      .complete(continued)
      .catch((thrown: unknown) => thrown);
    expect(isModelProviderContinuationRejected(rejected)).toBe(true);
    await f.gateway.complete(call());

    const events = await f.events();
    expect(events).toHaveLength(2);
    expect(events.filter((event) => event.totalTokens > 0)).toEqual([
      expect.objectContaining({ totalTokens: 120, source: "provider_reported" })
    ]);
    expect(events.reduce((sum, event) => sum + event.totalTokens, 0)).toBe(120);
  });

  // Fails without the change: a stream that ended without its completion was settled as
  // failed with nothing used, whatever had arrived of its answer.
  it.each([
    {
      how: "the caller stops",
      end: (stop: AbortController): void => {
        stop.abort();
        throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
      }
    },
    {
      how: "the provider breaks off",
      end: (): void => {
        throw new ModelProviderError({
          kind: "server_error",
          status: 500,
          message: "Model provider stream failed"
        });
      }
    }
  ])("settles a stream with an estimate when $how after text arrived", async ({ end }) => {
    const stop = new AbortController();
    // Thirty characters: ten tokens at three characters a token.
    const answer = "Thirty characters of an answer";
    const costs: UsageCostConfig = {
      customer: {
        id: "customer",
        version: "2026-10",
        currency: "EUR",
        models: [
          {
            providerId: "main",
            model: "entry-model",
            uncachedInputPricePerMillionTokens: 2,
            cachedInputPricePerMillionTokens: 0.5,
            outputPricePerMillionTokens: 8
          }
        ]
      }
    };
    const f = await fixture(
      async () => completion(120),
      {},
      {
        costs,
        async *stream() {
          yield { type: "text_delta", delta: answer };
          end(stop);
        }
      }
    );

    await expect(
      (async () => {
        for await (const _event of f.gateway.stream(call({ signal: stop.signal }))) {
          // Read to the end.
        }
      })()
    ).rejects.toBeDefined();

    // "hello" is five characters: two input tokens, taken as not cached.
    expect(await f.events()).toEqual([
      expect.objectContaining({
        status: "settled",
        source: "estimated",
        inputTokens: 2,
        cachedInputTokens: 0,
        outputTokens: 10,
        totalTokens: 12,
        customerBillableCost: expect.objectContaining({
          status: "settled",
          totalCostMicros: 2 * 2 + 10 * 8
        })
      })
    ]);
    const summary = await f.summary();
    expect(summary.today).toMatchObject({
      modelCallCount: 1,
      totalTokens: 12,
      cost: { status: "settled", billableCostMicros: 84 }
    });
  });

  it("leaves no event for a call admission refuses", async () => {
    const f = await fixture(async () => completion(120), { modelCallsPerDay: 1 });

    await f.gateway.complete(call());
    await expect(f.gateway.complete(call())).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(f.requests).toHaveLength(1);
    expect(await f.events()).toHaveLength(1);
  });
});

async function fixture(
  complete: (request: ModelAdapterRequest) => Promise<ModelCompletion>,
  safeguards: { modelCallsPerDay?: number } = {},
  streamed?: {
    stream: (request: ModelAdapterRequest) => AsyncIterable<ModelCompletionStreamEvent>;
    costs: UsageCostConfig;
  }
) {
  const store = (await createTestInstance()).stores;
  // The user of the calls: an event keeps its run and conversation only for a user that exists.
  await ensureTestUser(clientInstanceId, "user-1");
  const requests: ModelAdapterRequest[] = [];
  const adapter: ModelAdapter = {
    capabilities: () => ALL_MODEL_CAPABILITIES,
    complete(request) {
      requests.push(request);
      return complete(request);
    },
    stream(request) {
      requests.push(request);
      if (!streamed) throw new Error("These calls do not stream");
      return streamed.stream(request);
    }
  };
  return {
    requests,
    gateway: createModelGateway({
      providers: [provider],
      bindings: [],
      adapters: new Map([["main", adapter]]),
      governance: new ModelUsageGovernance({
        store: store.usage,
        budget: {},
        safeguards,
        ...(streamed ? { costs: streamed.costs } : {})
      }),
      logger: silentTestLogger
    }),
    events: (): Promise<ModelUsageEvent[]> => store.usage.listModelUsageEvents({ clientInstanceId }),
    summary: () =>
      new ModelUsageGovernance({
        store: store.usage,
        budget: {},
        safeguards,
        ...(streamed ? { costs: streamed.costs } : {})
      }).createSafeSummary({ clientInstanceId })
  };
}

function call(overrides: Partial<ModelCall> = {}): ModelCall {
  return {
    binding: { providerId: "main" },
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    attribution: {
      kind: "agent_run",
      conversationId: asConversationId("conv_gateway_usage"),
      runId: asAgentRunId("run_gateway_usage"),
      agentName: "agent",
      userId: "user-1"
    },
    clientInstanceId,
    correlationId: "corr-gateway-usage",
    ...overrides
  };
}

function completion(totalTokens: number): ModelCompletion {
  return {
    text: "ok",
    toolCalls: [],
    usage: {
      inputTokens: totalTokens - 20,
      outputTokens: 20,
      totalTokens,
      source: "provider_reported",
      webSearchCallCount: 0
    }
  };
}

function uncompletedEvent() {
  return expect.objectContaining({
    providerId: "main",
    model: "entry-model",
    agentRunId: "run_gateway_usage",
    // Settled when the call ended, with nothing used: nothing stays reserved for it.
    status: "failed",
    source: "not_reported",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  });
}
