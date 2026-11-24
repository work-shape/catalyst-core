import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  DEFAULT_SCHEDULE,
  ScheduledDialog,
  ScheduledPageView,
  ScheduledStartCard,
  ScheduledStartSummaryView,
  choiceOf,
  cronLooksValid,
  cronOf,
  cronRunsTooOften,
  headingOf,
  runReasonKey,
  runsRefreshMs,
  runState,
  scheduleLine,
  scheduledStartCall,
  startNotice,
  type ScheduledList,
  type ScheduledRun,
  type ScheduledRuns,
  type ScheduledStart
} from "@work-shape/catalyst-chat-ui/scheduled";
import { ToolDecisionCardView } from "@work-shape/catalyst-chat-ui/tool-decision-card";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// EW-8: the Scheduled page lists a person's own saved prompts with their next time, their
// latest runs and the conversations those started, and lets them make, change, run, pause and
// delete one. An agent's call on one is confirmed in words, never as raw fields and ids.

const en = createTranslationContext("en");

const start: ScheduledStart = {
  id: "sched_1",
  ownerUserId: "user_1",
  collaborationWorkspaceId: "ws_1",
  agentName: "support",
  prompt: "Summarise yesterday's new support tickets\nand name the three most urgent.",
  cron: "0 8 * * 1-5",
  timeZone: "Europe/Berlin",
  state: "active",
  nextRunAt: "2026-10-20T06:00:00.000Z",
  createdAt: "2026-10-19T08:00:00.000Z",
  updatedAt: "2026-10-19T08:00:00.000Z"
};

