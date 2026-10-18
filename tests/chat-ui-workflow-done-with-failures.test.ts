import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  LoopEntriesView,
  StepPanel,
  WorkflowRunPageView,
  WorkflowRunsPageView,
  WorkflowsPageView,
  createInstanceSource,
  placedSteps,
  toWorkflow,
  toWorkflowListItem,
  toWorkflowRun,
  toWorkflowStepRun,
  workflowGraph,
  type WorkflowRunList,
  type WorkflowRunRead
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// REH-FIX-1: a run that ended `done` while something below it failed is no plain green "Done"
// on any surface: the runs list, the Workflow card, the run page with its banner, the loop's
// panel and its entry rows. The list and the card hold no step runs, so the instance's counts
// speak there: the run's own failed items, and the runs with failures below it. The run page
// reads its loops' counts, those of loops inside an entry of another loop too, and falls back
// to the run's own count of failed items, then to the count below.

const en = createTranslationContext("en");
const german = createTranslationContext("de");
const { t } = en;
const de = german.t;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const now = new Date("2026-10-12T09:12:00.000Z");
const noop = () => undefined;
const { signal } = new AbortController();

type RunResource = Parameters<typeof toWorkflowRun>[0];
type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];
type Step = Record<string, unknown>;

const child = (id: string): Step => ({
  id,
  name: "Check the client",
  type: "workflow",
  workflow: "client-check",
  input: {}
});
const send: Step = {
  id: "send",
  name: "Send",
  type: "operation",
  operation: "connection.crm.write"
};
const innerLoop = (steps: readonly Step[]): Step => ({
  id: "each_contact",
  name: "For each contact",
  type: "loop",
  items: { step: "clients", path: "" },
  steps
});

