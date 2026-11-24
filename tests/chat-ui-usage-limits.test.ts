// @vitest-environment happy-dom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createApiClient,
  type OwnUsage,
  type UsageBreakdown,
  type UsageLimits,
  type UsageSummary,
  type UsageUsers
} from "@work-shape/catalyst-api-client";
import { apiOperations, safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import {
  UsageBreakdownPanel,
  usageBreakdownCsv,
  UsageView,
  usagePeriodDays,
  type UsageBreakdownState
} from "@work-shape/catalyst-chat-ui/control-plane";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { agentConfigSchema, createSafeConfigView } from "@work-shape/catalyst-config-schema";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  createTranslationContext,
  LimitsPage,
  OwnUsagePage,
  usageLimitBlockReason,
  usageNearNote,
  workspaceSendBlock
} from "./support/chat-ui";
import { TranslationProvider } from "./support/chat-ui/shared";
import { required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { platformContext } from "./chat-ui-build-fixtures";
import {
  mountPage,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser,
  waitForText
} from "./chat-ui-settings-fixtures";

// Spend limits (LU-2) in the composer and in Settings, and the Usage page (LU-3, UXA-5).

const en = createTranslationContext("en");
const resets = { day: "2026-10-25T00:00:00.000Z", month: "2026-11-01T00:00:00.000Z" };

function ownUsage(overrides: Partial<OwnUsage> = {}): OwnUsage {
  return {
    currency: "EUR",
    own: {
      day: { spent: 1, limit: 10, left: 9, reached: false, resetsAt: resets.day },
      month: { spent: 5, resetsAt: resets.month }
    },
    instance: {
      day: { resetsAt: resets.day },
      month: { reached: false, resetsAt: resets.month }
    },
    ...overrides
  };
}

describe("the composer at a spend limit", () => {
  it("names a reached limit with amounts only to whom they belong", () => {
    const reached = ownUsage({
      own: {
        day: { spent: 10, limit: 10, reached: true, resetsAt: resets.day },
        month: { spent: 5, resetsAt: resets.month }
      }
    });
    expect(usageLimitBlockReason(reached, en)).toContain("(€10.00 of €10.00)");

    // A member reads no amount of the workspace; its owner does.
    const member = ownUsage({
      workspace: {
        id: "cw_team",
        day: { resetsAt: resets.day },
        month: { reached: true, resetsAt: resets.month }
      }
    });
    expect(usageLimitBlockReason(member, en)).toBeDefined();
    expect(usageLimitBlockReason(member, en)).not.toContain("€");
    const owner = ownUsage({
      workspace: {
        id: "cw_team",
        day: { resetsAt: resets.day },
        month: { spent: 200, limit: 200, reached: true, resetsAt: resets.month }
      }
    });
    expect(usageLimitBlockReason(owner, en)).toContain("(€200.00 of €200.00)");

    // The instance's limit names no amount.
    const stopped = ownUsage({
      instance: {
        day: { reached: true, resetsAt: resets.day },
        month: { resetsAt: resets.month }
      }
    });
    expect(usageLimitBlockReason(stopped, en)).toBeDefined();
    expect(usageLimitBlockReason(stopped, en)).not.toContain("€");
    expect(usageLimitBlockReason(ownUsage(), en)).toBeUndefined();
    expect(usageLimitBlockReason(undefined, en)).toBeUndefined();
  });

  it("closes the composer with the sentence, which a queued send does not wait for", () => {
    const reason = "The daily spend limit for all workspaces together has been reached.";
    expect(
      workspaceSendBlock({
        attachmentBlockedReason: undefined,
        selectedConversationId: "conv_1",
        collaborationWorkspacesAvailable: true,
        activeCollaborationWorkspaceId: "cw_team",
        loading: false,
        loadFailed: false,
        workspacesListed: true,
        locale: "en",
        usageLimitReason: reason
      })
    ).toEqual({ reason, loading: false });
  });

  it("says how much is left from 80 percent of the person's own limit on, once per period", () => {
    const near = ownUsage({
      own: {
        day: { spent: 8.5, limit: 10, left: 1.5, reached: false, resetsAt: resets.day },
        month: { spent: 9, resetsAt: resets.month }
      }
    });
    expect(usageNearNote(near, en)).toMatchObject({ key: `day:${resets.day}` });
    expect(usageNearNote(near, en)?.text).toContain("€1.50");
    expect(usageNearNote(ownUsage(), en)).toBeUndefined();
  });

  it("measures the note against the limit as admission holds it, as `reached` is", () => {
    // A safety multiplier of 1.25 holds a limit of 10 at 8: the person is stopped at 8.
    const held = (spent: number) =>
      ownUsage({
        own: {
          day: {
            spent,
            limit: 10,
            left: Math.max(8 - spent, 0),
            reached: spent >= 8,
            resetsAt: resets.day
          },
          month: { resetsAt: resets.month }
        }
      });
    expect(usageNearNote(held(6), en)).toBeUndefined();
    expect(usageNearNote(held(6.5), en)?.text).toContain("€1.50");
    expect(usageNearNote(held(8), en)).toBeUndefined();
    expect(usageLimitBlockReason(held(8), en)).toBeDefined();
  });
});

function limits(overrides: Partial<UsageLimits> = {}): UsageLimits {
  return {
    currency: "EUR",
    ceiling: { daily: 50, monthly: 500 },
    effectiveInstance: { daily: 50, monthly: 500 },
    workspaces: [],
    users: [],
    nearLimit: [
      { kind: "user", id: "usr_kai", name: "Kai", period: "month", limit: 30, percent: 93 }
    ],
    workspaceOptions: [{ id: "cw_team", name: "Team" }],
    userOptions: [{ id: "usr_kai", name: "Kai" }],
    ...overrides
  };
}

function typeInto(field: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * The limits page against a fetch that answers the read and records the changes. After a
 * change it reads `after`, as the instance would.
 */
async function openLimits(answerChange: () => Response, after: UsageLimits = limits()) {
  const changes: unknown[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method === apiOperations["usage.limits.set"].method) {
      changes.push(await request.json());
      return answerChange();
    }
    return Response.json(changes.length === 0 ? limits() : after);
  };
  const mounted = await mountPage(
    settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl })),
    "en",
    createElement(LimitsPage)
  );
  await waitForText(mounted.container, "Every user");
  return { ...mounted, changes };
}

