import { createElement } from "../packages/chat-ui/node_modules/react";
import { renderToStaticMarkup } from "../packages/chat-ui/node_modules/react-dom/server";
import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@vivd-catalyst/api-client";
import { UsageView } from "../packages/chat-ui/src/usage-view";

describe("usage spend budget progress", () => {
  it("shows daily and monthly progress against currency-denominated limits", () => {
    const markup = renderToStaticMarkup(createElement(UsageView, { usage: createUsageSummary() }));

    expect(markup).toContain("Spend budgets");
    expect(markup).toContain("Daily budget");
    expect(markup).toContain("Monthly budget");
    expect(markup).toContain("20% used");
    expect(markup).toContain("25% used");
    expect(markup).toContain('aria-label="Daily budget used"');
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup).toContain('aria-label="Monthly budget used"');
    expect(markup).toContain('aria-valuenow="25"');
    expect(markup).toContain(formatEuro(40));
    expect(markup).toContain(formatEuro(300));
  });
});

function createUsageSummary(): UsageSummary {
  return {
    generatedAt: "2026-07-12T12:00:00.000Z",
    spendBudget: {
      currency: "EUR",
      dailyLimitMicros: 50_000_000,
      monthlyLimitMicros: 400_000_000
    },
    safeguards: {
      modelCallsPerDay: 1000
    },
    today: createWindowSummary(10_000_000),
    currentMonth: createWindowSummary(100_000_000),
    allTime: createWindowSummary(100_000_000),
    dailyUsage: [],
    monthlyUsage: [],
    recentEvents: []
  };
}

function formatEuro(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function createWindowSummary(billedCostMicros: number): UsageSummary["today"] {
  return {
    modelCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    webSearchCallCount: 0,
    cost: {
      currency: "EUR",
      modelBilledCostMicros: billedCostMicros,
      billedCostMicros,
      webSearchCostVisible: false,
      pricingConfigured: true,
      modelPricingConfigured: true,
      webSearchPricingConfigured: true,
      pricedModelCallCount: 0,
      unpricedModelCallCount: 0,
      pricedWebSearchCallCount: 0,
      unpricedWebSearchCallCount: 0
    }
  };
}
