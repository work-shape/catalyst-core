// @vitest-environment happy-dom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@work-shape/catalyst-api-client";
import { UsageView } from "@work-shape/catalyst-chat-ui/control-plane";
import { TranslationProvider } from "@work-shape/catalyst-chat-ui";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import { required } from "./support/assertions";
import {
  mountPage,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser,
  waitForText
} from "./chat-ui-settings-fixtures";

/** Instance > Usage as the Settings area shows it, against an instance that answers `answer`. */
async function mountUsagePage(answer: Response, locale: "en" | "de", instanceAdminName?: string) {
  const page = required(administration.pages?.find((candidate) => candidate.id === "usage"));
  const respond: typeof fetch = async () => answer.clone();
  return mountPage(
    settingsPageContext(
      createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: respond }),
      settingsUser({ instanceAdminName })
    ),
    locale,
    createElement(page.component)
  );
}

describe("Usage opens with the month's single answer (UXA-5)", () => {
  /** The month's card, once the page has read the summary. */
  async function monthCard(mounted: { container: HTMLElement }, title: string) {
    await waitForText(mounted.container, title);
    const first = required(mounted.container.querySelector<HTMLElement>("[data-card]"));
    expect(first.getAttribute("data-testid")).toBe("usage-month-budget");
    return first;
  }
  const cost = (card: HTMLElement) =>
    required(card.querySelector('[data-testid="usage-month-cost"]')).textContent;

  // The budget stood in a tile beside a tokens tile, the tokens again in a tile below and in
  // the head, and the spend against the budget only in a card further down.
  it.each([
    { locale: "en" as const, said: "€100.00 of €400.00", tokens: "1,234,567", title: "This month" },
    {
      locale: "de" as const,
      // The German currency format puts a no-break space before the sign.
      said: "100,00\u00a0€ von 400,00\u00a0€",
      tokens: "1.234.567",
      title: "Dieser Monat"
    }
  ])(
    "says what the month cost of its budget, with the tokens second, once ($locale)",
    async ({ locale, said, tokens, title }) => {
      const usage = createUsageSummary();
      usage.currentMonth.totalTokens = 1_234_567;
      const mounted = await mountUsagePage(Response.json(usage), locale);
      try {
        const card = await monthCard(mounted, title);
        expect(cost(card)).toBe(said);
        expect(card.textContent).toContain(tokens);
        // Nowhere else on the page: no tokens tile, no figure in the head, no budget card.
        expect(mounted.container.textContent?.split(tokens)).toHaveLength(2);
        expect(mounted.container.querySelector("header p")).toBeNull();
        expect(mounted.container.querySelector('[data-testid="spend-budget-progress"]')).toBeNull();
      } finally {
        await mounted.unmount();
      }
    }
  );

  it("says the cost is not known yet while nothing is priced, also before anything was used", async () => {
    const usage = createUsageSummary();
    usage.spendBudget = { monthlyLimitMicros: 400_000_000 };
    usage.currentMonth.cost = { ...usage.currentMonth.cost, currency: undefined };
    delete usage.currentMonth.cost.billableCostMicros;
    usage.currentMonth.totalTokens = 4_321;
    usage.allTime.modelCallCount = 0;
    const mounted = await mountUsagePage(Response.json(usage), "en");
    try {
      await waitForText(mounted.container, "No usage recorded yet.");
      const card = await monthCard(mounted, "This month");
      expect(cost(card)).toBe("Cost not known yet");
      expect(card.textContent).toContain("4,321 tokens");
    } finally {
      await mounted.unmount();
    }
  });

  it.each([
    {
      locale: "en" as const,
      title: "This month",
      unknown: "Cost not known yet",
      limit: "€437.00"
    },
    {
      locale: "de" as const,
      title: "Dieser Monat",
      unknown: "Kosten noch nicht bekannt",
      limit: "437,00\u00a0€"
    }
  ])(
    "shows the configured monthly budget beside a cost not known yet ($locale)",
    async ({ locale, title, unknown, limit }) => {
      const usage = createUsageSummary();
      usage.spendBudget = { currency: "EUR", monthlyLimitMicros: 437_000_000 };
      usage.currentMonth.cost = { ...usage.currentMonth.cost, currency: undefined };
      delete usage.currentMonth.cost.billableCostMicros;
      const mounted = await mountUsagePage(Response.json(usage), locale);
      try {
        const card = await monthCard(mounted, title);
        expect(cost(card)).toBe(unknown);
        const budget = required(card.querySelector('[data-testid="usage-budget-limit"]'));
        expect(budget.textContent).toBe(limit);
        // The headline says it once: no badge and no second sentence under the budget.
        expect(card.textContent).not.toMatch(/incomplete|unvollständig/iu);
      } finally {
        await mounted.unmount();
      }
    }
  );

  it("says once, under the daily budget, that only today's cost is not known", async () => {
    const usage = createUsageSummary();
    delete usage.today.cost.billableCostMicros;
    const mounted = await mountUsagePage(Response.json(usage), "en");
    try {
      const card = await monthCard(mounted, "This month");
      expect(cost(card)).toBe("€100.00 of €400.00");
      expect(card.textContent?.split("Billable cost is incomplete.")).toHaveLength(2);
      expect(card.textContent).not.toContain("Incomplete");
    } finally {
      await mounted.unmount();
    }
  });

  it("says the month's cost alone where no monthly budget is set", async () => {
    const usage = createUsageSummary();
    usage.spendBudget = { currency: "EUR" };
    const mounted = await mountUsagePage(Response.json(usage), "en");
    try {
      const card = await monthCard(mounted, "This month");
      expect(cost(card)).toBe("€100.00");
      expect(card.querySelector('[role="progressbar"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  // The block on new model calls stood in the budget card, which the month's card replaces.
  it("says in the month's card that the budget is reached and new calls are blocked", async () => {
    const usage = createUsageSummary();
    usage.spendBudget = { currency: "EUR", monthlyLimitMicros: 400_000_000 };
    usage.currentMonth.cost = { ...usage.currentMonth.cost, billableCostMicros: 450_000_000 };
    const mounted = await mountUsagePage(Response.json(usage), "en");
    try {
      const card = await monthCard(mounted, "This month");
      expect(cost(card)).toBe("€450.00 of €400.00");
      // A known cost says the budget in its headline, and nowhere again.
      expect(card.querySelector('[data-testid="usage-budget-limit"]')).toBeNull();
      expect(card.textContent).toContain("Budget reached");
      expect(card.textContent).toContain("New model calls are blocked for the rest of this month.");
      const bar = required(card.querySelector('[role="progressbar"]'));
      expect(bar.getAttribute("aria-label")).toBe("Monthly budget used");
      expect(bar.getAttribute("aria-valuenow")).toBe("100");
    } finally {
      await mounted.unmount();
    }
  });

  // The badge said "Limit reached" and "Limit erreicht" of a budget.
  it("says in German that the budget is reached", async () => {
    const usage = createUsageSummary();
    usage.currentMonth.cost = { ...usage.currentMonth.cost, billableCostMicros: 450_000_000 };
    const mounted = await mountUsagePage(Response.json(usage), "de");
    try {
      const card = await monthCard(mounted, "Dieser Monat");
      expect(card.textContent).toContain("Budget erreicht");
      expect(card.textContent).not.toContain("Limit");
    } finally {
      await mounted.unmount();
    }
  });

  // A refusal showed the server's English sentence, with no one to ask.
  it.each([
    {
      locale: "en" as const,
      instanceAdminName: "Mara",
      said: "You may not see the usage of this instance. Ask an instance admin, for example Mara."
    },
    {
      locale: "de" as const,
      instanceAdminName: "Mara",
      said: "Du darfst die Nutzung dieser Instanz nicht sehen. Frag jemanden, der die Instanz verwaltet, zum Beispiel Mara."
    },
    {
      locale: "en" as const,
      instanceAdminName: undefined,
      said: "You may not see the usage of this instance. Ask an instance admin."
    },
    {
      locale: "de" as const,
      instanceAdminName: undefined,
      said: "Du darfst die Nutzung dieser Instanz nicht sehen. Frag jemanden, der die Instanz verwaltet."
    }
  ])(
    "a refusal names whom to ask ($locale, $instanceAdminName)",
    async ({ locale, instanceAdminName, said }) => {
      const refused = Response.json(
        { error: { code: "FORBIDDEN", message: "Settings > Instance > Access" } },
        { status: 403 }
      );
      const mounted = await mountUsagePage(refused, locale, instanceAdminName);
      try {
        await waitForText(mounted.container, said);
        expect(mounted.container.textContent).not.toContain("Settings >");
        // Information, not an error: somebody with more rights has to act.
        const banner = required(mounted.container.querySelector("[data-tone]"));
        expect(banner.getAttribute("data-tone")).toBe("info");
      } finally {
        await mounted.unmount();
      }
    }
  );

  it("a failure that is no refusal names nobody", async () => {
    const failed = Response.json(
      { error: { code: "TIMEOUT", message: "The instance did not answer in time." } },
      { status: 504 }
    );
    const mounted = await mountUsagePage(failed, "en", "Mara");
    try {
      await waitForText(mounted.container, "The instance did not answer in time.");
      expect(mounted.container.textContent).not.toContain("Mara");
      const banner = required(mounted.container.querySelector("[data-tone]"));
      expect(banner.getAttribute("data-tone")).toBe("danger");
    } finally {
      await mounted.unmount();
    }
  });
});

describe("usage spend budget progress", () => {
  it("shows daily and monthly progress against currency-denominated limits", () => {
    const markup = renderToStaticMarkup(createElement(UsageView, { usage: createUsageSummary() }));

    expect(markup).not.toContain("Spend budgets");
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

  it("renders German Usage and groups configured safeguards without English billable copy", () => {
    const usage = createUsageSummary();
    usage.safeguards.modelCallsPerDay = 25_000;
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "de",
        children: createElement(UsageView, { usage })
      })
    );
    expect(markup).toContain("Nutzung");
    expect(markup).toContain("Dieser Monat");
    expect(markup).toContain("25.000");
    expect(markup).not.toContain("Billable");
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

  // Fails without the change: a grid item's minimum width is its longest word, so "Unvollständig"
  // held its column wider than a narrow card and was clipped. HappyDOM cannot lay out CSS; the
  // pixel fit at 512px is checked in the browser, this test keeps the classes that allow it.
  it("lets an unbroken German metric value shrink and wrap inside its card", () => {
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

    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "de",
        children: createElement(UsageView, { usage })
      })
    );

    expect(markup).toMatch(
      /<strong class="(?=[^"]*\bmin-w-0\b)(?=[^"]*\bbreak-words\b)[^"]*">Unvollständig<\/strong>/u
    );
  });

  // Each width constraint matters independently of the large value's wrapping above.
  // Static rendering guards the CSS contract; browser evidence checks the actual fit.
  it("lets a metric card shrink below its value's unbroken width", () => {
    const container = document.createElement("div");
    container.innerHTML = renderToStaticMarkup(
      createElement(UsageView, { usage: createUsageSummary() })
    );
    const values = [...container.querySelectorAll("strong")];
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) {
      expect(required(value.closest("[data-card]")).classList.contains("min-w-0")).toBe(true);
    }
  });

  it.each(["min-w-0", "break-words"])(
    "keeps %s on smaller usage stats so their values can shrink and wrap",
    (className) => {
      const usage = createUsageSummary();
      usage.today.cost.webSearchCostVisible = true;
      usage.today.cost.complete = false;
      delete usage.today.cost.webSearchBillableCostMicros;
      const container = document.createElement("div");
      container.innerHTML = renderToStaticMarkup(
        createElement(TranslationProvider, {
          locale: "de",
          children: createElement(UsageView, { usage })
        })
      );
      const values = [...container.querySelectorAll("dd")];
      expect(values.some((value) => value.textContent === "Unvollständig")).toBe(true);
      for (const value of values) {
        const target = className === "min-w-0" ? required(value.parentElement) : value;
        expect(target.classList.contains(className)).toBe(true);
      }
    }
  );

  // Fails without the change: a failed and an abandoned call both read "No usage reported",
  // and a call with usage showed the stored value of its source, such as `provider_reported`.
  it("says in words how each call stands, in English and German, and shows no stored value", () => {
    const usage = createUsageSummary();
    usage.recentEvents = [
      createEvent("usage_running", "pending"),
      createEvent("usage_failed", "failed"),
      createEvent("usage_lost", "abandoned"),
      createEvent("usage_silent", "settled"),
      { ...createEvent("usage_reported", "settled"), source: "provider_reported", totalTokens: 9 },
      { ...createEvent("usage_estimated", "settled"), source: "estimated", totalTokens: 7 }
    ];

    const english = renderToStaticMarkup(createElement(UsageView, { usage }));
    const german = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: "de",
        children: createElement(UsageView, { usage })
      })
    );

    const statuses = (markup: string): string[] =>
      [...markup.matchAll(/<span[^>]*>([^<]*)<\/span><\/td><\/tr>/gu)].map((cell) => cell[1] ?? "");
    expect(statuses(english).slice(-6)).toEqual([
      "Running",
      "Failed",
      "Abandoned",
      "No usage reported",
      "Reported by provider",
      "Estimated"
    ]);
    expect(statuses(german).slice(-6)).toEqual([
      "Läuft",
      "Fehlgeschlagen",
      "Aufgegeben",
      "Keine Nutzung gemeldet",
      "Vom Anbieter gemeldet",
      "Geschätzt"
    ]);
    for (const markup of [english, german]) {
      for (const stored of ["not_reported", "provider_reported", "estimated", "abandoned"]) {
        expect(markup).not.toContain(stored);
      }
    }
    expect(english).toContain("Provider and region");
    expect(german).toContain("Anbieter und Region");
  });

  // Fails without the change: the table had eight columns, ten with web search, and at the
  // width of the page the last ones lay outside its box.
  it("shows a call in five columns, with the time, the model, the region, the cached input and the status as second lines", () => {
    const usage = createUsageSummary();
    usage.recentEvents = [
      {
        ...createEvent("usage_reported", "settled"),
        source: "provider_reported",
        totalTokens: 1200,
        cachedInputTokens: 800
      }
    ];

    const markup = renderToStaticMarkup(createElement(UsageView, { usage }));
    const recent = markup.slice(markup.indexOf("Recent model usage"));

    expect([...recent.matchAll(/<th[^>]*>([^<]*)<\/th>/gu)].map((head) => head[1])).toEqual([
      "Time",
      "Caller and model",
      "Provider and region",
      "Tokens",
      "Billable and status"
    ]);
    expect(recent).toContain(">gpt-main</span>");
    expect(recent).toContain(">EU</span>");
    expect(recent).toContain(">800 from cache</span>");
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