function editor(container: HTMLElement, label: string) {
  const found = container.querySelector<HTMLElement>(
    `[data-testid="limit-editor"][data-label="${label}"]`
  );
  if (!found) throw new Error(`No editor ${label}`);
  const [daily, monthly] = [...found.querySelectorAll<HTMLInputElement>("input")];
  const save = [...found.querySelectorAll("button")].find(
    (button) => button.textContent === "Save"
  );
  if (!daily || !monthly || !save) throw new Error(`Editor ${label} is incomplete`);
  return { element: found, daily, monthly, save };
}

describe("Settings > Instance > Limits", () => {
  it("shows who is near a limit and saves a default for every user", async () => {
    const page = await openLimits(
      () => Response.json({ level: "user_default", limits: { monthly: 30 } }),
      limits({ userDefault: { monthly: 30 } })
    );
    try {
      expect(page.container.textContent).toContain("93 %");
      const users = editor(page.container, "Every user");
      expect(users.save.disabled).toBe(true);
      await act(async () => typeInto(users.monthly, "30"));
      expect(users.save.disabled).toBe(false);
      await act(async () => users.save.click());
      await waitForText(page.container, "Saved.");
      expect(page.changes).toEqual([{ level: "user_default", limits: { monthly: 30 } }]);
    } finally {
      await page.unmount();
    }
  });

  it("says why an instance limit above the ceiling was refused", async () => {
    const page = await openLimits(() =>
      Response.json(
        {
          error: {
            code: "VALIDATION_FAILED",
            message: "above",
            details: { reason: "above_ceiling", period: "monthly", ceiling: 500 }
          }
        },
        { status: 422 }
      )
    );
    try {
      const instance = editor(page.container, "All workspaces");
      await act(async () => typeInto(instance.monthly, "900"));
      await act(async () => instance.save.click());
      await waitForText(page.container, "€500.00.");
      expect(page.changes).toEqual([{ level: "instance", limits: { monthly: 900 } }]);
    } finally {
      await page.unmount();
    }
  });
});

