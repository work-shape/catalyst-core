import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@vivd-catalyst/api-client";
import { UsageView } from "../packages/chat-ui/src/control-plane/usage-view";
import { TranslationProvider } from "@vivd-catalyst/chat-ui";

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

  it("labels amounts as billable and renders incomplete cost explicitly", () => {
    const usage = createUsageSummary();
    usage.today.cost = {
      status: "incomplete",
      currency: "EUR",
      complete: false,
      webSearchCostVisible: false,
      settledModelCallCount: 0,
      incompleteModelCallCount: 1,
      settledWebSearchCallCount: 0,
      incompleteWebSearchCallCount: 0
    };

    const markup = renderToStaticMarkup(createElement(UsageView, { usage }));

    expect(markup).toContain("Billable today");
    expect(markup).toContain("Incomplete");
    expect(markup).not.toContain("Billed");
  });

  // Fails without the change: a call in flight and a call that ended without an answer both
  // showed as a call of zero tokens with the source "estimated".
  it("says in words that a call is running and that a call reported no usage", () => {
    const usage = createUsageSummary();
    usage.recentEvents = [
      createEvent("usage_running", "pending"),
      createEvent("usage_failed", "failed"),
      createEvent("usage_lost", "abandoned")
    ];

    const english = renderToStaticMarkup(createElement(UsageView, { usage }));
    const german = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "de",
        children: createElement(UsageView, { usage })
      })
    );

    expect(english.split(">Running<")).toHaveLength(2);
    expect(english.split(">No usage reported<")).toHaveLength(3);
    expect(english).toContain("Provider and region");
    expect(english).not.toContain("not_reported");
    expect(german.split(">Läuft<")).toHaveLength(2);
    expect(german.split(">Keine Nutzung gemeldet<")).toHaveLength(3);
    expect(german).toContain("Anbieter und Region");
  });
});

function createEvent(
  id: string,
  status: UsageSummary["recentEvents"][number]["status"]
): UsageSummary["recentEvents"][number] {
  return {
    id,
    status,
    clientInstanceId: "client",
    agentName: "agent",
    providerId: "azure-eu",
    model: "gpt-main",
    region: "eu",
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    webSearchCallCount: 0,
    billedAsFast: false,
    source: "not_reported",
    correlationId: "corr",
    createdAt: "2026-07-12T11:00:00.000Z",
    cost: { status: "settled", currency: "EUR", complete: true, webSearchCostVisible: false }
  };
}

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

/** The view renders in English here, so amounts are written the English way. */
function formatEuro(amount: number): string {
  return new Intl.NumberFormat("en", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function createWindowSummary(billableCostMicros: number): UsageSummary["today"] {
  return {
    modelCallCount: 1,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    webSearchCallCount: 0,
    cost: {
      status: "settled",
      currency: "EUR",
      uncachedInputBillableCostMicros: billableCostMicros,
      cachedInputBillableCostMicros: 0,
      outputBillableCostMicros: 0,
      billableCostMicros,
      complete: true,
      webSearchCostVisible: false,
      settledModelCallCount: 0,
      incompleteModelCallCount: 0,
      settledWebSearchCallCount: 0,
      incompleteWebSearchCallCount: 0
    }
  };
}
