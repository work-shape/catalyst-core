// @vitest-environment happy-dom

import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  createApiClient,
  type UsageBreakdown,
  type UsageSummary,
  type UsageUsers
} from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { administration } from "@work-shape/catalyst-chat-ui/admin";
import {
  UsageBreakdownPanel,
  UsageView,
  usagePeriodDays,
  type UsageBreakdownState
} from "@work-shape/catalyst-chat-ui/control-plane";
import { TranslationProvider } from "./support/chat-ui/shared";
import { platformContext } from "./chat-ui-build-fixtures";
import {
  mountPage,
  SETTINGS_INSTANCE_URL,
  settingsPageContext,
  settingsUser,
  waitForText
} from "./chat-ui-settings-fixtures";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { required } from "./support/assertions";

// The Usage page (LU-3): Overview, Breakdown, Users and Recent calls. Every Personal Workspace
// is one row, a recent call names its workspace and never its person, and the Users view is
// asked for only by a viewer with `usage.view_users`, and only while its tab is open.

const window = (calls: number, micros: number) => ({
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
  total: window(10, 4_000_000),
  rows: [
    { key: "", ...window(1, 400_000) },
    { key: "personal", ...window(3, 1_200_000) },
    { key: "cws_team", name: "Sales team", ...window(6, 2_400_000) }
  ]
};

const state: UsageBreakdownState = { period: "this_month", groupBy: "workspace", path: [] };

function summary(): UsageSummary {
  const empty = window(0, 0);
  return {
    generatedAt: "2026-10-15T12:00:00.000Z",
    spendBudget: { currency: "EUR", dailySpentMicros: 0, monthlySpentMicros: 4_000_000 },
    safeguards: {},
    today: empty,
    currentMonth: window(10, 4_000_000),
    allTime: window(10, 4_000_000),
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

describe("the Breakdown", () => {
  it.each([
    { locale: "en" as const, personal: "Personal workspaces", none: "Not attributed" },
    { locale: "de" as const, personal: "Persönliche Arbeitsbereiche", none: "Nicht zugeordnet" }
  ])("shows every Personal Workspace as one row and a shared one by name ($locale)", (words) => {
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale: words.locale,
        children: createElement(
          UiRoot,
          { mode: "light", labels: uiLabelsEn },
          createElement(UsageBreakdownPanel, {
            state,
            onStateChange: () => undefined,
            breakdown
          })
        )
      })
    );
    expect(markup.split(`>${words.personal}<`)).toHaveLength(2);
    expect(markup).toContain("Sales team");
    expect(markup).toContain(words.none);
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

  it("reads a period as UTC days, the last one excluded", () => {
    const now = new Date("2026-10-15T23:30:00.000Z");
    expect(usagePeriodDays("this_month", now)).toEqual({ from: "2026-10-01", to: "2026-10-16" });
    expect(usagePeriodDays("last_month", now)).toEqual({ from: "2026-09-01", to: "2026-10-01" });
    expect(usagePeriodDays("last_7", now)).toEqual({ from: "2026-10-09", to: "2026-10-16" });
  });
});

describe("the recent calls", () => {
  it.each([
    { locale: "en" as const, personal: "Personal workspace" },
    { locale: "de" as const, personal: "Persönlicher Arbeitsbereich" }
  ])("name a Personal Workspace without its person ($locale)", ({ locale, personal }) => {
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale,
        children: createElement(UsageView, { usage: summary(), tab: "recent" })
      })
    );
    expect(markup).toContain(personal);
    expect(markup).not.toMatch(/userId|user_/u);
  });
});

describe("the Overview", () => {
  it("projects the month in a straight line and counts what was started", () => {
    const markup = renderToStaticMarkup(createElement(UsageView, { usage: summary() }));
    // €4 in 14.5 days of a 31-day month.
    expect(markup).toContain("At this pace, about €8.55 by the end of the month.");
    expect(markup).toContain("People active");
    expect(markup).toContain(">30<");
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
      if (path === apiOperations["usage.get_summary"].path) return Response.json(summary());
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

describe("the Users view", () => {
  it("has no tab without the right to see usage by person", async () => {
    const mounted = await usagePage(["usage.view"]);
    try {
      await waitForText(mounted.container, "Overview");
      expect(tabs(mounted.container)).toEqual(["Overview", "Breakdown", "Recent calls"]);
      expect(mounted.asked).not.toContain(apiOperations["usage.users.list"].path);
    } finally {
      await mounted.unmount();
    }
  });

  it("asks for usage by person only once its tab is open", async () => {
    const mounted = await usagePage(["usage.view", "usage.view_users"]);
    try {
      await waitForText(mounted.container, "Users");
      expect(tabs(mounted.container)).toEqual(["Overview", "Breakdown", "Users", "Recent calls"]);
      expect(mounted.asked).not.toContain(apiOperations["usage.users.list"].path);
      await openTab(mounted.container, "Users");
      await waitForText(mounted.container, "Alex Example");
      expect(mounted.container.textContent).toContain("the audit log records who opened it");
      expect(
        mounted.asked.filter((path) => path === apiOperations["usage.users.list"].path)
      ).toHaveLength(1);
    } finally {
      await mounted.unmount();
    }
  });
});