describe("You > Usage", () => {
  it("shows the person's own spending against their limit", async () => {
    const fetchImpl: typeof fetch = async () => Response.json(ownUsage());
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl })),
      "en",
      createElement(OwnUsagePage)
    );
    try {
      await waitForText(mounted.container, "€1.00 of €10.00");
      expect(mounted.container.textContent).toContain("€5.00");
    } finally {
      await mounted.unmount();
    }
  });
});

// Instance > Usage.

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

function createUsageSummary(): UsageSummary {
  return {
    generatedAt: "2026-07-12T12:00:00.000Z",
    spendBudget: {
      currency: "EUR",
      dailyLimitMicros: 50_000_000,
      monthlyLimitMicros: 400_000_000,
      dailySpentMicros: 10_000_000,
      monthlySpentMicros: 100_000_000
    },
    safeguards: { modelCallsPerDay: 1000 },
    today: createWindowSummary(10_000_000),
    currentMonth: createWindowSummary(100_000_000),
    allTime: createWindowSummary(100_000_000),
    dailyUsage: [],
    monthlyUsage: [],
    recentEvents: []
  };
}

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

/** Instance > Usage as the Settings area shows it, against an instance that answers `answer`. */
async function mountUsagePage(answer: Response, instanceAdminName?: string) {
  const page = required(administration.pages?.find((candidate) => candidate.id === "usage"));
  const respond: typeof fetch = async () => answer.clone();
  return mountPage(
    settingsPageContext(
      createApiClient({ baseUrl: SETTINGS_INSTANCE_URL, fetchImpl: respond }),
      settingsUser({ instanceAdminName })
    ),
    "en",
    createElement(page.component)
  );
}

/** The month's card, once the page has read the summary. */
async function monthCard(mounted: { container: HTMLElement }) {
  await waitForText(mounted.container, "This month");
  return required(
    mounted.container.querySelector<HTMLElement>('[data-testid="usage-month-budget"]')
  );
}
const cost = (card: HTMLElement) =>
  required(card.querySelector('[data-testid="usage-month-cost"]')).textContent;

