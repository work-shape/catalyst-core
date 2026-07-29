import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type UsageRateCardConfig
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import {
  ModelUsageGovernance,
  calculateUsageCost
} from "@vivd-catalyst/usage-governance";

const customerRateCard: UsageRateCardConfig = {
  id: "customer",
  version: "2026-07",
  currency: "EUR",
  models: [
    {
      providerId: "azure-eu",
      model: "gpt-5.6-sol",
      uncachedInputPricePerMillionTokens: 5,
      cachedInputPricePerMillionTokens: 0.5,
      outputPricePerMillionTokens: 30
    }
  ],
  webSearch: []
};

describe("model usage governance", () => {
  it("prices cached and uncached input separately in EUR", async () => {
    const { governance, clientInstanceId } = createGovernance();

    const event = await governance.recordModelUsage(
      usageInput(clientInstanceId, {
        inputTokens: 1_000_000,
        cachedInputTokens: 800_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000
      })
    );

    expect(event.customerBillableCost).toEqual({
      status: "settled",
      source: "rate_card",
      calculationVersion: 1,
      rateCardId: "customer",
      rateCardVersion: "2026-07",
      currency: "EUR",
      appliedRates: {
        uncachedInputPricePerMillionTokens: 5,
        cachedInputPricePerMillionTokens: 0.5,
        outputPricePerMillionTokens: 30
      },
      components: {
        uncachedInputCostMicros: 1_000_000,
        cachedInputCostMicros: 400_000,
        outputCostMicros: 3_000_000,
        webSearchCostMicros: 0
      },
      totalCostMicros: 4_400_000
    });

    const summary = await governance.createSafeSummary({ clientInstanceId });
    expect(summary.currentMonth).toMatchObject({
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      cost: {
        currency: "EUR",
        complete: true,
        uncachedInputBillableCostMicros: 1_000_000,
        cachedInputBillableCostMicros: 400_000,
        outputBillableCostMicros: 3_000_000,
        billableCostMicros: 4_400_000
      }
    });
  });

  it("does not silently treat missing cached-token detail as zero", async () => {
    const { governance, clientInstanceId } = createGovernance();
    const event = await governance.recordModelUsage(usageInput(clientInstanceId));

    expect(event.customerBillableCost).toMatchObject({
      status: "incomplete",
      missingMeters: ["cached_input_tokens"]
    });
    expect(event.customerBillableCost).not.toHaveProperty("totalCostMicros");

    const summary = await governance.createSafeSummary({ clientInstanceId });
    expect(summary.currentMonth.cost).toMatchObject({
      status: "incomplete",
      complete: false,
      incompleteModelCallCount: 1
    });
    expect(summary.currentMonth.cost).not.toHaveProperty("billableCostMicros");
  });

  it("marks missing customer pricing as unpriced instead of zero", () => {
    const clientInstanceId = asClientInstanceId("client-unpriced");
    const cost = calculateUsageCost(
      usageInput(clientInstanceId, { cachedInputTokens: 0 }),
      undefined
    );

    expect(cost).toEqual({
      status: "unpriced",
      source: "rate_card",
      calculationVersion: 1,
      missingMeters: ["model_rate"]
    });
    expect(cost).not.toHaveProperty("totalCostMicros");
  });

  it("keeps historical billable amounts stable when the active rate card changes", async () => {
    const { governance, store, clientInstanceId } = createGovernance();
    await governance.recordModelUsage(
      usageInput(clientInstanceId, {
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 500,
        totalTokens: 1_500
      })
    );

    const changedGovernance = new ModelUsageGovernance({
      store,
      budget: {},
      safeguards: {},
      costs: {
        customer: {
          ...customerRateCard,
          version: "2026-08",
          models: [
            {
              ...customerRateCard.models[0]!,
              uncachedInputPricePerMillionTokens: 500,
              outputPricePerMillionTokens: 3_000
            }
          ]
        }
      }
    });

    const summary = await changedGovernance.createSafeSummary({ clientInstanceId });
    expect(summary.allTime.cost.billableCostMicros).toBe(20_000);
    expect(summary.recentEvents[0]?.cost.billableCostMicros).toBe(20_000);
  });

  it("does not expose persisted rate-card provenance through the customer summary", async () => {
    const { governance, clientInstanceId } = createGovernance();
    await governance.recordModelUsage(
      usageInput(clientInstanceId, { cachedInputTokens: 0 })
    );

    const serialized = JSON.stringify(
      await governance.createSafeSummary({ clientInstanceId })
    );
    expect(serialized).not.toContain("customerBillableCost");
    expect(serialized).not.toContain("rateCardId");
    expect(serialized).not.toContain("appliedRates");
    expect(serialized).not.toContain("providerCost");
  });

  it("fails closed when a spend budget contains incomplete costs", async () => {
    const { governance, clientInstanceId } = createGovernance({
      dailySpendLimit: 50
    });
    await governance.recordModelUsage(usageInput(clientInstanceId));

    await expect(
      governance.runModelCall(clientInstanceId, async () => "blocked")
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "Daily customer billable cost is incomplete; spend budget cannot be evaluated safely"
    });
  });

  it("reserves model calls so a daily call limit cannot be raced", async () => {
    const { governance, clientInstanceId } = createGovernance(
      {},
      { modelCallsPerDay: 1 }
    );

    const attempts = await Promise.allSettled([
      governance.runModelCall(clientInstanceId, async () => {
        await delay(20);
        return "first";
      }),
      governance.runModelCall(clientInstanceId, async () => "second")
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  it("does not hold the accounting lock across provider latency", async () => {
    const { governance, clientInstanceId } = createGovernance();
    let activeCalls = 0;
    let maxActiveCalls = 0;

    await Promise.all([
      governance.runModelCall(clientInstanceId, async () => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await delay(20);
        activeCalls -= 1;
      }),
      governance.runModelCall(clientInstanceId, async () => {
        activeCalls += 1;
        maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
        await delay(20);
        activeCalls -= 1;
      })
    ]);

    expect(maxActiveCalls).toBe(2);
  });
});

function createGovernance(
  budget: { dailySpendLimit?: number; monthlySpendLimit?: number } = {},
  safeguards: {
    modelCallsPerDay?: number;
    tokensPerDay?: number;
    tokensPerMonth?: number;
  } = {}
) {
  const clientInstanceId = asClientInstanceId("client-usage-test");
  const store = new InMemoryPlatformStore();
  return {
    clientInstanceId,
    store,
    governance: new ModelUsageGovernance({
      store,
      budget,
      safeguards,
      costs: { customer: customerRateCard }
    })
  };
}

function usageInput(
  clientInstanceId: ReturnType<typeof asClientInstanceId>,
  overrides: Partial<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
  }> = {}
) {
  return {
    clientInstanceId,
    conversationId: asConversationId("conv_usage"),
    agentRunId: asAgentRunId("run_usage"),
    agentName: "agent",
    providerId: "azure-eu",
    model: "gpt-5.6-sol",
    inputTokens: 1_000,
    outputTokens: 500,
    totalTokens: 1_500,
    source: "provider_reported" as const,
    correlationId: "corr_usage",
    ...overrides
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