/** "Notify clients": a start, a read, a loop over the clients with the given body. */
function workflowWith(body: readonly Step[], loop: Step = {}) {
  return toWorkflow({
    name: "notify-clients",
    publishedRevision: 1,
    config: {
      id: "notify-clients",
      name: "Notify clients",
      inputs: { type: "object" },
      outputs: { type: "object" },
      wiring: [],
      steps: [
        { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "clients", name: "Load", type: "operation", operation: "connection.crm.list" },
        {
          id: "each_client",
          name: "For each client",
          type: "loop",
          items: { step: "clients", path: "" },
          steps: body,
          ...loop
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    }
  });
}

function run(input: Partial<RunResource> = {}): RunResource {
  return {
    id: "wr_1",
    workflow: "notify-clients",
    trigger: "manual",
    status: "done",
    startedBy: { id: "user_1", label: "Ada Lovelace" },
    createdAt: "2026-10-12T09:00:00.000Z",
    startedAt: "2026-10-12T09:00:01.000Z",
    finishedAt: "2026-10-12T09:00:42.000Z",
    ...input
  };
}

function stepRun(
  input: Partial<StepRunResource> & Pick<StepRunResource, "id" | "stepId">
): StepRunResource {
  return {
    stepType: "operation",
    status: "done",
    attempt: 1,
    createdAt: "2026-10-12T09:00:01.000Z",
    startedAt: "2026-10-12T09:00:01.000Z",
    finishedAt: "2026-10-12T09:00:05.000Z",
    ...input
  };
}

const startStep = stepRun({ id: "sr_start", stepId: "start", stepType: "trigger" });
const outerLoop = (failed: number, total = 600) =>
  stepRun({
    id: "sr_loop",
    stepId: "each_client",
    stepType: "loop",
    loop: { total, done: total - failed, failed, running: 0 }
  });
/** The step run of the inner loop in one entry of the outer loop. */
const entryLoop = (index: number, failed: number) =>
  stepRun({
    id: `sr_contacts_${String(index)}`,
    stepId: "each_contact",
    stepType: "loop",
    containerStepRunId: "sr_loop",
    iteration: { index, label: `Client ${String(index)}` },
    loop: { total: 4, done: 4 - failed, failed, running: 0 }
  });

function read(
  resource: RunResource,
  stepRuns: readonly StepRunResource[] | undefined,
  entryLoops: readonly StepRunResource[] = []
): WorkflowRunRead {
  return {
    run: toWorkflowRun(resource),
    problem: undefined,
    silentSince: undefined,
    stepRuns: stepRuns?.map(toWorkflowStepRun),
    entryLoops: entryLoops.map(toWorkflowStepRun),
    stepRunsCut: false,
    retry: noop
  };
}

const runPage = (
  runRead: WorkflowRunRead,
  workflow: ReturnType<typeof workflowWith> | undefined,
  locale: "en" | "de" = "en"
) =>
  render(
    createElement(WorkflowRunPageView, {
      workspaceId: "cw_1",
      workflowId: "notify-clients",
      workflow,
      read: runRead,
      now,
      canCancel: false,
      canRunAgain: false,
      stopping: false,
      onCancel: noop,
      onRunAgain: noop,
      onOpenRoute: noop
    }),
    locale
  );

const noShowButton = (markup: string) => {
  expect(markup).not.toContain(t("workflows.run.showFailedChildRuns"));
  expect(markup).not.toContain(t("workflows.run.showFailedEntries"));
};

describe("the list and the card of a Workflow", () => {
  const fanOut = workflowWith([child("check")]);
  const runList = (rows: WorkflowRunList["rows"]): WorkflowRunList => ({
    rows,
    failed: false,
    hasMore: false,
    loadingMore: false,
    loadMore: noop,
    retry: noop
  });
  const runsPage = (rows: readonly RunResource[], locale: "en" | "de" = "en") =>
    render(
      createElement(WorkflowRunsPageView, {
        workspaceId: "cw_1",
        workflowId: "notify-clients",
        workflow: fanOut,
        runs: runList(rows.map(toWorkflowRun)),
        runsAvailable: true,
        now,
        onStart: noop,
        onOpenRoute: noop
      }),
      locale
    );

  it("warns on a row that ended done over one failed child among 600, and never folds it", () => {
    const rows = [
      run({ id: "wr_4", failedDescendantCount: 1 }),
      run({ id: "wr_3", empty: true }),
      run({ id: "wr_2", empty: true, failedDescendantCount: 1 }),
      run({ id: "wr_1", empty: true })
    ];
    const markup = runsPage(rows);
    expect(markup.split(t("workflows.run.doneWithFailures"))).toHaveLength(3);
    // An empty run with failed runs below it stands: the two plain empty ones are apart.
    expect(markup).not.toContain("data-empty-runs=");
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients/runs/wr_2"');
    expect(runsPage(rows, "de")).toContain(de("workflows.run.doneWithFailures"));
    const clean = runsPage([run({ id: "wr_9" })]);
    expect(clean).toContain(`>${t("workflows.run.done")}<`);
    expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
  });

  it("warns on a row whose own loop failed an item, with no run with failures below", () => {
    const rows = [
      run({ id: "wr_3", empty: true }),
      run({ id: "wr_2", empty: true, failedItemCount: 1, failedDescendantCount: 0 }),
      run({ id: "wr_1", empty: true })
    ];
    for (const [locale, text] of [
      ["en", t],
      ["de", de]
    ] as const) {
      const markup = runsPage(rows, locale);
      expect(markup.split(text("workflows.run.doneWithFailures"))).toHaveLength(2);
      // It stands between the empty runs, which therefore do not fold.
      expect(markup).not.toContain("data-empty-runs=");
      expect(markup).toContain('href="/w/cw_1/workflows/notify-clients/runs/wr_2"');
    }
    const clean = runsPage([run({ id: "wr_9", failedItemCount: 0, failedDescendantCount: 0 })]);
    expect(clean).toContain(`>${t("workflows.run.done")}<`);
    expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
  });

  const card = (
    counts: { failedDescendantCount?: number; failedItemCount?: number },
    locale: "en" | "de" = "en"
  ) =>
    render(
      createElement(WorkflowsPageView, {
        workspaceId: "cw_1",
        list: {
          rows: [
            toWorkflowListItem({
              id: "notify-clients",
              name: "Notify clients",
              lastRun: {
                id: "wr_9",
                status: "done",
                startedAt: "2026-10-12T09:00:00.000Z",
                ...counts
              }
            })
          ],
          failed: false,
          hasMore: false,
          loadingMore: false,
          loadMore: noop,
          retry: noop
        },
        now,
        runsAvailable: true,
        onOpenRoute: noop,
        onStart: noop
      }),
      locale
    );

  it("warns on a card whose last run ended done over one failed child among 600", () => {
    const warned = card({ failedDescendantCount: 1 });
    expect(warned).toContain(t("workflows.run.doneWithFailures"));
    expect(warned).not.toContain(`>${t("workflows.run.done")}<`);
    // An instance that sends no count yet reads as nothing failed below.
    for (const clean of [card({ failedDescendantCount: 0 }), card({})]) {
      expect(clean).toContain(`>${t("workflows.run.done")}<`);
      expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
    }
  });

  it("warns on a card whose last run's own loop failed an item, in English and German", () => {
    const own = { failedItemCount: 1, failedDescendantCount: 0 };
    const warned = card(own);
    expect(warned).toContain(t("workflows.run.doneWithFailures"));
    expect(warned).not.toContain(`>${t("workflows.run.done")}<`);
    const german = card(own, "de");
    expect(german).toContain(de("workflows.run.doneWithFailures"));
    expect(german).not.toContain(`>${de("workflows.run.done")}<`);
    const clean = card({ failedItemCount: 0, failedDescendantCount: 0 });
    expect(clean).toContain(`>${t("workflows.run.done")}<`);
    expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
  });
});

describe("the page of a run that ended done with failures below its own loops", () => {
  it("warns on a nested loop whose inner child run failed, without a made-up total or link", () => {
    const markup = runPage(
      read(run({ failedDescendantCount: 1 }), [startStep, outerLoop(0)]),
      workflowWith([innerLoop([child("check")])])
    );
    expect(markup).toContain(t("workflows.run.doneWithFailures"));
    expect(markup).toContain(t("workflows.run.failedDescendantRunsOne", { count: "1" }));
    expect(markup).not.toContain("of 600");
    noShowButton(markup);
  });

  it("warns on a nested loop's failed operation entry with no failed run below", () => {
    const markup = runPage(
      read(
        run({ failedDescendantCount: 0 }),
        [startStep, outerLoop(0)],
        [entryLoop(0, 0), entryLoop(1, 1), entryLoop(2, 0)]
      ),
      workflowWith([innerLoop([send])])
    );
    expect(markup).toContain(t("workflows.run.doneWithFailures"));
    // Every loop's entries together: 600 clients and 3 × 4 contacts.
    expect(markup).toContain(t("workflows.run.failedEntriesOne", { count: "1", total: "612" }));
    // The canvas cannot select one entry of the outer loop: no button leads there.
    noShowButton(markup);
  });

  it("warns on a child run that ended done over a failed child of its own, in German too", () => {
    const single = workflowWith([], { type: "workflow", workflow: "client-check" });
    const page = (locale: "en" | "de", failedDescendantCount: number) =>
      runPage(
        read(run({ failedDescendantCount }), [
          startStep,
          stepRun({ id: "sr_child", stepId: "each_client", stepType: "workflow" })
        ]),
        single,
        locale
      );
    expect(page("en", 3)).toContain(t("workflows.run.failedDescendantRunsMany", { count: "3" }));
    expect(page("de", 1)).toContain(de("workflows.run.doneWithFailures"));
    expect(page("de", 1)).toContain(de("workflows.run.failedDescendantRunsOne", { count: "1" }));
    const clean = page("en", 0);
    expect(clean).toContain(t("workflows.run.done"));
    expect(clean).not.toContain("data-run-failed-entries");
  });

  it("shows the warning before the step runs arrived where the run counts failed runs below", () => {
    const markup = runPage(
      read(run({ failedDescendantCount: 1 }), undefined),
      workflowWith([child("check")])
    );
    expect(markup).toContain(t("workflows.run.doneWithFailures"));
  });

  it("counts the run's own failed items before the step runs arrived, as no runs below", () => {
    const page = (locale: "en" | "de", failedItemCount: number) =>
      runPage(
        read(run({ failedItemCount, failedDescendantCount: failedItemCount }), undefined),
        workflowWith([child("check")]),
        locale
      );
    const one = page("en", 1);
    expect(one).toContain(t("workflows.run.doneWithFailures"));
    // The banner says this one sentence: no total, and no runs below. The page cannot tell yet
    // whether the items are child runs, nor of how many.
    expect(one).toContain(`>${t("workflows.run.failedItemsOne", { count: "1" })}<`);
    noShowButton(one);
    expect(page("en", 2)).toContain(t("workflows.run.failedItemsMany", { count: "2" }));
    const german = page("de", 2);
    expect(german).toContain(de("workflows.run.doneWithFailures"));
    expect(german).toContain(de("workflows.run.failedItemsMany", { count: "2" }));
    expect(german).not.toContain(de("workflows.run.failedDescendantRunsMany", { count: "2" }));
  });

  it("reads the own loop's tally, not the bare item count, once the step runs arrived", () => {
    const markup = runPage(
      read(run({ failedItemCount: 1, failedDescendantCount: 0 }), [startStep, outerLoop(1)]),
      workflowWith([send])
    );
    expect(markup).toContain(t("workflows.run.failedEntriesOne", { count: "1", total: "600" }));
    expect(markup).not.toContain(t("workflows.run.failedItemsOne", { count: "1" }));
    expect(markup).toContain(t("workflows.run.showFailedEntries"));
  });

  it("names the own loop's failed child runs, with their button, before the count below", () => {
    const markup = runPage(
      read(run({ failedDescendantCount: 5 }), [startStep, outerLoop(1)]),
      workflowWith([child("check")])
    );
    expect(markup).toContain(t("workflows.run.failedChildRunsOne", { count: "1", total: "600" }));
    expect(markup).not.toContain(t("workflows.run.failedDescendantRunsMany", { count: "5" }));
    expect(markup).toContain(t("workflows.run.showFailedChildRuns"));
  });
});

describe("a loop's panel and its entries", () => {
  const fanOut = workflowWith([child("check")]);

  it("warns in the loop's panel where the loop ended done with failed entries", () => {
    const loopPanel = (failed: number, locale: "en" | "de" = "en") => {
      const held = [startStep, outerLoop(failed)].map(toWorkflowStepRun);
      const text = locale === "de" ? german : en;
      const graph = workflowGraph(fanOut.steps, text, {
        run: toWorkflowRun(run()),
        stepRuns: held,
        now
      });
      const step = placedSteps(fanOut.steps).get("each_client")?.step;
      const part = graph.groups.find((entry) => entry.id === "each_client");
      if (step === undefined || part === undefined) throw new Error("The Workflow has no loop.");
      return render(
        createElement(StepPanel, {
          step,
          part,
          run: { stepRun: held[1], counts: undefined, runDatasets: undefined, now },
          tab: "run",
          onTabChange: noop,
          entries: null,
          onClose: noop
        }),
        locale
      );
    };
    expect(loopPanel(1)).toContain(t("workflows.run.doneWithFailures"));
    expect(loopPanel(1, "de")).toContain(de("workflows.run.doneWithFailures"));
    const clean = loopPanel(0);
    expect(clean).toContain(`>${t("workflows.run.done")}<`);
    expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
  });

  it("warns on an entry row whose own loop ended done with failed entries", () => {
    const nested = workflowWith([innerLoop([send])]);
    const loop = placedSteps(nested.steps).get("each_client")?.step;
    if (loop === undefined) throw new Error("The Workflow has no loop.");
    const rows = (failed: number) =>
      render(
        createElement(LoopEntriesView, {
          loop,
          counts: { total: 600, done: 600, failed: 0, running: 0 },
          filter: "all",
          onFilterChange: noop,
          read: {
            stepRuns: [toWorkflowStepRun(entryLoop(0, failed))],
            failed: false,
            hasMore: false,
            loadingMore: false,
            loadMore: noop,
            retry: noop
          },
          onOpenChild: noop
        })
      );
    expect(rows(1)).toContain(t("workflows.run.doneWithFailures"));
    expect(rows(0)).not.toContain(t("workflows.run.doneWithFailures"));
  });
});

describe("the frame read of a run over the instance", () => {
  /** An instance whose run answers the given step runs in one page. */
  function frameOf(items: readonly StepRunResource[]) {
    const wire = items.map((entry) => ({ ...entry, runId: "wr_1", key: entry.stepId }));
    const { client } = recordedApiClient(({ operation }) =>
      operation === "workflows.list_step_runs" ? { items: wire } : undefined
    );
    const frame = createInstanceSource(client, "k").runs?.listFrameStepRuns("wr_1", signal);
    if (frame === undefined) throw new Error("The source has no runs.");
    return frame;
  }

  it("keeps a loop inside an entry, and warns where it failed with no failed run below", async () => {
    // The inner loop went on past a failed note; no child run exists to count.
    const frame = await frameOf([
      startStep,
      outerLoop(0, 2),
      entryLoop(1, 1),
      // An ordinary entry row: one of many, never part of the frame.
      stepRun({ id: "sr_send", stepId: "send", iteration: { index: 0 } })
    ]);
    expect(frame.stepRuns.map((entry) => entry.id)).toEqual(["sr_start", "sr_loop"]);
    expect(frame.entryLoops.map((entry) => entry.id)).toEqual(["sr_contacts_1"]);
    const markup = runPage(
      {
        ...read(run({ failedDescendantCount: 0 }), []),
        stepRuns: frame.stepRuns,
        entryLoops: frame.entryLoops,
        stepRunsCut: !frame.complete
      },
      workflowWith([innerLoop([send])])
    );
    expect(markup).toContain(t("workflows.run.doneWithFailures"));
    expect(markup).toContain(t("workflows.run.failedEntriesOne", { count: "1", total: "6" }));
    noShowButton(markup);
  });
});
