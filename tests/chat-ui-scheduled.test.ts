import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  DEFAULT_SCHEDULE,
  ScheduledDialog,
  ScheduledPageView,
  ScheduledStartCard,
  ScheduledStartSummaryView,
  choiceOf,
  cronLooksValid,
  cronOf,
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
const de = createTranslationContext("de");

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

function inLocale(locale: "en" | "de", node: ReactNode): string {
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
    expect(cronOf({ ...DEFAULT_SCHEDULE, preset: "weekly", weekday: 5, time: "17:30" })).toBe(
      "30 17 * * 5"
    );
    expect(cronOf({ ...DEFAULT_SCHEDULE, preset: "monthly", time: "09:00" })).toBe("0 9 1 * *");
    for (const cron of ["30 7 * * *", "0 8 * * 1-5", "30 17 * * 5", "0 9 1 * *"]) {
      expect(cronOf(choiceOf(cron))).toBe(cron);
    }
    expect(choiceOf("*/15 * * * *")).toMatchObject({ preset: "custom", cron: "*/15 * * * *" });
  });

  it("refuses what is plainly no five-field cron before saving", () => {
    expect(cronLooksValid("0 8 * * 1-5")).toBe(true);
    expect(cronLooksValid("*/15 9-17 * * MON-FRI")).toBe(true);
    expect(cronLooksValid("0 8 * *")).toBe(false);
    expect(cronLooksValid("every day")).toBe(false);
    expect(cronLooksValid("0 8 * * 1; rm")).toBe(false);
  });

  it("says the schedule with its zone in English and German, a custom one as written", () => {
    expect(scheduleLine(start, en)).toBe("Every weekday, 08:00 AM (Europe/Berlin)");
    expect(scheduleLine(start, de)).toBe("Werktags, 08:00 (Europe/Berlin)");
    expect(scheduleLine({ cron: "0 9 * * 1", timeZone: "UTC" }, de)).toBe(
      "Jeden Montag, 09:00 (UTC)"
    );
    expect(scheduleLine({ cron: "*/15 * * * *", timeZone: "UTC" }, en)).toBe(
      "Custom: */15 * * * * (UTC)"
    );
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

function renderPage(list: ScheduledList, locale: "en" | "de" = "en"): string {
  return inLocale(
    locale,
    createElement(ScheduledPageView, {
      list,
      onNew: noop,
      renderStart: (row) => createElement("p", { "data-row": row.id }, row.prompt)
    })
  );
}

describe("the Scheduled page", () => {
  it("holds a delayed skeleton while the list loads, and New stays", () => {
    const markup = renderPage(loaded(undefined));
    expect(markup).toContain("Schedule a prompt");
    expect(markup).not.toContain("data-row");
    expect(markup).toContain('aria-busy="true"');
  });

  it("says a failed read in place, with the way to read again", () => {
    const markup = renderPage(loaded(undefined, { failed: true }));
    expect(markup).toContain("data-load-error");
    expect(text(markup)).toContain("Your scheduled prompts could not be loaded.");
  });

  it("offers two concrete examples when empty, in German too", () => {
    const markup = text(renderPage(loaded([]), "de"));
    expect(markup).toContain("Noch nichts geplant.");
    expect(markup).toContain("Jeden Werktag um 08:00");
    expect(markup).toContain("Fasse die neuen Support-Tickets von gestern zusammen");
    expect(markup.match(/Prompt planen/gu)).toHaveLength(1);
  });

  it("lists each saved prompt once", () => {
    const markup = renderPage(loaded([start, { ...start, id: "sched_2" }]));
    expect(markup.match(/data-row=/gu)).toHaveLength(2);
  });
});

const runsOf = (runs: ScheduledRun[] | undefined, failed = false): ScheduledRuns => ({
  runs,
  failed,
  retry: noop
});

function renderCard(
  input: {
    start?: ScheduledStart;
    runs?: ScheduledRuns;
    connections?: boolean;
    feedback?: Parameters<typeof ScheduledStartCard>[0]["feedback"];
  },
  locale: "en" | "de" = "en"
): string {
  return inLocale(
    locale,
    createElement(ScheduledStartCard, {
      start: input.start ?? start,
      agentLabel: "Support assistant",
      runs: input.runs ?? runsOf([]),
      busy: undefined,
      feedback: input.feedback,
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
  it("shows its heading, agent, schedule, next run and its actions, without ids", () => {
    const markup = renderCard({});
    const words = text(markup);
    expect(words).toContain("Summarise yesterday's new support tickets");
    expect(words).toContain("Support assistant · Every weekday, 08:00 AM (Europe/Berlin)");
    expect(words).toContain("Next run:");
    expect(words).toContain("Not run yet.");
    expect(words).toContain("Run now");
    expect(words).toContain("Pause");
    expect(words).not.toContain("sched_1");
    expect(words).not.toContain("0 8 * * 1-5");
  });

  it("marks a paused one and offers Resume in place of Pause and the next run", () => {
    const words = text(renderCard({ start: { ...start, state: "paused", nextRunAt: null } }, "de"));
    expect(words).toContain("Pausiert");
    expect(words).toContain("Fortsetzen");
    expect(words).not.toContain("Nächster Lauf");
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
    const words = text(markup);
    expect(words).toContain("Running");
    expect(words).toContain("Done");
    expect(words).toContain("Skipped: the run before was still going.");
  });

  it("explains that the next times are skipped while a run waits for a decision", () => {
    const runs = runsOf([
      run({ id: "r2", status: "skipped", reason: "waiting_for_decision" }),
      run({ id: "r1", status: "waiting_for_decision", conversationId: "conv_1" })
    ]);
    const markup = renderCard({ runs }, "de");
    expect(markup).toContain('data-testid="scheduled-waiting"');
    expect(text(markup)).toContain(
      "Bis du entscheidest, werden die nächsten Termine übersprungen."
    );
    expect(markup.match(/href="\/w\/ws_1\/c\/conv_1"/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it("asks to reconnect a personal connection, linking only where the person can open it", () => {
    const runs = runsOf([
      run({ id: "r1", status: "failed", reason: "connection_needs_reconnect" })
    ]);
    const linked = renderCard({ runs, connections: true });
    expect(text(linked)).toContain("needs you to sign in again. Reconnect it, then run again.");
    expect(linked).toContain('href="/build/connections"');
    expect(renderCard({ runs })).not.toContain('href="/build/connections"');
  });

  it("says the outcome of an action under its buttons, and a failed read of runs with retry", () => {
    const done = renderCard({ feedback: { tone: "success", text: "scheduled.runStarted" } });
    expect(text(done)).toContain("Started. The run shows under Recent runs in a moment.");
    const failed = renderCard({ runs: runsOf(undefined, true) });
    expect(text(failed)).toContain("The runs could not be loaded.");
  });
});

function renderDialog(
  draft: Parameters<typeof ScheduledDialog>[0]["draft"],
  locale: "en" | "de" = "en",
  more: Partial<Parameters<typeof ScheduledDialog>[0]> = {}
): string {
  return inLocale(
    locale,
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
      onClose: noop,
      ...more
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
    expect(text(markup)).toContain("Every weekday, 08:00 AM (Europe/Berlin)");
    // A scheduled prompt has no name of its own.
    expect(text(markup)).not.toMatch(/\bName\b/u);
  });

  it("opens a saved custom cron as written with the common-syntax help", () => {
    const markup = renderDialog(
      { scheduledStartId: "sched_1", prompt: "Check", cron: "*/15 9-17 * * 1-5", timeZone: "UTC" },
      "de"
    );
    const words = text(markup);
    expect(words).toContain("Geplanten Prompt bearbeiten");
    expect(words).toContain("Übliche Cron-Syntax");
    expect(markup).toContain('value="*/15 9-17 * * 1-5"');
    expect(markup).toMatch(/<option value="UTC" selected="">/u);
    expect(words).toContain("Speichern");
  });

  it("keeps what was written and says a failed save above the buttons", () => {
    const markup = renderDialog({ prompt: "Check" }, "en", { failed: true });
    expect(text(markup)).toContain("It could not be saved.");
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

  it("confirms a new one in German as agent, prompt and when, with no field names", () => {
    const call = scheduledStartCall("scheduled_starts.create", {
      collaborationWorkspaceId: "ws_1",
      agentName: "support",
      prompt: "Fasse die Tickets zusammen.",
      cron: "0 8 * * 1-5",
      timeZone: "Europe/Berlin"
    });
    if (!call) throw new Error("The call was not read");
    const markup = inLocale(
      "de",
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
    const words = text(markup);
    expect(words).toContain("Agent Support assistant");
    expect(words).toContain("Fasse die Tickets zusammen.");
    expect(words).toContain("Wann Werktags, 08:00 (Europe/Berlin)");
    expect(words).toContain("Läuft als Du, mit deinen Rechten zum Zeitpunkt jedes Laufs");
    // The raw input stands only under the details.
    const summaryAt = markup.indexOf('data-testid="scheduled-confirmation"');
    const detailsAt = markup.indexOf('data-testid="tool-decision-details"');
    expect(summaryAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeLessThan(detailsAt);
    expect(markup.slice(0, detailsAt)).not.toContain('data-input-key="agentName"');
  });

  it("names the saved prompt a pause or delete acts on, never its id", () => {
    const pause = inLocale(
      "de",
      createElement(ScheduledStartSummaryView, {
        call: { verb: "set_state", scheduledStartId: "sched_1", state: "paused" },
        saved: start,
        agentName
      })
    );
    expect(text(pause)).toContain("Summarise yesterday's new support tickets");
    expect(text(pause)).toContain("Pausieren: Er läuft nicht, bis er fortgesetzt wird.");
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
    expect(remove).toContain("One of your scheduled prompts");
    expect(remove).toContain("Delete it. The conversations it already started stay.");
    expect(remove).not.toContain("sched_9");
  });
});
