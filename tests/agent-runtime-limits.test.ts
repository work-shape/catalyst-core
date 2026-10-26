import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asClientInstanceId,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import {
  ModelProviderError,
  type ModelCompletionStreamEvent
} from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it, vi } from "vitest";
import {
  createConversationWithMessages,
  createUnusedToolRunner,
  noReportedUsage
} from "./helpers/agent-runtime";
import { advanceFakeClockUntilSettled, useFakeClockBesidePostgres } from "./support/fake-clock";
import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
  it("waits out a rate limit with growing pauses and gives up after a minute of waiting", async () => {
    const f = await rateLimitFixture("provider-rate-limit-retry");
    const stepMs = 500;
    // The largest jitter: each wait is its base plus 20 percent.
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    useFakeClockBesidePostgres();
    try {
      f.rateLimitedAnswers = 2;
      const survived = await advanceFakeClockUntilSettled(f.runToEnd("hello"), stepMs);

      expect(survived).toEqual(["message_delta", "message_completed", "run_completed"]);
      expect(f.attemptTimes).toHaveLength(3);
      // An upper bound on fake time must not depend on the step: the clock moves on while the
      // machine works. Each wait is at least its length and shorter than the next longer one.
      const waits = waitsBetween(f.attemptTimes);
      expect(waits[0]).toBeGreaterThanOrEqual(4_800);
      expect(waits[0]).toBeLessThan(9_600);
      expect(waits[1]).toBeGreaterThanOrEqual(9_600);
      expect(waits[1]).toBeLessThan(19_200);

      // The smallest jitter: each wait is its base minus 20 percent, the last what is left.
      random.mockReturnValue(0);
      f.attemptTimes.length = 0;
      f.rateLimitedAnswers = 99;
      const failed = await advanceFakeClockUntilSettled(f.runToEnd("hello again"), stepMs);

      expect(failed).toEqual(["run_failed"]);
      expect(f.lastFailure).toEqual({
        code: "RATE_LIMITED",
        message: "The model is receiving too many requests. Try again in a minute.",
        category: "app_error"
      });
      const failedWaits = waitsBetween(f.attemptTimes);
      expect(failedWaits).toHaveLength(5);
      [3_200, 6_400, 12_800, 25_600, 12_000].forEach((expected, index) => {
        expect(failedWaits[index]).toBeGreaterThanOrEqual(expected);
        expect(failedWaits[index]).toBeLessThan(expected * 2);
      });
      // Nothing waits behind the failure: no later attempt starts.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.attemptTimes).toHaveLength(6);
    } finally {
      vi.useRealTimers();
      random.mockRestore();
    }
  });

  it("clears the rate limit wait when the run is cancelled during it", async () => {
    const f = await rateLimitFixture("provider-rate-limit-cancel");
    const stepMs = 250;
    useFakeClockBesidePostgres();
    try {
      f.rateLimitedAnswers = 99;
      const cancellation = new AbortController();
      const attempted = new Promise<void>((resolve) => {
        f.onAttempt = resolve;
      });
      const run = f.runToEnd("hello", { signal: cancellation.signal });
      await advanceFakeClockUntilSettled(attempted, stepMs);
      const timersWhileWaiting = vi.getTimerCount();

      cancellation.abort();
      // The wait's timer is gone with the stop itself, before the clock moves at all.
      expect(vi.getTimerCount()).toBeLessThan(timersWhileWaiting);
      const cancelled = await advanceFakeClockUntilSettled(run, stepMs);

      expect(cancelled).toEqual(["run_failed"]);
      expect(f.attemptTimes).toHaveLength(1);
      // So no later attempt starts either.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.attemptTimes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits as long as the provider asks and fails when it asks for more than a minute", async () => {
    const f = await rateLimitFixture("provider-retry-after");
    const stepMs = 250;
    useFakeClockBesidePostgres();
    try {
      f.rateLimitedAnswers = 2;
      f.retryAfterMs = 30_000;
      const survived = await advanceFakeClockUntilSettled(f.runToEnd("hello"), stepMs);

      expect(survived).toEqual(["message_delta", "message_completed", "run_completed"]);
      const waits = waitsBetween(f.attemptTimes);
      expect(waits).toHaveLength(2);
      for (const wait of waits) {
        // The pause asked for, and not two of them.
        expect(wait).toBeGreaterThanOrEqual(30_000);
        expect(wait).toBeLessThan(60_000);
      }

      f.attemptTimes.length = 0;
      f.retryAfterMs = 60_001;
      const failed = await advanceFakeClockUntilSettled(f.runToEnd("hello again"), stepMs);

      expect(failed).toEqual(["run_failed"]);
      expect(f.lastFailure).toMatchObject({ code: "RATE_LIMITED" });
      expect(f.attemptTimes).toHaveLength(1);
      // The run failed without waiting: no pause is left that a second attempt could follow.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.attemptTimes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts no attempt and no wait that would pass the run's deadline", async () => {
    const f = await rateLimitFixture("provider-retry-deadline");
    const stepMs = 250;
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    useFakeClockBesidePostgres();
    try {
      // The first wait of 4 s fits before the deadline; the second of 8 s would end after it.
      // The deadline counts from the first attempt: the fake clock moves on while the run
      // reaches that attempt, and how far depends on the machine's load.
      f.rateLimitedAnswers = 3;
      const deadlineAfterFirstAttemptMs = 10_000;
      const deadline = new Date(Date.now() + 3_600_000);
      f.onAttempt = () => {
        if (f.attemptTimes.length === 1) {
          deadline.setTime(Date.now() + deadlineAfterFirstAttemptMs);
        }
      };
      const bounded = await advanceFakeClockUntilSettled(f.runToEnd("hello", { deadline }), stepMs);

      expect(bounded).toEqual(["run_failed"]);
      expect(f.lastFailure).toMatchObject({ code: "RATE_LIMITED" });
      // Exactly two attempts: the second after the 4 s wait and before the deadline.
      expect(f.attemptTimes).toHaveLength(2);
      const [firstWait] = waitsBetween(f.attemptTimes);
      expect(firstWait).toBeGreaterThanOrEqual(4_000);
      expect(firstWait).toBeLessThan(deadlineAfterFirstAttemptMs);
      // The 8 s wait was never started: no third attempt follows, however long the clock runs.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(f.attemptTimes).toHaveLength(2);

      f.onAttempt = undefined;
      f.attemptTimes.length = 0;
      const expired = await advanceFakeClockUntilSettled(
        f.runToEnd("hello again", { deadline: new Date(Date.now() - 1) }),
        stepMs
      );

      expect(expired).toEqual(["run_failed"]);
      expect(f.attemptTimes).toHaveLength(0);
    } finally {
      vi.useRealTimers();
      random.mockRestore();
    }
  });
});

