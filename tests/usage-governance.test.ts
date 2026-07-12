import { describe, expect, it, vi } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";

describe("model usage governance", () => {
  it("reserves model calls so daily call limits cannot be raced in one process", async () => {
    const clientInstanceId = asClientInstanceId("client-usage-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        costSafetyMultiplier: 1
      },
      safeguards: {
        modelCallsPerDay: 1
      }
    });

    const attempts = await Promise.allSettled([
      governance.runModelCall(clientInstanceId, async () => {
        await governance.appendModelUsageEvent({
          clientInstanceId,
          conversationId: asConversationId("conv_1"),
          agentRunId: asAgentRunId("run_1"),
          agentName: "agent",
          providerId: "provider",
          model: "model",
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          source: "provider_reported",
          correlationId: "corr_1"
        });
        return "first";
      }),
      governance.runModelCall(clientInstanceId, async () => {
        await governance.appendModelUsageEvent({
          clientInstanceId,
          conversationId: asConversationId("conv_2"),
          agentRunId: asAgentRunId("run_2"),
          agentName: "agent",
          providerId: "provider",
          model: "model",
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
          source: "provider_reported",
          correlationId: "corr_2"
        });
        return "second";
      })
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    await expect(
      governance.runModelCall(clientInstanceId, async () => "third")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Daily model call safeguard has been reached"
    });
    await expect(governance.createSummary({ clientInstanceId })).resolves.toMatchObject({
      today: {
        modelCallCount: 1,
        totalTokens: 2
      }
    });
  });

  it("does not hold the accounting lock across provider latency", async () => {
    const clientInstanceId = asClientInstanceId("client-overlap-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        costSafetyMultiplier: 1
      },
      safeguards: {}
    });
    let activeCalls = 0;
    let maxActiveCalls = 0;

    await Promise.all([
      governance.runModelCall(clientInstanceId, async () => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await delay(30);
        activeCalls -= 1;
        return "first";
      }),
      governance.runModelCall(clientInstanceId, async () => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await delay(30);
        activeCalls -= 1;
        return "second";
      })
    ]);

    expect(maxActiveCalls).toBe(2);
  });

  it("releases in-flight reservations when a provider call fails", async () => {
    const clientInstanceId = asClientInstanceId("client-failure-release-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        costSafetyMultiplier: 1
      },
      safeguards: {
        modelCallsPerDay: 1
      }
    });

    await expect(
      governance.runModelCall(clientInstanceId, async () => {
        throw new Error("provider failed");
      })
    ).rejects.toThrow("provider failed");

    await expect(governance.runModelCall(clientInstanceId, async () => "next")).resolves.toBe("next");
  });

  it("derives model costs from configured provider and model pricing", async () => {
    const clientInstanceId = asClientInstanceId("client-cost-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        costSafetyMultiplier: 1
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_cost"),
      agentRunId: asAgentRunId("run_cost"),
      agentName: "agent",
      providerId: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      source: "provider_reported",
      correlationId: "corr_cost"
    });

    const summary = await governance.createSummary({ clientInstanceId });

    expect(summary.today.cost).toMatchObject({
      currency: "USD",
      inputCostMicros: 2000,
      outputCostMicros: 4000,
      totalCostMicros: 6000,
      budgetedCostMicros: 6000,
      costSafetyMultiplier: 1,
      pricingConfigured: true,
      pricedModelCallCount: 1,
      unpricedModelCallCount: 0
    });
    expect(summary.recentEvents[0]?.cost).toMatchObject({
      totalCostMicros: 6000,
      budgetedCostMicros: 6000,
      pricingConfigured: true
    });
  });

  it("adds configured provider-native web search cost to model usage summaries", async () => {
    const clientInstanceId = asClientInstanceId("client-web-search-cost-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        costSafetyMultiplier: 1
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ],
        webSearch: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            pricePerCall: 0.01
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_web_search_cost"),
      agentRunId: asAgentRunId("run_web_search_cost"),
      agentName: "agent",
      providerId: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      webSearchCallCount: 2,
      source: "provider_reported",
      correlationId: "corr_web_search_cost"
    });

    const summary = await governance.createSummary({ clientInstanceId });

    expect(summary.today).toMatchObject({
      webSearchCallCount: 2,
      cost: {
        inputCostMicros: 2000,
        outputCostMicros: 4000,
        webSearchCostMicros: 20000,
        totalCostMicros: 26000,
        pricedWebSearchCallCount: 2,
        unpricedWebSearchCallCount: 0,
        webSearchPricingConfigured: true
      }
    });
    expect(summary.recentEvents[0]).toMatchObject({
      webSearchCallCount: 2,
      cost: {
        webSearchCostMicros: 20000,
        totalCostMicros: 26000,
        pricingConfigured: true,
        modelPricingConfigured: true,
        webSearchPricingConfigured: true
      }
    });
  });

  it("reports unpriced web search calls without hiding configured token cost", async () => {
    const clientInstanceId = asClientInstanceId("client-unpriced-web-search-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        costSafetyMultiplier: 1
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_unpriced_web_search"),
      agentRunId: asAgentRunId("run_unpriced_web_search"),
      agentName: "agent",
      providerId: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      webSearchCallCount: 3,
      source: "provider_reported",
      correlationId: "corr_unpriced_web_search"
    });

    const summary = await governance.createSummary({ clientInstanceId });

    expect(summary.today.cost).toMatchObject({
      inputCostMicros: 2000,
      outputCostMicros: 4000,
      webSearchCostMicros: 0,
      totalCostMicros: 6000,
      pricingConfigured: true,
      webSearchPricingConfigured: false,
      pricedWebSearchCallCount: 0,
      unpricedWebSearchCallCount: 3
    });
  });

  it("applies the configured safety multiplier to budgeted cost", async () => {
    const clientInstanceId = asClientInstanceId("client-budgeted-cost-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        dailySpendLimit: 50,
        monthlySpendLimit: 200,
        costSafetyMultiplier: 1.5
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_budgeted_cost"),
      agentRunId: asAgentRunId("run_budgeted_cost"),
      agentName: "agent",
      providerId: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 1000,
      totalTokens: 2000,
      source: "provider_reported",
      correlationId: "corr_budgeted_cost"
    });

    const summary = await governance.createSummary({ clientInstanceId });

    expect(summary.today.cost).toMatchObject({
      totalCostMicros: 10000,
      budgetedCostMicros: 15000,
      costSafetyMultiplier: 1.5
    });
  });

  it("creates an admin usage summary without internal cost policy", async () => {
    const clientInstanceId = asClientInstanceId("client-admin-usage-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        dailySpendLimit: 50,
        monthlySpendLimit: 200,
        costSafetyMultiplier: 1.5
      },
      safeguards: {
        tokensPerMonth: 1000000
      },
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_admin_usage"),
      agentRunId: asAgentRunId("run_admin_usage"),
      agentName: "agent",
      providerId: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 1000,
      totalTokens: 2000,
      source: "provider_reported",
      correlationId: "corr_admin_usage"
    });

    const summary = await governance.createSafeSummary({ clientInstanceId });

    expect(summary).toMatchObject({
      spendBudget: {
        currency: "USD",
        dailyLimitMicros: 50000000,
        monthlyLimitMicros: 200000000
      },
      safeguards: {
        tokensPerMonth: 1000000
      },
      today: {
        modelCallCount: 1,
        totalTokens: 2000,
        cost: {
          currency: "USD",
          modelBilledCostMicros: 15000,
          billedCostMicros: 15000,
          webSearchCostVisible: false,
          pricingConfigured: true
        }
      },
      recentEvents: [
        expect.objectContaining({
          providerId: "openai",
          model: "gpt-4.1",
          totalTokens: 2000,
          cost: expect.objectContaining({
            currency: "USD",
            modelBilledCostMicros: 15000,
            billedCostMicros: 15000,
            webSearchCostVisible: false
          })
        })
      ]
    });
    expect(summary.today.cost).not.toHaveProperty("webSearchBilledCostMicros");
    expect(JSON.stringify(summary)).not.toContain("dailySpendLimit");
    expect(JSON.stringify(summary)).not.toContain("monthlySpendLimit");
    expect(JSON.stringify(summary)).not.toContain("costSafetyMultiplier");
    expect(JSON.stringify(summary)).not.toContain("inputPricePerMillionTokens");
    expect(JSON.stringify(summary)).not.toContain("totalCostMicros");
    expect(JSON.stringify(summary)).not.toContain("budgetedCostMicros");
  });

  it("summarizes safe daily and monthly usage buckets", async () => {
    const clientInstanceId = asClientInstanceId("client-usage-buckets-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        costSafetyMultiplier: 1.5
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ]
      }
    });

    const appendEventAt = async (isoTime: string, suffix: string) => {
      vi.setSystemTime(new Date(isoTime));
      await governance.appendModelUsageEvent({
        clientInstanceId,
        conversationId: asConversationId(`conv_${suffix}`),
        agentRunId: asAgentRunId(`run_${suffix}`),
        agentName: "agent",
        providerId: "openai",
        model: "gpt-4.1",
        inputTokens: 1000,
        outputTokens: 1000,
        totalTokens: 2000,
        source: "provider_reported",
        correlationId: `corr_${suffix}`
      });
    };

    vi.useFakeTimers();
    try {
      await appendEventAt("2026-05-20T10:00:00.000Z", "may");
      await appendEventAt("2026-07-01T00:30:00.000Z", "july_first");
      await appendEventAt("2026-07-02T08:00:00.000Z", "july_second_a");
      await appendEventAt("2026-07-02T09:00:00.000Z", "july_second_b");
    } finally {
      vi.useRealTimers();
    }

    const summary = await governance.createSafeSummary({
      clientInstanceId,
      now: new Date("2026-07-02T12:00:00.000Z")
    });

    // Each event bills ceil((1000 * 2 + 1000 * 8) * 1.5) = 15000 micros.
    expect(summary.dailyUsage).toHaveLength(30);
    expect(summary.dailyUsage[0]?.date).toBe("2026-06-03");
    expect(summary.dailyUsage.at(-1)).toMatchObject({
      date: "2026-07-02",
      modelCallCount: 2,
      totalTokens: 4000,
      cost: { billedCostMicros: 30000 }
    });
    expect(summary.dailyUsage.at(-2)).toMatchObject({
      date: "2026-07-01",
      modelCallCount: 1,
      cost: { billedCostMicros: 15000 }
    });
    expect(summary.dailyUsage.reduce((total, day) => total + day.modelCallCount, 0)).toBe(3);

    expect(summary.monthlyUsage.map((month) => month.month)).toEqual([
      "2026-05",
      "2026-06",
      "2026-07"
    ]);
    expect(summary.monthlyUsage[0]).toMatchObject({
      month: "2026-05",
      modelCallCount: 1,
      cost: { billedCostMicros: 15000 }
    });
    expect(summary.monthlyUsage[1]).toMatchObject({
      month: "2026-06",
      modelCallCount: 0,
      cost: { billedCostMicros: 0 }
    });
    expect(summary.monthlyUsage[2]).toMatchObject({
      month: "2026-07",
      modelCallCount: 3,
      totalTokens: 6000,
      cost: { billedCostMicros: 45000 }
    });

    expect(JSON.stringify(summary)).not.toContain("costSafetyMultiplier");
    expect(JSON.stringify(summary)).not.toContain("budgetedCostMicros");
  });

  it("shows web search billed cost only when web search accounting is enabled", async () => {
    const clientInstanceId = asClientInstanceId("client-admin-web-search-usage-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        monthlySpendLimit: 200,
        costSafetyMultiplier: 1.5
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ],
        webSearch: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            pricePerCall: 0.01
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_admin_web_search_usage"),
      agentRunId: asAgentRunId("run_admin_web_search_usage"),
      agentName: "agent",
      providerId: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 1000,
      totalTokens: 2000,
      webSearchCallCount: 2,
      source: "provider_reported",
      correlationId: "corr_admin_web_search_usage"
    });

    const visibleSummary = await governance.createSafeSummary({
      clientInstanceId,
      webSearchEnabled: true
    });
    expect(visibleSummary.today.cost).toMatchObject({
      currency: "USD",
      modelBilledCostMicros: 15000,
      webSearchBilledCostMicros: 30000,
      billedCostMicros: 45000,
      webSearchCostVisible: true
    });
    expect(visibleSummary.recentEvents[0]?.cost).toMatchObject({
      webSearchBilledCostMicros: 30000,
      billedCostMicros: 45000,
      webSearchCostVisible: true
    });

    const hiddenSummary = await governance.createSafeSummary({
      clientInstanceId,
      webSearchEnabled: false
    });
    expect(hiddenSummary.today.cost).toMatchObject({
      billedCostMicros: 45000,
      webSearchCostVisible: false
    });
    expect(hiddenSummary.today.cost).not.toHaveProperty("webSearchBilledCostMicros");
    expect(JSON.stringify(visibleSummary)).not.toContain("costSafetyMultiplier");
    expect(JSON.stringify(visibleSummary)).not.toContain("inputPricePerMillionTokens");
    expect(JSON.stringify(visibleSummary)).not.toContain("pricePerCall");
    expect(JSON.stringify(visibleSummary)).not.toContain("totalCostMicros");
  });

  it("blocks new model calls after the monthly spend budget is reached", async () => {
    const clientInstanceId = asClientInstanceId("client-spend-limit-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        monthlySpendLimit: 0.01,
        costSafetyMultiplier: 1
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_spend_limit"),
      agentRunId: asAgentRunId("run_spend_limit"),
      agentName: "agent",
      providerId: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 1000,
      totalTokens: 2000,
      source: "provider_reported",
      correlationId: "corr_spend_limit"
    });

    await expect(governance.runModelCall(clientInstanceId, async () => "blocked")).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Monthly model spend limit has been reached"
    });
  });

  it("blocks new model calls after the daily spend budget is reached", async () => {
    const clientInstanceId = asClientInstanceId("client-daily-spend-limit-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        dailySpendLimit: 0.01,
        monthlySpendLimit: 1,
        costSafetyMultiplier: 1
      },
      safeguards: {},
      pricing: {
        currency: "EUR",
        models: [
          {
            providerId: "openai",
            model: "gpt-4.1",
            inputPricePerMillionTokens: 2,
            outputPricePerMillionTokens: 8
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_daily_spend_limit"),
      agentRunId: asAgentRunId("run_daily_spend_limit"),
      agentName: "agent",
      providerId: "openai",
      model: "gpt-4.1",
      inputTokens: 1000,
      outputTokens: 1000,
      totalTokens: 2000,
      source: "provider_reported",
      correlationId: "corr_daily_spend_limit"
    });

    await expect(
      governance.runModelCall(clientInstanceId, async () => "blocked")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Daily model spend limit has been reached"
    });
  });

  it("does not block new model calls only because older monthly usage has no matching price", async () => {
    const clientInstanceId = asClientInstanceId("client-stale-unpriced-usage-test");
    const store = new InMemoryPlatformStore();
    const governance = new ModelUsageGovernance({
      store,
      budget: {
        monthlySpendLimit: 200,
        costSafetyMultiplier: 1
      },
      safeguards: {},
      pricing: {
        currency: "USD",
        models: [
          {
            providerId: "openai",
            model: "gpt-5.5",
            inputPricePerMillionTokens: 5,
            outputPricePerMillionTokens: 30
          }
        ]
      }
    });

    await governance.appendModelUsageEvent({
      clientInstanceId,
      conversationId: asConversationId("conv_stale_unpriced"),
      agentRunId: asAgentRunId("run_stale_unpriced"),
      agentName: "agent",
      providerId: "openai",
      model: "old-demo-model",
      inputTokens: 1000,
      outputTokens: 1000,
      totalTokens: 2000,
      source: "provider_reported",
      correlationId: "corr_stale_unpriced"
    });

    await expect(governance.runModelCall(clientInstanceId, async () => "allowed")).resolves.toBe(
      "allowed"
    );
    await expect(governance.createSummary({ clientInstanceId })).resolves.toMatchObject({
      currentMonth: {
        cost: {
          pricingConfigured: true,
          pricedModelCallCount: 0,
          unpricedModelCallCount: 1
        }
      }
    });
  });

});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