describe("Usage, the month against its budget", () => {
  it("says what the month cost of its budget, with the tokens", async () => {
    const usage = createUsageSummary();
    usage.currentMonth.totalTokens = 1_234_567;
    const mounted = await mountUsagePage(Response.json(usage));
    try {
      const card = await monthCard(mounted);
      expect(cost(card)).toBe("€100.00 of €400.00");
      expect(card.textContent).toContain("1,234,567");
    } finally {
      await mounted.unmount();
    }
  });

  it("says the cost is not known yet while nothing is priced, beside the budget", async () => {
    const usage = createUsageSummary();
    usage.spendBudget = { currency: "EUR", monthlyLimitMicros: 437_000_000 };
    usage.currentMonth.cost = { ...usage.currentMonth.cost, currency: undefined };
    delete usage.currentMonth.cost.billableCostMicros;
    const mounted = await mountUsagePage(Response.json(usage));
    try {
      const card = await monthCard(mounted);
      expect(cost(card)).toBe("Cost not known yet");
      expect(required(card.querySelector('[data-testid="usage-budget-limit"]')).textContent).toBe(
        "€437.00"
      );
    } finally {
      await mounted.unmount();
    }
  });

  it("says the month's cost alone where no monthly budget is set", async () => {
    const usage = createUsageSummary();
    usage.spendBudget = { currency: "EUR" };
    const mounted = await mountUsagePage(Response.json(usage));
    try {
      const card = await monthCard(mounted);
      expect(cost(card)).toBe("€100.00");
      expect(card.querySelector('[role="progressbar"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("blocks new calls once chat spend passes both budgets", async () => {
    const usage = createUsageSummary();
    usage.currentMonth.cost = { ...usage.currentMonth.cost, billableCostMicros: 450_000_000 };
    usage.today.cost = { ...usage.today.cost, billableCostMicros: 60_000_000 };
    usage.spendBudget = {
      ...usage.spendBudget,
      dailySpentMicros: 60_000_000,
      monthlySpentMicros: 450_000_000
    };
    const mounted = await mountUsagePage(Response.json(usage));
    try {
      const card = await monthCard(mounted);
      expect(cost(card)).toBe("€450.00 of €400.00");
      expect(card.textContent).toContain("rest of this month");
      expect(card.textContent).toContain("rest of today");
      expect(card.querySelector('[data-testid="usage-budget-scope"]')).toBeNull();
      const bars = [...card.querySelectorAll('[role="progressbar"]')];
      expect(bars.map((bar) => bar.getAttribute("aria-valuenow"))).toContain("100");
    } finally {
      await mounted.unmount();
    }
  });

  // Knowledge base ingestion counted against the budgets and blocked chat it never reaches.
  it("counts no knowledge base ingestion against the budgets, and still says the month's total", async () => {
    const usage = createUsageSummary();
    usage.currentMonth.cost = { ...usage.currentMonth.cost, billableCostMicros: 900_000_000 };
    usage.today.cost = { ...usage.today.cost, billableCostMicros: 60_000_000 };
    usage.spendBudget = { ...usage.spendBudget, dailySpentMicros: 0, monthlySpentMicros: 0 };
    const mounted = await mountUsagePage(Response.json(usage));
    try {
      const card = await monthCard(mounted);
      expect(cost(card)).toBe("€900.00");
      expect(card.textContent).toContain("€0.00 of €400.00");
      expect(card.textContent).toContain("€0.00 of €50.00");
      expect(card.querySelector('[data-testid="usage-budget-scope"]')).not.toBeNull();
      expect(card.textContent).not.toMatch(/blocked|Budget reached/u);
      const bars = [...card.querySelectorAll('[role="progressbar"]')];
      expect(bars.map((bar) => bar.getAttribute("aria-valuenow"))).toEqual(["0", "0"]);
    } finally {
      await mounted.unmount();
    }
  });

  // A server older than the budget spend fields: its totals include ingestion, so no bar reads them.
  it("says the budget spend is unknown where the server does not report it", async () => {
    const usage = createUsageSummary();
    usage.currentMonth.cost = { ...usage.currentMonth.cost, billableCostMicros: 900_000_000 };
    usage.today.cost = { ...usage.today.cost, billableCostMicros: 60_000_000 };
    delete usage.spendBudget.dailySpentMicros;
    delete usage.spendBudget.monthlySpentMicros;
    const mounted = await mountUsagePage(Response.json(usage));
    try {
      const card = await monthCard(mounted);
      expect(cost(card)).toBe("€900.00");
      expect(card.querySelector('[role="progressbar"]')).toBeNull();
      expect(card.textContent).not.toMatch(/blocked|Budget reached/u);
    } finally {
      await mounted.unmount();
    }
  });

  // A refusal showed the server's English sentence, with no one to ask.
  it.each([
    { instanceAdminName: "Mara", asks: "for example Mara." },
    { instanceAdminName: undefined, asks: "Ask an admin for all workspaces." }
  ])(
    "a refusal is information that names whom to ask ($instanceAdminName)",
    async ({ instanceAdminName, asks }) => {
      const refused = Response.json(
        { error: { code: "FORBIDDEN", message: "Settings > Instance > Access" } },
        { status: 403 }
      );
      const mounted = await mountUsagePage(refused, instanceAdminName);
      try {
        await waitForText(mounted.container, asks);
        expect(mounted.container.textContent).not.toContain("Settings >");
        expect(
          required(mounted.container.querySelector("[data-tone]")).getAttribute("data-tone")
        ).toBe("info");
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
    const mounted = await mountUsagePage(failed, "Mara");
    try {
      await waitForText(mounted.container, "The instance did not answer in time.");
      expect(mounted.container.textContent).not.toContain("Mara");
      expect(
        required(mounted.container.querySelector("[data-tone]")).getAttribute("data-tone")
      ).toBe("danger");
    } finally {
      await mounted.unmount();
    }
  });
});

describe("Usage, the overview", () => {
  it("shows daily and monthly progress against currency-denominated limits", () => {
    const markup = renderToStaticMarkup(createElement(UsageView, { usage: createUsageSummary() }));
    expect(markup).toContain('aria-valuenow="20"');
    expect(markup).toContain('aria-valuenow="25"');
  });

  it("says the safeguards are each person's, not a ceiling the instance shares", () => {
    // ACCEPT-FIX-4: the safeguards count per person; the card read as one shared ceiling.
    expect(
      renderToStaticMarkup(createElement(UsageView, { usage: createUsageSummary() }))
    ).toContain("Each person&#x27;s ceiling");
  });

  it("projects the month in a straight line", () => {
    const summary = reportsSummary();
    // €4 in 14.5 days of a 31-day month.
    expect(renderToStaticMarkup(createElement(UsageView, { usage: summary }))).toContain("€8.55");
  });
});

describe("Usage, the recent calls", () => {
  // Fails without the change: a call showed the stored value of its source.
  it("says how each call stands and shows no stored value", () => {
    const usage = createUsageSummary();
    usage.recentEvents = [
      createEvent("usage_failed", "failed"),
      createEvent("usage_lost", "abandoned"),
      { ...createEvent("usage_reported", "settled"), source: "provider_reported", totalTokens: 9 },
      { ...createEvent("usage_estimated", "settled"), source: "estimated", totalTokens: 7 }
    ];
    const markup = renderToStaticMarkup(createElement(UsageView, { usage, tab: "recent" }));
    for (const stored of ["not_reported", "provider_reported", "estimated", "abandoned"]) {
      expect(markup).not.toContain(stored);
    }
  });

  // Fails without the change: a knowledge base field extraction call showed the agent name.
  it("names a knowledge base field extraction call by its purpose", () => {
    const usage = createUsageSummary();
    usage.recentEvents = [
      {
        ...createEvent("usage_fields", "settled"),
        agentName: "stored-agent",
        purpose: "knowledge_field_extraction"
      }
    ];
    const markup = renderToStaticMarkup(createElement(UsageView, { usage, tab: "recent" }));
    expect(markup).toContain("Knowledge base field extraction");
    expect(markup).not.toContain("stored-agent");
  });

  it("names a Personal Workspace without its person", () => {
    const markup = renderToStaticMarkup(
      createElement(UsageView, { usage: reportsSummary(), tab: "recent" })
    );
    expect(markup).toContain("Personal workspace");
    expect(markup).not.toMatch(/userId|user_/u);
  });

  // ACCEPT-FIX-10 C10: a call of an agent named the agent by its id, `workflow_assistant`.
  it("names the agent of a call by its display name", async () => {
    const usage = createUsageSummary();
    usage.recentEvents = [
      { ...createEvent("usage_agent", "settled"), agentName: "workflow_assistant" }
    ];
    const config = createTestConfig();
    const agent = agentConfigSchema.parse({
      name: "workflow_assistant",
      displayName: { en: "Workflow assistant", de: "Workflow-Assistent" },
      instructions: "Help.",
      toolNames: []
    });
    const settings = settingsPageContext(
      createApiClient({
        baseUrl: SETTINGS_INSTANCE_URL,
        fetchImpl: async () => Response.json(usage)
      })
    );
    settings.config = safeConfigSchema.parse(
      createSafeConfigView(
        config,
        { version: 0, agents: [agent], skills: [] },
        resolveInstanceModules(config, []).snapshot,
        { requestedLocale: "en" }
      )
    );
    const page = required(administration.pages?.find((candidate) => candidate.id === "usage"));
    const mounted = await mountPage(settings, "en", createElement(page.component));
    try {
      await waitForText(mounted.container, "Recent calls");
      await openTab(mounted.container, "Recent calls");
      await waitForText(mounted.container, "Workflow assistant");
      expect(mounted.container.textContent).not.toContain("workflow_assistant");
    } finally {
      await mounted.unmount();
    }
  });
});

const usageWindow = (calls: number, micros: number) => ({
  modelCallCount: calls,
  inputTokens: calls * 100,
  cachedInputTokens: 0,
  outputTokens: calls * 100,
  totalTokens: calls * 200,
  webSearchCallCount: 0,
  cost: {
    status: "settled" as const,
    currency: "EUR",
    billableCostMicros: micros,
    complete: true,
    webSearchCostVisible: false,
    settledModelCallCount: calls,
    incompleteModelCallCount: 0,
    settledWebSearchCallCount: 0,
    incompleteWebSearchCallCount: 0
  }
});

const breakdown: UsageBreakdown = {
  from: "2026-10-01",
  to: "2026-10-25",
  groupBy: "workspace",
  personalWorkspacesKey: "personal",
  total: usageWindow(10, 4_000_000),
  rows: [
    { key: "", ...usageWindow(1, 400_000) },
    { key: "personal", ...usageWindow(3, 1_200_000) },
    { key: "cws_team", name: "Sales team", ...usageWindow(6, 2_400_000) }
  ]
};

const state: UsageBreakdownState = { period: "this_month", groupBy: "workspace", path: [] };

function reportsSummary(): UsageSummary {
  const empty = usageWindow(0, 0);
  return {
    generatedAt: "2026-10-15T12:00:00.000Z",
    spendBudget: { currency: "EUR", dailySpentMicros: 0, monthlySpentMicros: 4_000_000 },
    safeguards: {},
    today: empty,
    currentMonth: usageWindow(10, 4_000_000),
    allTime: usageWindow(10, 4_000_000),
    dailyUsage: [],
    monthlyUsage: [],
    attributedUsage: [],
    recentEvents: [
      {
        id: "usage_personal",
        status: "settled",
        clientInstanceId: "client",
        agentName: "writer",
        providerId: "azure-eu",
        model: "gpt-main",
        region: "eu",
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 10,
        totalTokens: 20,
        webSearchCallCount: 0,
        billedAsFast: false,
        source: "provider_reported",
        correlationId: "corr",
        createdAt: "2026-10-15T11:00:00.000Z",
        workspace: { key: "personal" },
        cost: { status: "settled", currency: "EUR", complete: true, webSearchCostVisible: false }
      }
    ],
    activity: {
      activeUsers: 4,
      conversations: 12,
      agentRuns: 30,
      appActionRuns: 2,
      workflowRuns: 1
    }
  };
}

function renderBreakdown(props: Partial<Parameters<typeof UsageBreakdownPanel>[0]>): string {
  return renderToStaticMarkup(
    createElement(TranslationProvider, {
      locale: "en",
      children: createElement(
        UiRoot,
        { mode: "light", labels: uiLabelsEn },
        createElement(UsageBreakdownPanel, {
          state,
          onStateChange: () => undefined,
          breakdown,
          ...props
        })
      )
    })
  );
}

describe("Usage, the Breakdown", () => {
  it("shows every Personal Workspace as one row and a shared one by name", () => {
    const markup = renderBreakdown({});
    expect(markup.split(">Personal workspaces<")).toHaveLength(2);
    expect(markup).toContain("Sales team");
    expect(markup).not.toContain(">cws_team<");
    // The share of a row is of the whole period.
    expect(markup).toMatch(/60(\.|,)?0?\s?%/u);
  });

  it("opens a row into the next dimension, narrowed to it", async () => {
    const onStateChange = vi.fn();
    const mounted = await mountPage(
      settingsPageContext(createApiClient({ baseUrl: SETTINGS_INSTANCE_URL })),
      "en",
      createElement(UsageBreakdownPanel, { state, onStateChange, breakdown })
    );
    try {
      const open = required(
        mounted.container.querySelector<HTMLButtonElement>(
          'button[aria-label="Show Sales team by Agent"]'
        )
      );
      await act(async () => open.click());
      expect(onStateChange).toHaveBeenCalledWith({
        period: "this_month",
        groupBy: "agent",
        path: [{ dimension: "workspace", key: "cws_team", label: "Sales team" }]
      });
    } finally {
      await mounted.unmount();
    }
  });

  it("names no row by another dimension while the new grouping loads", () => {
    const markup = renderBreakdown({ state: { ...state, groupBy: "agent" }, loading: true });
    expect(markup).not.toContain("Sales team");
    expect(markup).not.toContain("cws_team");
  });

  const byAgent: UsageBreakdown = {
    ...breakdown,
    groupBy: "agent",
    rows: [
      { key: "writer", ...usageWindow(6, 2_400_000), feedbackCount: 3 },
      { key: "reader", ...usageWindow(4, 1_600_000), feedbackCount: 0 }
    ],
    feedback: { reviewable: true },
    unusedAgents: ["drafter"]
  };
  const renderByAgent = (shown: UsageBreakdown) =>
    renderBreakdown({
      state: { ...state, groupBy: "agent" },
      breakdown: shown,
      agentLabel: (name) => (name === "drafter" ? "Draft helper" : undefined)
    });

  it("by agent, leads only a reviewer to the feedback in the Inbox", () => {
    const markup = renderByAgent(byAgent);
    expect(markup).toContain('href="/inbox/agent/writer"');
    // No comment, nothing to open.
    expect(markup).not.toContain('href="/inbox/agent/reader"');
    expect(markup).toContain("Draft helper");

    // A viewer who reviews no feedback reads the count and gets no link.
    const plain = renderByAgent({ ...byAgent, feedback: { reviewable: false } });
    expect(plain).not.toContain("/inbox/agent/");
    expect(plain).toMatch(/data-usage-feedback="">3</u);

    // Without the feedback Module there is no such column.
    const { feedback: _feedback, ...withoutModule } = byAgent;
    expect(renderByAgent(withoutModule)).not.toContain("data-usage-feedback");
  });

  it("by agent, names each row as people know it: the server's name, or what an agentless call was for", () => {
    const markup = renderByAgent({
      ...byAgent,
      rows: [
        { key: "assistant", name: "Ada", ...usageWindow(2, 800_000) },
        { key: ":purpose:knowledge_page_reading", ...usageWindow(3, 1_200_000) }
      ]
    });
    expect(markup).toContain(">Ada<");
    expect(markup).toContain(">Knowledge base page reading<");
  });

  it("writes the table as one CSV file a spreadsheet sums and runs nothing of", () => {
    const shown: UsageBreakdown = {
      ...breakdown,
      rows: [
        { key: "cws_team", name: '=HYPERLINK("x"), "Sales"', ...usageWindow(6, 2_400_000) },
        { key: "personal", ...usageWindow(4, 1_600_000) }
      ]
    };
    const label = (row: UsageBreakdown["rows"][number]) => row.name ?? "Personal workspaces";
    const csv = usageBreakdownCsv(shown, label, (key) => key);
    expect(csv.split("\r\n")).toEqual([
      "usageReports.dimensionWorkspace,usageReports.cost (EUR),usageReports.share,usageReports.calls,usageReports.tokens",
      `"'=HYPERLINK(""x""), ""Sales""",2.4,0.6,6,1200`,
      "Personal workspaces,1.6,0.4,4,800",
      "usageReports.total,4,,10,2000"
    ]);
    const agentLines = usageBreakdownCsv(
      byAgent,
      (row) => row.key,
      (key) => key
    ).split("\r\n");
    expect(agentLines[1]).toBe("writer,2.4,0.6,6,1200,3");
    expect(agentLines.at(-1)).toBe("usageReports.total,4,,10,2000,3");
  });

  it("reads a period as UTC days, the last one excluded", () => {
    const now = new Date("2026-10-15T23:30:00.000Z");
    expect(usagePeriodDays("this_month", now)).toEqual({ from: "2026-10-01", to: "2026-10-16" });
    expect(usagePeriodDays("last_month", now)).toEqual({ from: "2026-09-01", to: "2026-10-01" });
    expect(usagePeriodDays("last_7", now)).toEqual({ from: "2026-10-09", to: "2026-10-16" });
  });
});

/** The Usage page against an instance that answers the given actions. */
async function usagePage(actions: string[]) {
  const asked: string[] = [];
  const users: UsageUsers = {
    month: "2026-10",
    currency: "EUR",
    items: [{ userId: "usr_a", name: "Alex Example", spent: 1.5, modelCallCount: 3, tokens: 600 }]
  };
  const client = createApiClient({
    baseUrl: SETTINGS_INSTANCE_URL,
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const path = new URL(request.url).pathname;
      asked.push(path);
      if (path === apiOperations["usage.get_summary"].path) return Response.json(reportsSummary());
      if (path === apiOperations["platform.context.get"].path)
        return Response.json({ ...platformContext(), instanceActions: actions });
      if (path === apiOperations["usage.users.list"].path) return Response.json(users);
      if (path === apiOperations["usage.breakdown.get"].path) return Response.json(breakdown);
      return Response.json(
        { error: { code: "NOT_FOUND", message: "No fixture" } },
        { status: 404 }
      );
    }
  });
  const page = required(administration.pages?.find((item) => item.id === "usage"));
  const mounted = await mountPage(
    settingsPageContext(client, settingsUser({ roles: ["admin"], permissions: ["usage.view"] })),
    "en",
    createElement(page.component)
  );
  await waitForText(mounted.container, "Recent calls");
  return { ...mounted, asked };
}

const tabs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => tab.textContent);

async function openTab(container: HTMLElement, name: string) {
  const tab = required(
    [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (candidate) => candidate.textContent === name
    )
  );
  await act(async () => {
    tab.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
  });
}

describe("Usage, the Users view", () => {
  it("has no tab without the right to see usage by person", async () => {
    const mounted = await usagePage(["usage.view"]);
    try {
      await waitForText(mounted.container, "Overview");
      expect(tabs(mounted.container)).not.toContain("Users");
      expect(mounted.asked).not.toContain(apiOperations["usage.users.list"].path);
    } finally {
      await mounted.unmount();
    }
  });

  it("asks for usage by person only once its tab is open", async () => {
    const mounted = await usagePage(["usage.view", "usage.view_users"]);
    try {
      await waitForText(mounted.container, "Users");
      expect(tabs(mounted.container)).toContain("Users");
      expect(mounted.asked).not.toContain(apiOperations["usage.users.list"].path);
      await openTab(mounted.container, "Users");
      await waitForText(mounted.container, "Alex Example");
      expect(
        mounted.asked.filter((path) => path === apiOperations["usage.users.list"].path)
      ).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });
});
