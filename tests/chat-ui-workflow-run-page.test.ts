import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  LoopEntriesView,
  StartDialog,
  StepPanel,
  WorkflowRunPageView,
  placedSteps,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  workflowGraph,
  type WorkflowRunRead
} from "@vivd-catalyst/chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// What the design review asked of the run page and of a step: a next action on a run that has
// ended, a sentence on what to do about a failure, an operation step that never says "reads or
// changes", a starting step that says who started the run, and a filter that shows its real
// count. A step says these in its panel and on its node of the drawing.

const en = createTranslationContext("en");
const german = createTranslationContext("de");
const { t } = en;
const de = german.t;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const now = new Date("2026-10-12T09:12:00.000Z");
const noop = () => undefined;

type RunResource = Parameters<typeof toWorkflowRun>[0];
type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];

const steps = [
  { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
  { id: "clients", name: "Load the clients", type: "operation", operation: "connection.crm.list" },
  {
    id: "each_client",
    name: "For each client",
    type: "loop",
    items: { step: "clients", path: "" },
    itemName: "client",
    steps: [
      { id: "send", name: "Send the note", type: "operation", operation: "connection.crm.write" }
    ]
  },
  { id: "result", name: "Result", type: "output", input: {} }
];
const definitionOf = (changed: Record<string, Record<string, unknown>> = {}) => ({
  id: "notify-clients",
  name: "Notify clients",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: steps.map((step) => ({ ...step, ...changed[step.id] })),
  wiring: []
});
const workflowOf = (changed?: Record<string, Record<string, unknown>>) =>
  toWorkflow({ name: "notify-clients", config: definitionOf(changed), publishedRevision: 1 });

function run(input: Partial<RunResource> = {}): RunResource {
  return {
    id: "wr_1",
    workflow: "notify-clients",
    trigger: "manual",
    status: "running",
    startedBy: { id: "user_1", label: "Ada Lovelace" },
    createdAt: "2026-10-12T09:00:00.000Z",
    startedAt: "2026-10-12T09:00:01.000Z",
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

function read(resource: RunResource, stepRuns: readonly StepRunResource[]): WorkflowRunRead {
  return {
    run: toWorkflowRun(resource),
    problem: undefined,
    silentSince: undefined,
    stepRuns: stepRuns.map(toWorkflowStepRun),
    retry: noop
  };
}

/** The panel of one step, on the tab of what the run made of it. */
function panel(
  stepId: string,
  resource: RunResource,
  stepRuns: readonly StepRunResource[],
  options: {
    tab?: "what" | "run";
    workflow?: ReturnType<typeof workflowOf>;
    locale?: "en" | "de";
  } = {}
): string {
  const workflow = options.workflow ?? workflowOf();
  const text = options.locale === "de" ? german : en;
  const held = stepRuns.map(toWorkflowStepRun);
  const graph = workflowGraph(workflow.steps, text, {
    run: toWorkflowRun(resource),
    stepRuns: held,
    now
  });
  const step = placedSteps(workflow.steps).get(stepId)?.step;
  const part = [...graph.nodes, ...graph.groups].find((entry) => entry.id === stepId);
  if (step === undefined || part === undefined) {
    throw new Error(`The Workflow has no step ${stepId}.`);
  }
  return render(
    createElement(StepPanel, {
      step,
      part,
      run: { stepRun: held.find((entry) => entry.stepId === stepId), counts: undefined, now },
      tab: options.tab ?? "run",
      onTabChange: noop,
      entries: null,
      onClose: noop
    }),
    options.locale
  );
}

const runPage = (
  runRead: WorkflowRunRead,
  options: {
    canRunAgain?: boolean;
    canCancel?: boolean;
    workflow?: ReturnType<typeof workflowOf>;
  } = {}
) =>
  createElement(WorkflowRunPageView, {
    workspaceId: "cw_1",
    workflowId: "notify-clients",
    workflow: options.workflow ?? workflowOf(),
    read: runRead,
    now,
    canCancel: options.canCancel ?? false,
    canRunAgain: options.canRunAgain ?? true,
    stopping: false,
    onCancel: noop,
    onRunAgain: noop,
    onOpenRoute: noop
  });

const startStep = stepRun({
  id: "sr_start",
  stepId: "start",
  stepType: "trigger",
  finishedAt: "2026-10-12T09:00:01.000Z"
});
const failedStep = (code: string) =>
  stepRun({
    id: "sr_clients",
    stepId: "clients",
    status: "failed",
    error: { code, message: "The instance's own sentence" }
  });
const ended = { finishedAt: "2026-10-12T09:00:42.000Z" };

describe("the next action on a run that has ended", () => {
  it.each(["done", "failed", "cancelled", "limit_reached"] as const)(
    "offers to run a %s run again to whoever may start the Workflow",
    (status) => {
      const markup = render(runPage(read(run({ status, ...ended }), [startStep])));
      expect(markup).toContain(t("workflows.run.again"));
      expect(
        render(runPage(read(run({ status, ...ended }), [startStep]), { canRunAgain: false }))
      ).not.toContain(t("workflows.run.again"));
    }
  );

  it("does not offer it while the run is going", () => {
    const markup = render(runPage(read(run(), [startStep]), { canCancel: true }));
    expect(markup).not.toContain(t("workflows.run.again"));
    expect(markup).toContain(t("workflows.run.cancel"));
  });

  it("asks once and says that this run stays as it is", () => {
    const dialog = (locale: "en" | "de" = "en") =>
      render(
        createElement(StartDialog, {
          name: "Notify clients",
          again: true,
          loading: false,
          error: undefined,
          onConfirm: noop,
          onClose: noop
        }),
        locale
      );
    expect(dialog()).toContain(t("workflows.run.againTitle", { name: "Notify clients" }));
    expect(dialog()).toContain(t("workflows.run.againBody"));
    expect(dialog("de")).toContain(de("workflows.run.againBody"));
  });

  it("says what to do about a run that a limit stopped, in both languages", () => {
    const limited = read(
      run({ status: "limit_reached", ...ended, error: { code: "duration_limit", message: "x" } }),
      [startStep]
    );
    expect(render(runPage(limited))).toContain(t("workflows.advice.durationLimit"));
    expect(render(runPage(limited), "de")).toContain(de("workflows.advice.durationLimit"));
  });
});

describe("the panel of a step that failed", () => {
  it.each([
    ["FORBIDDEN", "missingRight"],
    ["POLICY_DENIED", "policy"],
    ["operation_would_wait", "needsApproval"],
    ["principal_inactive", "accountInactive"],
    ["operation_not_found", "operationMissing"],
    ["reference_unresolved", "dataMismatch"],
    ["output_invalid", "outputInvalid"],
    ["step_data_too_large", "tooMuchData"],
    ["operation_interrupted", "interrupted"],
    ["step_crashed", "crashed"],
    ["some_code_of_an_outside_system", "other"]
  ] as const)("says for %s what happened and what to do", (code, reason) => {
    const failed = run({ status: "failed", ...ended, error: { code, message: "x" } });
    const markup = panel("clients", failed, [startStep, failedStep(code)]);
    const happened = markup.indexOf(t(`workflows.reason.${reason}`));
    const advice = markup.indexOf(t(`workflows.advice.${reason}`));
    const details = markup.indexOf(t("workflows.technicalDetails"));
    expect(happened).toBeGreaterThan(-1);
    // What to do stands after what happened and above the technical details.
    expect(advice).toBeGreaterThan(happened);
    expect(details).toBeGreaterThan(advice);
    expect(markup).not.toContain(code);
  });

  it("says the same on the step's node of the drawing, and in German", () => {
    const failed = run({ status: "failed", ...ended });
    const graph = workflowGraph(workflowOf().steps, german, {
      run: toWorkflowRun(failed),
      stepRuns: [startStep, failedStep("FORBIDDEN")].map(toWorkflowStepRun),
      now
    });
    expect(graph.nodes.find((node) => node.id === "clients")).toMatchObject({
      status: "failed",
      footer: de("workflows.reason.missingRight")
    });
    expect(panel("clients", failed, [failedStep("FORBIDDEN")], { locale: "de" })).toContain(
      de("workflows.advice.missingRight")
    );
  });

  it("shows what a step returned and says where the instance cut it", () => {
    const returned = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: { text: `{"sent":2,"note":"${"x".repeat(200)}`, truncated: true }
    });
    const markup = panel("clients", run(), [returned]);
    expect(markup).toContain("&quot;sent&quot;:2");
    expect(markup).toContain(t("workflows.run.shortened"));
    expect(markup).toContain(t("workflows.run.done"));
  });
});

describe("what an operation step says it does", () => {
  const told = workflowOf({
    clients: { effect: "reading", source: "Client register" },
    each_client: {
      steps: [{ id: "send", name: "Send the note", type: "operation", effect: "changing" }]
    }
  });

  it("says that a step reads or that it changes, with what it works on, where the instance tells", () => {
    const graph = workflowGraph(told.steps, en);
    expect(graph.nodes.find((node) => node.id === "clients")).toMatchObject({
      eyebrow: t("workflows.step.reading"),
      chip: { label: "Client register" }
    });
    expect(graph.nodes.find((node) => node.id === "send")?.eyebrow).toBe(
      t("workflows.step.changing")
    );
    const markup = panel("clients", run(), [], { tab: "what", workflow: told });
    expect(markup).toContain(t("workflows.step.reading"));
    expect(markup).toContain(t("workflows.panel.readsFrom"));
    expect(markup).toContain("Client register");
    expect(workflowGraph(told.steps, german).nodes[1]?.eyebrow).toBe(de("workflows.step.reading"));
  });

  it("shows the step's name alone where the instance tells neither, never an either-or", () => {
    const graph = workflowGraph(workflowOf().steps, en);
    const clients = graph.nodes.find((node) => node.id === "clients");
    expect(clients).toMatchObject({
      title: "Load the clients",
      eyebrow: t("workflows.step.operation")
    });
    expect(clients?.chip).toBeUndefined();
    const markup = `${panel("clients", run(), [], { tab: "what" })}${panel("clients", run(), [], {
      tab: "what",
      locale: "de"
    })}`;
    expect(markup).toContain("Load the clients");
    expect(markup).not.toContain(t("workflows.step.reading"));
    expect(markup).not.toContain(t("workflows.step.changing"));
    expect(markup).not.toMatch(/Reads or|oder ändert/u);
  });
});

describe("the step that starts a run", () => {
  const first = (resource: RunResource, text = en) =>
    workflowGraph(workflowOf().steps, text, {
      run: toWorkflowRun(resource),
      stepRuns: [toWorkflowStepRun(startStep)],
      now
    }).nodes[0];

  it("says who started the run and when, and no duration", () => {
    const node = first(run());
    expect(node?.title).toBe(t("workflows.run.startStepPerson", { person: "Ada Lovelace" }));
    expect(node?.footer).toContain(
      new Date("2026-10-12T09:00:01.000Z").toLocaleTimeString("en", { timeStyle: "short" })
    );
    expect(node?.meta).toBeUndefined();
    expect(node?.title).not.toBe(t("workflows.schedule.manualOnly"));
  });

  it("names the schedule for a run nobody started by hand", () => {
    expect(first(run({ trigger: "schedule" }), german)?.title).toBe(
      de("workflows.run.startStepSchedule")
    );
  });
});

describe("the filter of a loop's entries", () => {
  const loop = placedSteps(workflowOf().steps).get("each_client")?.step;
  const failedEntry = toWorkflowStepRun(
    stepRun({
      id: "sr_0_send",
      stepId: "send",
      status: "failed",
      containerStepRunId: "sr_loop",
      iteration: { index: 0, label: "10432 · Müller GmbH" },
      error: { code: "FORBIDDEN", message: "x" }
    })
  );
  const list = (stepRuns: readonly (typeof failedEntry)[] | undefined, hasMore = false) => {
    if (loop === undefined) {
      throw new Error("The Workflow has no loop.");
    }
    return render(
      createElement(LoopEntriesView, {
        loop,
        counts: { total: 600, done: 209, failed: 120, running: 8 },
        filter: "failed",
        onFilterChange: noop,
        read: {
          stepRuns,
          failed: false,
          hasMore,
          loadingMore: false,
          loadMore: noop,
          retry: noop
        }
      })
    );
  };

  it("shows how many entries there are, not a capped count", () => {
    const markup = list([failedEntry]);
    expect(markup).toMatch(/role="radio"[^>]*>All<span[^>]*>600<\/span>/u);
    expect(markup).toMatch(/role="radio"[^>]*>Failed<span[^>]*>120<\/span>/u);
    expect(markup).not.toContain("99+");
  });

  it("names a failed entry by its label, with the step it failed at and why", () => {
    const markup = list([failedEntry], true);
    expect(markup).toContain("10432 · Müller GmbH");
    expect(markup).toContain(t("workflows.run.atStep", { step: "Send the note" }));
    expect(markup).toContain(t("workflows.reason.missingRight"));
    expect(markup).toContain(t("workflows.showMore"));
  });

  it("shows placeholders until the entries arrived, and says when there are none", () => {
    expect(list(undefined)).toContain("animate-pulse");
    expect(list([])).toContain(t("workflows.run.noEntries"));
  });
});
