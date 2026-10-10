import { createTestInstance, getTestExecution } from "./support/test-instance";
import { describe, expect, it } from "vitest";
import { parseClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  MODEL_CALL_RESERVED_OUTPUT_TOKENS,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  type UsageRateCardConfig
} from "@vivd-catalyst/core";

import { ModelUsageGovernance, calculateUsageCost } from "@vivd-catalyst/usage-governance";

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
      outputPricePerMillionTokens: 30,
      fast: {
        uncachedInputPricePerMillionTokens: 10,
        cachedInputPricePerMillionTokens: 1,
        outputPricePerMillionTokens: 60
      }
    },
    {
      providerId: "azure-eu",
      model: "gpt-5.6-luna",
      uncachedInputPricePerMillionTokens: 1,
      cachedInputPricePerMillionTokens: 0.1,
      outputPricePerMillionTokens: 6
    }
  ],
  webSearch: [{ providerId: "azure-eu", pricePerCall: 1 }]
};

describe("model usage governance", () => {
  it("prices cached and uncached input separately in EUR", async () => {
    const { governance, clientInstanceId } = await createGovernance();

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
        outputPricePerMillionTokens: 30,
        webSearchPricePerCall: 1
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

  it("settles a fast call with the fast rates and a normal call with the normal rates", async () => {
    const { governance, clientInstanceId } = await createGovernance();
    const tokens = {
      inputTokens: 1_000_000,
      cachedInputTokens: 800_000,
      outputTokens: 100_000,
      totalTokens: 1_100_000
    };

    const normal = await governance.recordModelUsage(usageInput(clientInstanceId, tokens));
    const fast = await governance.recordModelUsage(
      usageInput(clientInstanceId, { ...tokens, fastMode: true, providerServiceTier: "priority" })
    );

    expect(normal).toMatchObject({ fastMode: false });
    expect(normal).not.toHaveProperty("providerServiceTier");
    expect(normal.customerBillableCost).toMatchObject({
      status: "settled",
      totalCostMicros: 4_400_000
    });
    expect(fast).toMatchObject({ fastMode: true, providerServiceTier: "priority" });
    expect(fast.customerBillableCost).toMatchObject({
      status: "settled",
      appliedRates: {
        uncachedInputPricePerMillionTokens: 10,
        cachedInputPricePerMillionTokens: 1,
        outputPricePerMillionTokens: 60
      },
      components: {
        uncachedInputCostMicros: 2_000_000,
        cachedInputCostMicros: 800_000,
        outputCostMicros: 6_000_000,
        webSearchCostMicros: 0
      },
      totalCostMicros: 8_800_000
    });

    const summary = await governance.createSafeSummary({ clientInstanceId });
    expect(summary.recentEvents.map((event) => event.billedAsFast).sort()).toEqual([false, true]);
  });

  it("settles a fast request by the tier the provider reports", async () => {
    const { governance, clientInstanceId } = await createGovernance();
    const record = (providerServiceTier?: string) =>
      governance.recordModelUsage(
        usageInput(clientInstanceId, {
          inputTokens: 1_000_000,
          cachedInputTokens: 800_000,
          outputTokens: 100_000,
          totalTokens: 1_100_000,
          fastMode: true,
          ...(providerServiceTier === undefined ? {} : { providerServiceTier })
        })
      );

    // Downgraded by the provider: normal rates, but both tiers stay on record.
    const downgraded = await record("default");
    expect(downgraded).toMatchObject({ fastMode: true, providerServiceTier: "default" });
    expect(downgraded.customerBillableCost).toMatchObject({
      status: "settled",
      appliedRates: { outputPricePerMillionTokens: 30 },
      totalCostMicros: 4_400_000
    });
    // No reported tier: the requested tier wins.
    expect((await record()).customerBillableCost).toMatchObject({ totalCostMicros: 8_800_000 });
    expect((await record("priority")).customerBillableCost).toMatchObject({
      totalCostMicros: 8_800_000
    });

    const summary = await governance.createSafeSummary({ clientInstanceId });
    expect(summary.recentEvents.filter((event) => event.billedAsFast)).toHaveLength(2);
  });

  it("never settles a fast call with the normal rates when fast rates are missing", async () => {
    const { governance, clientInstanceId } = await createGovernance();

    const event = await governance.recordModelUsage({
      ...usageInput(clientInstanceId, { fastMode: true }),
      model: "gpt-5.6-luna"
    });

    expect(event.customerBillableCost).toEqual({
      status: "unpriced",
      source: "rate_card",
      calculationVersion: 1,
      rateCardId: "customer",
      rateCardVersion: "2026-07",
      currency: "EUR",
      missingMeters: ["fast_model_rate"]
    });
  });

  it("does not silently treat missing cached-token detail as zero", async () => {
    const { governance, clientInstanceId } = await createGovernance();
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
    const { governance, store, clientInstanceId } = await createGovernance();
    await governance.recordModelUsage(
      usageInput(clientInstanceId, {
        inputTokens: 1_000,
        cachedInputTokens: 0,
        outputTokens: 500,
        totalTokens: 1_500
      })
    );

    const changedGovernance = new ModelUsageGovernance({
      store: store.usage,
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
    const { governance, clientInstanceId } = await createGovernance();
    await governance.recordModelUsage(usageInput(clientInstanceId, { cachedInputTokens: 0 }));

    const serialized = JSON.stringify(await governance.createSafeSummary({ clientInstanceId }));
    expect(serialized).not.toContain("customerBillableCost");
    expect(serialized).not.toContain("rateCardId");
    expect(serialized).not.toContain("appliedRates");
    expect(serialized).not.toContain("providerCost");
  });

  it("holds a cost that is not whole at the highest price against a spend budget", async () => {
    // The recorded call reports no cached tokens: its cost is not whole. It counts as 1,000
    // input tokens at 5 and 500 output tokens at 30 per million, which is 0.02. A call of 300
    // characters reserves 100 input and 16,000 output tokens, which is 0.4805.
    const { governance, clientInstanceId } = await createGovernance({
      dailySpendLimit: 0.02 + 0.4805
    });
    await governance.recordModelUsage(usageInput(clientInstanceId));

    await expect(governance.admitModelCall(admission(clientInstanceId))).resolves.toBeDefined();
    await expect(governance.admitModelCall(admission(clientInstanceId))).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Daily model spend budget has been reached"
    });
  });

  it("refuses a model without a price while a spend budget is set", async () => {
    const { governance, clientInstanceId } = await createGovernance({ dailySpendLimit: 50 });

    await expect(
      governance.admitModelCall({ ...admission(clientInstanceId), model: "gpt-unpriced" })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        "The model has no price on the rate card; the spend budget cannot be evaluated safely"
    });
  });

  // Fails without the change: config validation asked no price of a deterministic provider,
  // and admission then refused each of its calls under the spend budget.
  it("admits a call to a provider that bills nothing under a spend budget, as config validation allows it", async () => {
    const config = parseClientInstanceConfig({
      clientInstance: { id: "client-usage-free", displayName: "Free provider" },
      infrastructure: { models: { local: { provider: "deterministic" } } },
      modelBindings: [{ id: "judge", providerId: "local", agentSelectable: false }],
      usage: {
        budget: { dailySpendLimit: 10 },
        costs: { customer: { id: "rates", version: "1", currency: "EUR", models: [] } }
      }
    });
    const instance = await createTestInstance({ execution: { config, tools: [], env: {} } });
    const { modelGateway } = getTestExecution(instance);
    const clientInstanceId = asClientInstanceId("client-usage-free");

    await expect(
      modelGateway.complete({
        binding: { bindingId: "judge" },
        messages: [{ role: "user", content: "hello" }],
        tools: [],
        attribution: { kind: "system", purpose: "guardrail_judge" },
        clientInstanceId,
        correlationId: "corr_usage_free"
      })
    ).resolves.toMatchObject({ toolCalls: [] });
    const [event] = await instance.stores.usage.listModelUsageEvents({ clientInstanceId });
    expect(event).toMatchObject({ providerId: "local", status: "settled" });
  });

  // Fails without the change: the instance started and refused every call, because one call
  // reserves more tokens than the limit holds.
  it.each(["tokensPerDay", "tokensPerMonth"])(
    "refuses a %s at or below what one call reserves, and names both numbers",
    (key) => {
      const withLimit = (limit: number) => ({
        clientInstance: { id: "client-usage-limit", displayName: "Token limit" },
        infrastructure: { models: { local: { provider: "deterministic" } } },
        usage: { safeguards: { [key]: limit } }
      });

      expect(() => parseClientInstanceConfig(withLimit(10_000))).toThrow(
        `usage.safeguards.${key} is 10000, but one model call reserves 16000 tokens for its answer and the size of its request on top, so no call would be admitted. Set it above 16000 or leave it out`
      );
      expect(() => parseClientInstanceConfig(withLimit(MODEL_CALL_RESERVED_OUTPUT_TOKENS))).toThrow(
        "so no call would be admitted"
      );
      expect(
        parseClientInstanceConfig(withLimit(MODEL_CALL_RESERVED_OUTPUT_TOKENS + 1)).usage.safeguards
      ).toMatchObject({ [key]: 16_001 });
    }
  );

  it("uses the private safety multiplier for budgets without changing billable costs", async () => {
    const { governance, clientInstanceId } = await createGovernance({
      dailySpendLimit: 5,
      costSafetyMultiplier: 1.3
    });
    await governance.recordModelUsage(
      usageInput(clientInstanceId, {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 100_000,
        totalTokens: 100_000,
        webSearchCallCount: 1
      })
    );

    const summary = await governance.createSafeSummary({ clientInstanceId });
    expect(summary.today.cost.billableCostMicros).toBe(4_000_000);
    expect(summary).not.toHaveProperty("costSafetyMultiplier");
    await expect(governance.admitModelCall(admission(clientInstanceId))).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Daily model spend budget has been reached"
    });
  });

  it("admits one of two calls that ask at once for the last place of a daily limit", async () => {
    const { governance, clientInstanceId } = await createGovernance({}, { modelCallsPerDay: 1 });

    const attempts = await Promise.allSettled([
      governance.admitModelCall(admission(clientInstanceId)),
      governance.admitModelCall(admission(clientInstanceId))
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
  });

  it("counts an admitted call once from its admission, settled or not", async () => {
    const { governance, clientInstanceId, store } = await createGovernance(
      {},
      { modelCallsPerDay: 2 }
    );
    const refusal = {
      code: "FORBIDDEN",
      message: "Daily model call safeguard has been reached"
    };

    const settled = await governance.admitModelCall(admission(clientInstanceId));
    // Never settled, as after a call that failed or a process that died.
    await governance.admitModelCall(admission(clientInstanceId));
    await expect(governance.admitModelCall(admission(clientInstanceId))).rejects.toMatchObject(
      refusal
    );

    await governance.settleModelCall(settled, {
      inputTokens: 1_000,
      cachedInputTokens: 0,
      outputTokens: 500,
      totalTokens: 1_500,
      source: "provider_reported"
    });
    await expect(governance.admitModelCall(admission(clientInstanceId))).rejects.toMatchObject(
      refusal
    );

    const events = await store.usage.listModelUsageEvents({ clientInstanceId });
    expect(events.map((event) => [event.totalTokens, event.source]).sort()).toEqual([
      [0, "not_reported"],
      [1_500, "provider_reported"]
    ]);
    expect(events.find((event) => event.id === settled.id)?.customerBillableCost).toMatchObject({
      status: "settled",
      totalCostMicros: 20_000
    });
  });
});

async function createGovernance(
  budget: {
    dailySpendLimit?: number;
    monthlySpendLimit?: number;
    costSafetyMultiplier?: number;
  } = {},
  safeguards: {
    modelCallsPerDay?: number;
    tokensPerDay?: number;
    tokensPerMonth?: number;
  } = {}
) {
  const clientInstanceId = asClientInstanceId("client-usage-test");
  const store = (await createTestInstance()).stores;
  return {
    clientInstanceId,
    store,
    governance: new ModelUsageGovernance({
      store: store.usage,
      budget,
      safeguards,
      costs: { customer: customerRateCard }
    })
  };
}

const usageAttribution = {
  kind: "agent_run" as const,
  conversationId: asConversationId("conv_usage"),
  runId: asAgentRunId("run_usage"),
  agentName: "agent",
  userId: "user_usage"
};

function admission(clientInstanceId: ReturnType<typeof asClientInstanceId>) {
  return {
    clientInstanceId,
    attribution: usageAttribution,
    providerId: "azure-eu",
    model: "gpt-5.6-sol",
    correlationId: "corr_usage",
    request: { inputCharacters: 300 }
  };
}

function usageInput(
  clientInstanceId: ReturnType<typeof asClientInstanceId>,
  overrides: Partial<{
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    totalTokens: number;
    webSearchCallCount: number;
    fastMode: boolean;
    providerServiceTier: string;
  }> = {}
) {
  return {
    clientInstanceId,
    attribution: usageAttribution,
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