function waitsBetween(times: number[]): number[] {
  return times.slice(1).map((time, index) => time - (times[index] ?? 0));
}

/** A runtime whose provider answers 429 a set number of times, then completes. */
async function rateLimitFixture(name: string) {
  const clientInstanceId = asClientInstanceId(`${name}-client`);
  const context: RuntimeCallContext = {
    clientInstanceId,
    correlationId: `corr-${name}`,
    user: {
      id: "user-1",
      externalUserId: "user-1",
      displayLabel: "User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
  const store = (await createTestInstance()).stores;
  const providerConfig: ModelProviderConfig = {
    id: "test-provider",
    type: "deterministic",
    model: "test-model"
  };
  const fixture = {
    rateLimitedAnswers: 0,
    retryAfterMs: undefined as number | undefined,
    attemptTimes: [] as number[],
    onAttempt: undefined as (() => void) | undefined,
    lastFailure: undefined as unknown,
    async runToEnd(text: string, overrides: Partial<RuntimeCallContext> = {}): Promise<string[]> {
      const runContext = { ...context, ...overrides };
      const conversationId = await createConversationWithMessages(store, {
        clientInstanceId,
        messages: []
      });
      const run = await runtime.start(
        { agentName: "rate_limit_retry_agent", conversationId, message: { text } },
        runContext
      );
      const types: string[] = [];
      for await (const event of runtime.observe(run.runId, runContext)) {
        types.push(event.type);
        if (event.type === "run_failed") {
          fixture.lastFailure = event.error;
        }
      }
      return types;
    }
  };
  const modelProvider: FakeModelProvider = {
    id: "test-provider",
    async complete() {
      throw new Error("Expected the streaming provider path to be used");
    },
    async *stream(): AsyncIterable<ModelCompletionStreamEvent> {
      fixture.attemptTimes.push(Date.now());
      fixture.onAttempt?.();
      if (fixture.attemptTimes.length <= fixture.rateLimitedAnswers) {
        throw new ModelProviderError({
          kind: "rate_limit",
          message: "Model provider request failed",
          status: 429,
          retryAfterMs: fixture.retryAfterMs
        });
      }
      yield {
        type: "completed",
        completion: {
          text: "Answered after the rate limit.",
          toolCalls: [],
          usage: noReportedUsage()
        }
      };
    }
  };
  const runtime = new LocalAgentRuntime(
    withTestModelGateway({
      assetSource: createStaticConfigAssetSource({
        agents: [
          {
            skillNames: [],
            name: "rate_limit_retry_agent",
            displayName: "Rate Limit Retry Agent",
            instructions: "Help the user.",
            modelProviderId: "test-provider",
            toolNames: [],
            initialPrompts: []
          }
        ]
      }),
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store.conversations,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      runTool: createUnusedToolRunner(),
      usageGovernance: new ModelUsageGovernance({ store: store.usage, budget: {}, safeguards: {} })
    })
  );
  return fixture;
}