function run(input: Partial<ScheduledRun> & Pick<ScheduledRun, "id" | "status">): ScheduledRun {
  return {
    scheduledStartId: start.id,
    scheduledFor: "2026-10-19T06:00:00.000Z",
    conversationId: null,
    agentRunId: null,
    reason: null,
    createdAt: "2026-10-19T06:00:00.000Z",
    ...input
  };
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/gu, " ")
    .replace(/&#x27;/gu, "'")
    .replace(/&quot;/gu, '"')
    .replace(/\s+/gu, " ");

function inLocale(locale: "en", node: ReactNode): string {
  return renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
}

const noop = () => undefined;

describe("a scheduled prompt in words", () => {
  it("is headed by the first line of its prompt, cut at a word when long", () => {
    expect(headingOf(start.prompt)).toBe("Summarise yesterday's new support tickets");
    expect(headingOf("\n\n  Check   the   inbox  \nmore")).toBe("Check the inbox");
    const long = headingOf(`${"word ".repeat(30)}end`);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(81);
  });

  it("writes each preset as cron and opens a saved cron as its preset", () => {
    expect(cronOf(DEFAULT_SCHEDULE)).toBe("0 8 * * 1-5");
    expect(cronOf({ ...DEFAULT_SCHEDULE, preset: "daily", time: "07:30" })).toBe("30 7 * * *");
    for (const cron of ["30 7 * * *", "0 8 * * 1-5", "30 17 * * 5", "0 9 1 * *"]) {
      expect(cronOf(choiceOf(cron))).toBe(cron);
    }
    expect(choiceOf("*/15 * * * *")).toMatchObject({ preset: "custom", cron: "*/15 * * * *" });
  });

  it("refuses what is plainly no five-field cron before saving", () => {
    expect(cronLooksValid("0 8 * * 1-5")).toBe(true);
    expect(cronLooksValid("*/15 9-17 * * MON-FRI")).toBe(true);
    expect(cronLooksValid("0 8 * *")).toBe(false);
    expect(cronLooksValid("0 8 * * 1; rm")).toBe(false);
  });

  it("refuses a schedule due more often than every 15 minutes", () => {
    for (const cron of ["*/10 * * * *", "0,5 9 * * *", "0,59 0,23 * * *"])
      expect(cronRunsTooOften(cron), cron).toBe(true);
    for (const cron of ["*/15 * * * *", "0 8 * * 1-5", "not a cron"])
      expect(cronRunsTooOften(cron), cron).toBe(false);
  });

  it("says the schedule's zone in words, never by its id", () => {
    expect(scheduleLine(start, en)).not.toContain("Europe/Berlin");
    expect(scheduleLine({ cron: "*/15 * * * *", timeZone: "UTC" }, en)).toContain("*/15 * * * *");
  });

  it("never shows a status or a reason it does not know as the server wrote it", () => {
    expect(runState("brand_new_status").label).toBe("scheduled.runStatus.other");
    expect(runState("waiting_for_decision")).toMatchObject({ tone: "warning", spins: false });
    expect(runState("running").spins).toBe(true);
    expect(runReasonKey(run({ id: "r", status: "failed", reason: "boom_internal" }))).toBe(
      "scheduled.reason.other"
    );
    expect(runReasonKey(run({ id: "r", status: "completed" }))).toBeUndefined();
  });

  it("asks for the owner's decision while the latest run waits, and names a missing connection", () => {
    expect(
      startNotice([
        run({ id: "r2", status: "skipped", reason: "waiting_for_decision" }),
        run({ id: "r1", status: "waiting_for_decision", conversationId: "conv_1" })
      ])
    ).toEqual({ kind: "waiting", conversationId: "conv_1" });
    expect(
      startNotice([run({ id: "r1", status: "failed", reason: "connection_needs_reconnect" })])
    ).toEqual({ kind: "connection", message: "scheduled.connectionNeedsReconnect" });
    expect(
      startNotice([
        run({ id: "r2", status: "completed", conversationId: "c" }),
        run({ id: "r1", status: "failed", reason: "connection_not_connected" })
      ])
    ).toBeUndefined();
  });

  // GR-4: a guardrail on chat input blocked the prompt when it fired.
  it("tells the owner when a guardrail blocked the prompt of the latest run", () => {
    const blocked = run({ id: "r1", status: "failed", reason: "guardrail_blocked" });
    expect(runReasonKey(blocked)).toBe("scheduled.reason.guardrailBlocked");
    expect(startNotice([blocked])).toEqual({ kind: "guardrail" });
    expect(
      startNotice([run({ id: "r2", status: "completed", conversationId: "c" }), blocked])
    ).toBeUndefined();
  });
});

describe("an open Scheduled page", () => {
  it("reads the runs again on its own, soon while one goes or was asked for", () => {
    const idle = runsRefreshMs([], undefined);
    const done = runsRefreshMs([run({ id: "r1", status: "completed" })], undefined);
    // Idle, a due time that passes still shows within a minute, without a reload.
    expect(idle).toBeGreaterThan(0);
    expect(idle).toBeLessThanOrEqual(60_000);
    expect(done).toBe(idle);
    const going = runsRefreshMs([run({ id: "r1", status: "running" })], undefined);
    const askedForFirst = runsRefreshMs([], null);
    const askedForNext = runsRefreshMs([run({ id: "r1", status: "completed" })], "r1");
    for (const soon of [going, askedForFirst, askedForNext]) {
      expect(soon).toBeGreaterThan(0);
      expect(soon).toBeLessThan(idle);
    }
    // Once the asked-for run shows, the pace is idle again.
    expect(runsRefreshMs([run({ id: "r2", status: "completed" })], "r1")).toBe(idle);
  });
});

const loaded = (rows: ScheduledStart[] | undefined, more: Partial<ScheduledList> = {}) => ({
  rows,
  failed: false,
  hasMore: false,
  loadingMore: false,
  loadMore: noop,
  retry: noop,
  ...more
});

function renderPage(list: ScheduledList): string {
  return inLocale(
    "en",
    createElement(ScheduledPageView, {
      list,
      onNew: noop,
      renderStart: (row) => createElement("p", { "data-row": row.id }, row.prompt)
    })
  );
}

describe("the Scheduled page", () => {
  it("says a failed read in place, with the way to read again", () => {
    const markup = renderPage(loaded(undefined, { failed: true }));
    expect(markup).toContain("data-load-error");
  });
});

const runsOf = (runs: ScheduledRun[] | undefined, failed = false): ScheduledRuns => ({
  runs,
  failed,
  retry: noop
});

function renderCard(input: {
  start?: ScheduledStart;
  runs?: ScheduledRuns;
  connections?: boolean;
}): string {
  return inLocale(
    "en",
    createElement(ScheduledStartCard, {
      start: input.start ?? start,
      agentLabel: "Support assistant",
      runs: input.runs ?? runsOf([]),
      busy: undefined,
      feedback: undefined,
      connectionsRoute: input.connections
        ? { kind: "build-kind", assetKind: "connections" }
        : undefined,
      onRunNow: noop,
      onToggleState: noop,
      onEdit: noop,
      onDelete: noop,
      onOpenRoute: noop
    })
  );
}

describe("one scheduled prompt", () => {
  it("shows no id or raw cron", () => {
    const words = text(renderCard({}));
    expect(words).not.toContain("sched_1");
    expect(words).not.toContain("0 8 * * 1-5");
  });

  it("lists its runs with their state and a link to each result conversation", () => {
    const markup = renderCard({
      runs: runsOf([
        run({ id: "r2", status: "running", conversationId: "conv_2" }),
        run({ id: "r1", status: "completed", conversationId: "conv_1" }),
        run({ id: "r0", status: "skipped", reason: "previous_run_active" })
      ])
    });
    expect(markup.match(/data-testid="scheduled-run"/gu)).toHaveLength(3);
    expect(markup).toContain('href="/w/ws_1/c/conv_2"');
    expect(markup).toContain('href="/w/ws_1/c/conv_1"');
  });

  it("explains that the next times are skipped while a run waits for a decision", () => {
    const runs = runsOf([
      run({ id: "r2", status: "skipped", reason: "waiting_for_decision" }),
      run({ id: "r1", status: "waiting_for_decision", conversationId: "conv_1" })
    ]);
    const markup = renderCard({ runs });
    expect(markup).toContain('data-testid="scheduled-waiting"');
    expect(markup.match(/href="\/w\/ws_1\/c\/conv_1"/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it("asks to reconnect a personal connection, linking only where the person can open it", () => {
    const runs = runsOf([
      run({ id: "r1", status: "failed", reason: "connection_needs_reconnect" })
    ]);
    const linked = renderCard({ runs, connections: true });
    expect(linked).toContain('href="/build/connections"');
    expect(renderCard({ runs })).not.toContain('href="/build/connections"');
  });
});

function renderDialog(draft: Parameters<typeof ScheduledDialog>[0]["draft"]): string {
  return inLocale(
    "en",
    createElement(ScheduledDialog, {
      draft,
      agents: [
        { name: "support", displayName: "Support assistant" },
        { name: "writer", displayName: "Writer" }
      ],
      defaultAgentName: "writer",
      instanceTimeZone: "Europe/Berlin",
      saving: false,
      failed: false,
      onSave: noop,
      onClose: noop
    })
  );
}

describe("the dialog that makes and changes a scheduled prompt", () => {
  it("starts a new one with the workspace's default agent, weekdays at eight, in the instance's zone", () => {
    const markup = renderDialog({ prompt: "" });
    expect(markup).toMatch(/<option value="writer" selected="">Writer<\/option>/u);
    expect(markup).toMatch(/<option value="weekdays" selected="">/u);
    expect(markup).toMatch(/<option value="Europe\/Berlin" selected="">/u);
    expect(markup).toContain('value="08:00"');
  });

  it("opens a saved custom cron as written", () => {
    const markup = renderDialog({
      scheduledStartId: "sched_1",
      prompt: "Check",
      cron: "*/15 9-17 * * 1-5",
      timeZone: "UTC"
    });
    expect(markup).toContain('value="*/15 9-17 * * 1-5"');
    expect(markup).toMatch(/<option value="UTC" selected="">/u);
  });
});

describe("an agent's call on a scheduled prompt", () => {
  it("reads only the calls on scheduled prompts, under either name", () => {
    expect(
      scheduledStartCall("scheduled_starts.create", {
        collaborationWorkspaceId: "ws_1",
        agentName: "support",
        prompt: "Check",
        cron: "0 8 * * 1-5",
        timeZone: "Europe/Berlin"
      })
    ).toMatchObject({ verb: "create", agentName: "support" });
    expect(
      scheduledStartCall("platform.scheduled_starts.set_state", {
        scheduledStartId: "sched_1",
        state: "paused"
      })
    ).toEqual({ verb: "set_state", scheduledStartId: "sched_1", state: "paused" });
    expect(scheduledStartCall("scheduled_starts.delete", {})).toBeUndefined();
    expect(
      scheduledStartCall("scheduled_starts.run_now", { scheduledStartId: "x" })
    ).toBeUndefined();
    expect(scheduledStartCall("assets.put", { agentName: "a" })).toBeUndefined();
  });

  const agentName = (name: string) => (name === "support" ? "Support assistant" : name);

  it("confirms a new one in words, the raw input only under the details", () => {
    const call = scheduledStartCall("scheduled_starts.create", {
      collaborationWorkspaceId: "ws_1",
      agentName: "support",
      prompt: "Fasse die Tickets zusammen.",
      cron: "0 8 * * 1-5",
      timeZone: "Europe/Berlin"
    });
    if (!call) throw new Error("The call was not read");
    const markup = inLocale(
      "en",
      createElement(ToolDecisionCardView, {
        decision: {
          toolCallId: "call_1",
          operationRunId: "oprun_1",
          operationId: "scheduled_starts.create",
          mode: "confirm",
          inputPreview: { agentName: "support" },
          expiresAt: "2026-10-20T18:30:00Z"
        },
        title: "Prompt planen",
        toolName: "scheduled_starts.create",
        answer: { decide: noop, pending: false, decided: undefined, failure: undefined },
        summary: createElement(ScheduledStartSummaryView, { call, agentName })
      })
    );
    expect(text(markup)).toContain("Support assistant");
    const summaryAt = markup.indexOf('data-testid="scheduled-confirmation"');
    const detailsAt = markup.indexOf('data-testid="tool-decision-details"');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(detailsAt);
    expect(markup.slice(0, detailsAt)).not.toContain('data-input-key="agentName"');
  });

  it("names the saved prompt a pause or delete acts on, never its id", () => {
    const pause = inLocale(
      "en",
      createElement(ScheduledStartSummaryView, {
        call: { verb: "set_state", scheduledStartId: "sched_1", state: "paused" },
        saved: start,
        agentName
      })
    );
    expect(text(pause)).toContain("Summarise yesterday's new support tickets");
    expect(pause).not.toContain("sched_1");
    const remove = text(
      inLocale(
        "en",
        createElement(ScheduledStartSummaryView, {
          call: { verb: "delete", scheduledStartId: "sched_9" },
          saved: undefined,
          agentName
        })
      )
    );
    expect(remove).not.toContain("sched_9");
  });
});
