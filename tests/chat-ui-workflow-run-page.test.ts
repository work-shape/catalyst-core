// @vitest-environment happy-dom

import type { ModelUsageRefusal } from "@work-shape/catalyst-core";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import {
  LoopEntriesView,
  StepPanel,
  StepTranscriptView,
  WorkflowPageView,
  WorkflowRunPageView,
  WorkflowRunsPageView,
  WorkflowsHostProvider,
  WorkflowsPageView,
  failureHappened,
  loopEntries,
  resolveWorkflowRights,
  placedSteps,
  startOffered,
  toWorkflow,
  toWorkflowListItem,
  toWorkflowRun,
  toWorkflowStepRun,
  workflowGraph,
  type StepRerunControl,
  type WorkflowRunList,
  type WorkflowRunRead
} from "@work-shape/catalyst-chat-ui/workflows";
import { definitionOf, workflowOf } from "./support/workflow-run-page-fixtures";
import { workflowsContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { failureAdvice } from "./support/chat-ui/studio-workflows";

// The run page, a step's panel, a loop's entries and the runs list of a Workflow: what a run
// says about how it ended and what to do, who may act on it, and what of the instance's data
// reaches the reader.

const en = createTranslationContext("en");
const german = createTranslationContext("de");
const { t } = en;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const now = new Date("2026-10-12T09:12:00.000Z");
const noop = () => undefined;

type RunResource = Parameters<typeof toWorkflowRun>[0];
type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];
type PanelRun = NonNullable<Parameters<typeof StepPanel>[0]["run"]>;
type Workflow = ReturnType<typeof toWorkflow>;

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

function read(
  resource: RunResource,
  stepRuns: readonly StepRunResource[] | undefined,
  entryLoops: readonly StepRunResource[] = []
): WorkflowRunRead {
  return {
    run: toWorkflowRun(resource),
    problem: undefined,
    silentSince: undefined,
    stepsFailed: false,
    stepRuns: stepRuns?.map(toWorkflowStepRun),
    entryLoops: entryLoops.map(toWorkflowStepRun),
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
    workflow?: Workflow;
    locale?: "en" | "de";
    /** The label of the Workflow's account, and the reader's instance actions in a host. */
    account?: string;
    instanceActions?: readonly string[];
    /** The transcript an open agent step's panel loaded. */
    transcript?: ReactNode;
    runExtra?: Partial<PanelRun>;
    rerun?: StepRerunControl;
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
  const stepPanel = createElement(StepPanel, {
    step,
    ...(options.account === undefined ? {} : { account: options.account }),
    part,
    run: {
      stepRun: held.find((entry) => entry.stepId === stepId),
      counts: undefined,
      runDatasets: toWorkflowRun(resource).datasets,
      now,
      ...options.runExtra
    },
    tab: options.tab ?? "run",
    onTabChange: noop,
    entries: null,
    ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
    ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
    onClose: noop
  });
  const actions = options.instanceActions;
  return render(
    actions === undefined
      ? stepPanel
      : createElement(WorkflowsHostProvider, {
          value: {
            rights: resolveWorkflowRights(
              { ...workflowsContext([]), instanceActions: [...actions] },
              undefined
            ),
            viewerId: "user_1",
            workspace: undefined,
            showRoute: noop
          },
          children: stepPanel
        }),
    options.locale
  );
}

const runPage = (
  runRead: WorkflowRunRead,
  options: { canRunAgain?: boolean; canCancel?: boolean; workflow?: Workflow } = {}
) =>
  createElement(WorkflowRunPageView, {
    workspaceId: "cw_1",
    workflowId: "notify-clients",
    workflow: options.workflow ?? workflowOf(),
    read: runRead,
    now,
    canCancel: options.canCancel ?? false,
    canRunAgain: options.canRunAgain ?? true,
    stopping: runRead.run?.stopping ?? false,
    onCancel: noop,
    onRunAgain: noop,
    onOpenRoute: noop
  });

const loopEntriesOf = (
  workflow: Workflow,
  stepRuns: readonly StepRunResource[] | undefined,
  options: {
    counts?: { total: number; done: number; failed: number; running: number };
    filter?: "all" | "failed";
    hasMore?: boolean;
  } = {}
) => {
  const loop = placedSteps(workflow.steps).get("each_client")?.step;
  if (loop === undefined) throw new Error("The Workflow has no loop.");
  return render(
    createElement(LoopEntriesView, {
      loop,
      counts: options.counts ?? { total: 600, done: 600, failed: 0, running: 0 },
      filter: options.filter ?? "all",
      onFilterChange: noop,
      read: {
        stepRuns: stepRuns?.map(toWorkflowStepRun),
        failed: false,
        hasMore: options.hasMore ?? false,
        loadingMore: false,
        loadMore: noop,
        retry: noop
      },
      onOpenChild: noop
    })
  );
};

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

describe("the next action on a run", () => {
  it("offers Run again on an ended run only to whoever may start the Workflow", () => {
    for (const status of ["done", "failed"] as const) {
      const ran = read(run({ status, ...ended }), [startStep]);
      expect(render(runPage(ran))).toContain(t("workflows.run.again"));
      expect(render(runPage(ran, { canRunAgain: false }))).not.toContain(t("workflows.run.again"));
    }
    const going = render(runPage(read(run(), [startStep]), { canCancel: true }));
    expect(going).not.toContain(t("workflows.run.again"));
    expect(going).toContain(t("workflows.run.cancel"));
  });

  it("says that a cancel waits for the call that is going, and offers no second cancel", () => {
    const markup = render(
      runPage(read(run({ cancelledAt: "2026-10-12T09:01:00.000Z" }), [startStep]), {
        canCancel: true
      })
    );
    expect(markup).toContain(t("workflows.run.stopping"));
    expect(markup).not.toContain(`>${t("workflows.run.cancel")}<`);
  });
});

describe("a run that a usage limit stopped", () => {
  const limited = (usageLimit?: ModelUsageRefusal) =>
    read(
      run({
        status: "limit_reached",
        ...ended,
        error: {
          code: "MODEL_USAGE_LIMIT_REACHED",
          message: "x",
          ...(usageLimit ? { usageLimit } : {})
        }
      }),
      [startStep]
    );

  // Fails without LU-5: the run said "took a different path" for a code the page did not know,
  // and nothing of which limit it was or when it resets.
  it("names the limit, when it resets and what to do, and still says a limit stopped it where none is named", () => {
    const markup = render(
      runPage(limited({ period: "month", metric: "costMicros", scope: "workspace" }))
    );
    expect(markup).toContain(
      t("refusals.usageLimitNamed", {
        period: t("runUsageLimitPeriodMonth"),
        metric: t("runUsageLimitMetricCostMicros"),
        scope: t("runUsageLimitScopeWorkspace"),
        reset: t("runUsageLimitResetMonth")
      })
    );
    expect(markup).toContain(t("workflows.advice.usageLimit"));
    const unnamed = render(runPage(limited()));
    expect(unnamed).toContain(t("workflows.reason.usageLimit"));
    expect(unnamed).toContain(t("workflows.advice.usageLimit"));
  });
});

describe("why a run or a step failed", () => {
  it.each([
    ["FORBIDDEN", "missingRight"],
    ["operation_interrupted", "interrupted"],
    ["some_code_of_an_outside_system", "other"]
  ] as const)("says for %s what happened and what to do, never the code", (code, reason) => {
    const failed = run({ status: "failed", ...ended, error: { code, message: "x" } });
    const markup = panel("clients", failed, [startStep, failedStep(code)]);
    const happened = markup.indexOf(t(`workflows.reason.${reason}`));
    const advice = markup.indexOf(
      t(`workflows.advice.${reason}`, { place: "Settings › API access" })
    );
    const details = markup.indexOf(t("workflows.technicalDetails"));
    expect(happened).toBeGreaterThan(-1);
    // What to do stands after what happened and above the technical details.
    expect(advice).toBeGreaterThan(happened);
    expect(details).toBeGreaterThan(advice);
    expect(markup).not.toContain(code);
  });

  // ACCEPT-1c B4: a run stopped by its technical account says where an administrator changes it.
  it("says where the technical account is changed", () => {
    const failed = run({
      status: "failed",
      ...ended,
      error: { code: "principal_inactive", message: "x" }
    });
    expect(panel("clients", failed, [startStep, failedStep("principal_inactive")])).toContain(
      "switches it on under Settings › API access"
    );
  });

  // ACCEPT-2a C7: a refusal names the account and the Connection, and tells an administrator
  // of technical accounts where to give the right instead of asking an administrator.
  it("names the account and the Connection of a refused step, and gives an admin the step", () => {
    const failed = run({ status: "failed", ...ended });
    const refused = stepRun({
      id: "sr_clients",
      stepId: "clients",
      status: "failed",
      source: "CRM",
      error: { code: "FORBIDDEN", message: "x", action: "connection.use" }
    });
    const options = { account: "Booking checks" };
    const admin = panel("clients", failed, [refused], {
      ...options,
      instanceActions: ["service_principals.manage"]
    });
    const member = panel("clients", failed, [refused], { ...options, instanceActions: [] });
    expect(admin).toContain("its account “Booking checks” may not use the Connection “CRM”.");
    expect(admin).toContain(
      "Under Settings › API access, allow the account “Booking checks” to use the Connection “CRM”"
    );
    // Whoever administers no account is still told to ask, and never told to ask by an admin.
    expect(member).toContain(t("workflows.advice.missingRight"));
    expect(admin).not.toContain(t("workflows.advice.missingRight"));
    // The node of the drawing names the Connection too.
    const graph = workflowGraph(workflowOf().steps, en, {
      run: toWorkflowRun(failed),
      stepRuns: [toWorkflowStepRun(refused)],
      now
    });
    expect(graph.nodes.find((node) => node.id === "clients")?.footer).toContain(
      "may not use the Connection “CRM”"
    );
  });

  // ACCEPT-2e C-3
  it("names the Connection by its title and the account on the step and the run", () => {
    const refused = {
      code: "FORBIDDEN",
      message: "may not",
      action: "connection.use",
      connection: "buchhaltung-kanzlei",
      connectionTitle: "Buchhaltung Kanzlei"
    };
    const failedRun = run({
      status: "failed",
      ...ended,
      principal: { displayLabel: "Workflow runner" },
      error: refused
    });
    const failedRemind = stepRun({
      id: "sr_clients",
      stepId: "clients",
      status: "failed",
      error: refused
    });
    const named = "its account “Workflow runner” may not use the Connection “Buchhaltung Kanzlei”";
    // The run's notice says it with what to do about it, although the failed step is held.
    const markup = render(runPage(read(failedRun, [startStep, failedRemind])));
    expect(markup).toContain(named);
    expect(markup).toContain("data-failure-advice");
    expect(markup).not.toContain("“buchhaltung-kanzlei”");
    const graph = workflowGraph(workflowOf().steps, en, {
      run: toWorkflowRun(failedRun),
      stepRuns: [toWorkflowStepRun(failedRemind)],
      now
    });
    expect(graph.nodes.find((node) => node.id === "clients")?.footer).toContain(named);
  });

  // WF-OUT
  it("tells a step refused for its Connection's exposure where to open it, never to grant a right", () => {
    const outside = {
      code: "FORBIDDEN",
      message:
        "'connection.buchhaltung-kanzlei.list_invoices' is not exposed to outside clients, and an outside client started this run. Expose it to outside clients on the Connection's page, or turn off starts by outside clients in the Workflow's settings",
      action: "connection_exposure:outside"
    };
    const failure = toWorkflowStepRun(
      stepRun({ id: "sr_clients", stepId: "clients", status: "failed", error: outside })
    ).failure;
    expect(failure).toMatchObject({
      reason: "notExposed",
      exposure: "outside",
      connection: "buchhaltung-kanzlei"
    });
    // The action no grant carries is never kept as a right to name.
    expect(failure?.action).toBeUndefined();
    if (failure === undefined) throw new Error("no failure");
    const admin = { administers: true, place: "Settings › API access" };
    // An administrator of accounts is told the same: no account's right opens it.
    expect(failureAdvice(failure, t, admin)).toContain("under “Callable by”");
    const markup = render(
      runPage(
        read(run({ status: "failed", ...ended, error: outside }), [
          startStep,
          stepRun({ id: "sr_clients", stepId: "clients", status: "failed", error: outside })
        ])
      )
    );
    expect(markup).toContain("does not let outside clients call this operation");
    for (const grant of ["lacks the right", "this right", "connection_exposure"]) {
      expect(markup).not.toContain(grant);
    }
    // Data of no Connection, which no exposure opens, and a sentence of another form, name none.
    for (const message of [
      "'knowledge.search' reads data that is not open to outside clients, and an outside client started the test run. To run this step, start the test run signed in to the app",
      "may not"
    ]) {
      const other = toWorkflowRun(
        run({ status: "failed", error: { ...outside, message } })
      ).failure;
      expect(other).toMatchObject({ reason: "notExposed", exposure: "outside" });
      expect(other?.connection).toBeUndefined();
    }
  });

  it("says why a test run a personal API key started failed, never with the right's id", () => {
    const failed = (code: string, action?: string) =>
      toWorkflowRun(
        run({
          status: "failed",
          error: { code, message: "The instance's sentence", ...(action ? { action } : {}) }
        })
      ).failure;
    expect(failed("tester_key_unusable")).toMatchObject({ reason: "testerKeyUnusable" });
    const scope = failed("tester_key_scope", "connection.use");
    expect(scope).toMatchObject({ reason: "testerKeyScope", action: "connection.use" });
    const cannotCarry = failed("tester_key_cannot_carry", "mail_sender.use");
    expect(cannotCarry && failureHappened(cannotCarry, t)).not.toContain("mail_sender.use");
    expect(scope && failureHappened(scope, t)).toContain("“Use connections”");
    // A right this interface has no words for is not named at all.
    expect(failureHappened({ reason: "testerKeyCannotCarry", action: "x.unknown" }, t)).toBe(
      t("workflows.reason.testerKeyCannotCarry")
    );
    const markup = render(
      runPage(
        read(
          run({ status: "failed", ...ended, error: { code: "tester_key_scope", message: "x" } }),
          []
        )
      )
    );
    expect(markup).toContain("Test the workflow");
    expect(markup).not.toContain("tester_key_scope");
  });

  it("names the Workflow whose run key is held in the step's own call chain, and nothing else", () => {
    const cycle = {
      code: "run_key_cycle",
      message: "The operation 'workflow.open-invoices.start' failed (run_key_cycle)"
    };
    const failure = toWorkflowStepRun(
      stepRun({
        id: "sr_cycle",
        stepId: "clients",
        stepType: "workflow",
        status: "failed",
        error: cycle
      })
    ).failure;
    expect(failure).toMatchObject({ reason: "runKeyCycle", workflow: "open-invoices" });
    expect(render(runPage(read(run({ status: "failed", ...ended, error: cycle }), [])))).toContain(
      "The key for Workflow “open-invoices” is held by a run in its own call chain."
    );

    // A sentence of any other form names no Workflow: nothing of it reaches the sentence.
    for (const message of [
      "The operation 'workflow.open-invoices.start' failed (run_key_cycle): key=abc",
      "The operation 'workflow.Open Invoices.start' failed (run_key_cycle)",
      "The operation 'connection.open-invoices.start' failed (run_key_cycle)",
      "run key 'secret-key' is held"
    ]) {
      const other = toWorkflowRun(
        run({ status: "failed", error: { code: "run_key_cycle", message } })
      ).failure;
      expect(other?.workflow).toBeUndefined();
      expect(other && failureHappened(other, t)).toBe(t("workflows.reason.runKeyCycle"));
    }
    expect(
      toWorkflowRun(
        run({ status: "failed", error: { code: "run_key_invalid", message: cycle.message } })
      ).failure?.workflow
    ).toBeUndefined();
  });

  // LOWS-B 3: the runs list names the account the run itself acted as, not the Workflow's now,
  // and never the right's technical name.
  it("names a refused run's own account and Connection in the runs list", () => {
    const refused = { code: "FORBIDDEN", message: "x", action: "connection.use" };
    const workflow = toWorkflow(
      { name: "notify-clients", config: definitionOf(), publishedRevision: 1 },
      { mayStart: true, runsAs: "Buchhaltung" }
    );
    const rows = [
      run({
        id: "wr_2",
        status: "failed",
        principal: { displayLabel: "Belegprüfung" },
        error: refused
      }),
      run({
        id: "wr_1",
        status: "failed",
        createdAt: "2026-10-12T08:00:00.000Z",
        error: { ...refused, connection: "Buchungen" }
      })
    ].map(toWorkflowRun);
    const markup = render(
      createElement(WorkflowRunsPageView, {
        workspaceId: "cw_1",
        workflowId: "notify-clients",
        workflow,
        runs: {
          rows,
          failed: false,
          hasMore: false,
          loadingMore: false,
          loadMore: noop,
          retry: noop
        },
        runsAvailable: true,
        now,
        onStart: noop,
        onOpenRoute: noop
      })
    );
    expect(markup).not.toContain("connection.use");
    expect(markup).not.toContain("“Buchhaltung”");
    const reasons = [...markup.matchAll(/data-run-reason=""[^>]*>([^<]*)</gu)].map(
      (match) => match[1] ?? ""
    );
    expect(reasons).toEqual([
      "The workflow may not do this: its account “Belegprüfung” may not use the Connection that one of its steps calls.",
      // An instance that names no account for the run: no account is guessed from the Workflow.
      "The workflow may not do this: its account may not use the Connection “Buchungen”."
    ]);
  });
});

describe("what a step returned", () => {
  it("shows what a step returned and says where the instance cut it", () => {
    const returned = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: { text: `{"sent":2,"note":"${"x".repeat(200)}`, truncated: true }
    });
    const markup = panel("clients", run(), [returned]);
    expect(markup).toContain("&quot;sent&quot;:2");
    expect(markup).toContain(t("workflows.run.shortened"));
  });

  const clients = {
    id: "ds_clients",
    rowSchema: {
      type: "object",
      properties: { name: { type: "string" }, since: { type: ["integer", "null"] } }
    },
    rowCount: 5000,
    bytes: 1_258_291,
    state: "complete" as const
  };
  const reference = { $dataset: "ds_clients", rowCount: 5000, bytes: 1_258_291 };

  it("says a dataset's rows, size and columns, and shows no row and no id", () => {
    const returned = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: {
        text: JSON.stringify({ summary: "loaded", result: { clients: reference } }),
        truncated: false
      },
      datasets: [clients]
    });
    const markup = panel("clients", run(), [returned]);
    expect(markup).toContain("data-step-datasets");
    expect(markup).toContain(t("workflows.dataset.size", { rows: "5,000", size: "1.2 MB" }));
    expect(markup).toContain(t("workflows.dataset.kind.wholeNumber"));
    expect(markup).not.toContain("<table");
    // The output as text, which names the dataset by its id, stays behind the fold.
    expect(markup).not.toContain("ds_clients");
  });

  it("finds a dataset in a cut preview by the run's record", () => {
    const cut = `{"batches":[${JSON.stringify({ ...reference, rowCount: 12, bytes: 900 })}],"note":"${"x".repeat(80)}`;
    const returned = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: { text: cut, truncated: true }
    });
    const markup = panel(
      "clients",
      run({ datasets: [{ ...clients, rowCount: 12, bytes: 900, state: "writing" }] }),
      [returned]
    );
    expect(markup).toContain(t("workflows.dataset.size", { rows: "12", size: "900 byte" }));
    expect(markup).toContain(t("workflows.dataset.writing"));
  });

  it("counts a reference with no record once, and leaves a look-alike as the output it is", () => {
    const twice = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: {
        text: JSON.stringify({ first: reference, again: reference }),
        truncated: false
      }
    });
    const markup = panel("clients", run(), [twice]);
    expect(markup).toContain("First");
    expect(markup).not.toContain("Again");
    const lookAlike = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: { text: '{"$dataset":"ds_1","rowCount":"many","bytes":3}', truncated: false }
    });
    expect(panel("clients", run(), [lookAlike])).not.toContain("data-step-datasets");
  });
});

describe("what a step says it does", () => {
  it("says that a step reads or changes only where the instance tells", () => {
    const told = workflowOf(undefined, {
      clients: { effect: "reading", source: { kind: "connection", title: "Client register" } },
      send: { effect: "changing", source: { kind: "connection" } }
    });
    const graph = workflowGraph(told.steps, en);
    expect(graph.nodes.find((node) => node.id === "clients")).toMatchObject({
      eyebrow: t("workflows.step.reading"),
      chip: { label: "Client register" }
    });
    expect(graph.nodes.find((node) => node.id === "send")?.eyebrow).toBe(
      t("workflows.step.changing")
    );
    const untold = workflowGraph(workflowOf().steps, en).nodes.find(
      (node) => node.id === "clients"
    );
    expect(untold?.eyebrow).toBe(t("workflows.step.operation"));
    expect(untold?.chip).toBeUndefined();
  });

  it("says who started the run, or that its schedule did", () => {
    const first = (resource: RunResource) =>
      workflowGraph(workflowOf().steps, en, {
        run: toWorkflowRun(resource),
        stepRuns: [toWorkflowStepRun(startStep)],
        now
      }).nodes[0];
    expect(first(run())?.title).toBe(
      t("workflows.run.startStepPerson", { person: "Ada Lovelace" })
    );
    expect(first(run({ trigger: "schedule" }))?.title).toBe(t("workflows.run.startStepSchedule"));
  });

  describe("an agent step (CR-2)", () => {
    const agentWorkflow = toWorkflow({
      name: "notify-clients",
      publishedRevision: 1,
      config: {
        ...definitionOf({
          clients: { type: "agent", instructions: "Check the monthly totals and return JSON." }
        }),
        tools: ["connection.bookings.read"]
      }
    });

    it("shows the loaded transcript and output only to a reader with run data", () => {
      const resource = stepRun({
        id: "sr_ai",
        stepId: "clients",
        stepType: "agent",
        agent: {
          runId: "run_ai",
          status: "completed",
          usage: { modelCallCount: 1, inputTokens: 7, outputTokens: 3, totalTokens: 10 }
        },
        outputPreview: { text: '{"balanced":true}', truncated: false }
      });
      const markup = panel("clients", run(), [resource], {
        workflow: agentWorkflow,
        transcript: createElement(StepTranscriptView, {
          transcript: {
            messages: [{ role: "assistant", text: "The totals agree." }],
            truncated: true
          }
        })
      });
      expect(markup).toContain("The totals agree.");
      expect(markup).toContain("balanced");
      expect(markup).toContain(t("workflows.panel.agentUsage"));
      // A reader without run data gets neither: the panel loads no transcript for them.
      const hidden = panel("clients", run(), [{ ...resource, outputPreview: undefined }], {
        workflow: agentWorkflow
      });
      expect(hidden).not.toContain("The totals agree.");
      expect(hidden).not.toContain("balanced");
    });
  });
});

describe("a loop's entries", () => {
  const failedEntry = stepRun({
    id: "sr_0_send",
    stepId: "send",
    status: "failed",
    containerStepRunId: "sr_loop",
    iteration: { index: 0, label: "10432 · Müller GmbH" },
    error: { code: "FORBIDDEN", message: "x" }
  });

  it("filters by the real count, and names a failed entry with the step and why", () => {
    const markup = loopEntriesOf(workflowOf(), [failedEntry], {
      counts: { total: 600, done: 209, failed: 120, running: 8 },
      filter: "failed",
      hasMore: true
    });
    expect(markup).toMatch(/role="radio"[^>]*>All<span[^>]*>600<\/span>/u);
    expect(markup).toMatch(/role="radio"[^>]*>Failed<span[^>]*>120<\/span>/u);
    expect(markup).not.toContain("99+");
    expect(markup).toContain("10432 · Müller GmbH");
    expect(markup).toContain(t("workflows.run.atStep", { step: "Send the note" }));
    expect(markup).toContain(t("workflows.reason.missingRight"));
    expect(markup).toContain(t("workflows.showMore"));
  });
});

describe("a fan-out that ended done with failed child runs", () => {
  // REH-900: a parent whose loop went on past a failed child read as a plain green "Done", and
  // the canvas, fitted to 600 children, was zoomed too far out to show the loop's counts.
  const child = (id: string) => ({
    id,
    name: "Check the client",
    type: "workflow" as const,
    workflow: "client-check",
    input: {}
  });
  const fanOut = workflowOf({ each_client: { steps: [child("check")] } });
  const loopRun = (failed: number) =>
    stepRun({
      id: "sr_loop",
      stepId: "each_client",
      stepType: "loop",
      loop: { total: 600, done: 600 - failed, failed, running: 0 }
    });
  const page = (failed: number, workflow = fanOut, status: "done" | "failed" = "done") =>
    render(runPage(read(run({ status, ...ended }), [startStep, loopRun(failed)]), { workflow }));

  it("stays a plain Done where nothing failed, and leaves a failed run to its own banner", () => {
    const clean = page(0);
    expect(clean).toContain(t("workflows.run.done"));
    expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
    expect(page(1, fanOut, "failed")).not.toContain("data-run-failed-entries");
  });

  // A loop's counts count entries, not child runs: an entry whose body does more than start
  // one child run can fail elsewhere, and two child runs per entry are not one per entry.
  it("calls them entries where the loop's body is not exactly one child run", () => {
    const send = { id: "send", name: "Send", type: "operation", operation: "connection.crm.write" };
    for (const steps of [[send], [child("check"), send], [child("check"), child("again")]]) {
      const markup = page(1, workflowOf({ each_client: { steps } }));
      expect(markup).toContain(t("workflows.run.failedEntriesOne", { count: "1", total: "600" }));
      expect(markup).toContain(t("workflows.run.showFailedEntries"));
      expect(markup).not.toContain(t("workflows.run.showFailedChildRuns"));
    }
  });

  it("counts every loop of a kind, and names child runs and other entries apart", () => {
    const loop = (id: string, steps: readonly Record<string, unknown>[]) => ({
      id,
      name: id,
      type: "loop",
      items: { step: "clients", path: "" },
      steps
    });
    const threeLoops = toWorkflow({
      name: "notify-clients",
      publishedRevision: 1,
      config: {
        ...definitionOf(),
        steps: [
          ...definitionOf().steps.slice(0, 2),
          loop("each_client", [child("check")]),
          loop("each_partner", [child("check_partner")]),
          loop("each_note", [
            { id: "send", name: "Send", type: "operation", operation: "connection.crm.write" }
          ])
        ]
      }
    });
    const loopOf = (id: string, stepId: string, total: number, failed: number) =>
      stepRun({
        id,
        stepId,
        stepType: "loop",
        loop: { total, done: total - failed, failed, running: 0 }
      });
    const markup = render(
      runPage(
        read(run({ status: "done", ...ended }), [
          startStep,
          loopOf("sr_a", "each_client", 600, 1),
          loopOf("sr_b", "each_partner", 10, 0),
          loopOf("sr_c", "each_note", 50, 2)
        ]),
        { workflow: threeLoops }
      )
    );
    expect(markup).toContain(t("workflows.run.failedChildRunsOne", { count: "1", total: "610" }));
    expect(markup).toContain(t("workflows.run.failedEntriesMany", { count: "2", total: "50" }));
  });

  it("shows no state for a done run until its step runs say whether entries failed", () => {
    const markup = render(
      runPage(read(run({ status: "done", ...ended }), undefined), { workflow: fanOut })
    );
    expect(markup).not.toContain(t("workflows.run.done"));
    expect(markup).not.toContain(t("workflows.run.doneWithFailures"));
  });

  it("links every child run of a loop (EW-13), and none the reader may not read", () => {
    const doneChild = stepRun({
      id: "sr_1_check",
      stepId: "check",
      stepType: "workflow",
      containerStepRunId: "sr_loop",
      iteration: { index: 1, label: "1003 · Klein GmbH" },
      childRunId: "wr_child_1003"
    });
    expect(loopEntriesOf(fanOut, [doneChild])).toContain('data-child-run="wr_child_1003"');
    // The server names a child the reader may not read by its kind alone.
    const childLoop = {
      each_client: {
        steps: [
          { id: "check", name: "Check the client", type: "workflow", workflow: "client-check" }
        ]
      }
    };
    const hidden = workflowOf(childLoop, { check: { source: { kind: "workflow" } } });
    expect(placedSteps(hidden.steps).get("check")?.step.childHidden).toBe(true);
    expect(loopEntriesOf(hidden, [doneChild])).not.toContain("data-child-run");
    const node = workflowGraph(hidden.steps, en).nodes.find((entry) => entry.id === "check");
    expect(node?.action).toBeUndefined();
    const readable = workflowOf(childLoop, {
      check: { source: { kind: "workflow", title: "Client check" }, published: true }
    });
    expect(
      workflowGraph(readable.steps, en).nodes.find((entry) => entry.id === "check")?.action
    ).toEqual({ label: t("workflows.canvas.open") });
  });
});

// REH-FIX-1: a run that ended `done` while something below it failed is no plain green "Done"
// on any surface: the runs list, the Workflow card, the run page with its banner, the loop's
// panel and its entry rows. The list and the card hold no step runs, so the instance's counts
// speak there: the run's own failed items, and the runs with failures below it. The run page
// reads its loops' counts, those of loops inside an entry of another loop too, and falls back
// to the run's own count of failed items, then to the count below.
describe("REH-FIX-1: done with failures below on every surface", () => {
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
  const workflowWith = (body: readonly Step[], loop: Step = {}) =>
    toWorkflow({
      name: "notify-clients",
      publishedRevision: 1,
      config: {
        ...definitionOf(),
        steps: [
          ...definitionOf().steps.slice(0, 2),
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
  const doneRun = (input: Partial<RunResource> = {}) => run({ status: "done", ...ended, ...input });
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
  const page = (runRead: WorkflowRunRead, workflow: Workflow) =>
    render(runPage(runRead, { workflow, canRunAgain: false }));
  const noShowButton = (markup: string) => {
    expect(markup).not.toContain(t("workflows.run.showFailedChildRuns"));
    expect(markup).not.toContain(t("workflows.run.showFailedEntries"));
  };
  const fanOut = workflowWith([child("check")]);

  it("warns on a runs-list row over failed runs or items below, and never folds it", () => {
    const runsPage = (rows: readonly RunResource[]) =>
      render(
        createElement(WorkflowRunsPageView, {
          workspaceId: "cw_1",
          workflowId: "notify-clients",
          workflow: fanOut,
          runs: {
            rows: rows.map(toWorkflowRun),
            failed: false,
            hasMore: false,
            loadingMore: false,
            loadMore: noop,
            retry: noop
          },
          runsAvailable: true,
          now,
          onStart: noop,
          onOpenRoute: noop
        })
      );
    const markup = runsPage([
      doneRun({ id: "wr_5", failedDescendantCount: 1 }),
      doneRun({ id: "wr_4", empty: true }),
      doneRun({ id: "wr_3", empty: true, failedDescendantCount: 1 }),
      doneRun({ id: "wr_2", empty: true, failedItemCount: 1, failedDescendantCount: 0 }),
      doneRun({ id: "wr_1", empty: true })
    ]);
    expect(markup.split(t("workflows.run.doneWithFailures"))).toHaveLength(4);
    // An empty run with failures below it stands: the plain empty ones around it do not fold.
    expect(markup).not.toContain("data-empty-runs=");
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients/runs/wr_2"');
    const clean = runsPage([doneRun({ id: "wr_9", failedItemCount: 0, failedDescendantCount: 0 })]);
    expect(clean).toContain(`>${t("workflows.run.done")}<`);
    expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
  });

  it("warns on a Workflow card whose last run had failures below or in its own loop", () => {
    const card = (counts: { failedDescendantCount?: number; failedItemCount?: number }) =>
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
        })
      );
    for (const counts of [
      { failedDescendantCount: 1 },
      { failedItemCount: 1, failedDescendantCount: 0 }
    ]) {
      const warned = card(counts);
      expect(warned).toContain(t("workflows.run.doneWithFailures"));
      expect(warned).not.toContain(`>${t("workflows.run.done")}<`);
    }
    // An instance that sends no count yet reads as nothing failed below.
    for (const clean of [card({ failedDescendantCount: 0 }), card({})]) {
      expect(clean).toContain(`>${t("workflows.run.done")}<`);
      expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
    }
  });

  it("warns on a nested loop's failed child run, without a made-up total or link", () => {
    const markup = page(
      read(doneRun({ failedDescendantCount: 1 }), [startStep, outerLoop(0)]),
      workflowWith([innerLoop([child("check")])])
    );
    expect(markup).toContain(t("workflows.run.failedDescendantRunsOne", { count: "1" }));
    expect(markup).not.toContain("of 600");
    noShowButton(markup);
  });

  it("warns on a nested loop's failed operation entry with no failed run below", () => {
    const markup = page(
      read(
        doneRun({ failedDescendantCount: 0 }),
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

  it("warns on a child run that ended done over a failed child of its own", () => {
    const single = workflowWith([], { type: "workflow", workflow: "client-check" });
    const childPage = (failedDescendantCount: number) =>
      page(
        read(doneRun({ failedDescendantCount }), [
          startStep,
          stepRun({ id: "sr_child", stepId: "each_client", stepType: "workflow" })
        ]),
        single
      );
    expect(childPage(3)).toContain(t("workflows.run.failedDescendantRunsMany", { count: "3" }));
    const clean = childPage(0);
    expect(clean).toContain(t("workflows.run.done"));
    expect(clean).not.toContain("data-run-failed-entries");
  });

  it("warns before the step runs arrived, counting the run's own failed items as no runs below", () => {
    expect(page(read(doneRun({ failedDescendantCount: 1 }), undefined), fanOut)).toContain(
      t("workflows.run.doneWithFailures")
    );
    const own = (failedItemCount: number) =>
      page(
        read(doneRun({ failedItemCount, failedDescendantCount: failedItemCount }), undefined),
        fanOut
      );
    const one = own(1);
    expect(one).toContain(t("workflows.run.doneWithFailures"));
    // The page cannot tell yet whether the items are child runs, nor of how many.
    expect(one).toContain(`>${t("workflows.run.failedItemsOne", { count: "1" })}<`);
    noShowButton(one);
    expect(own(2)).not.toContain(t("workflows.run.failedDescendantRunsMany", { count: "2" }));
  });

  it("reads the own loop's tally once the step runs arrived, before the count below", () => {
    const entries = page(
      read(doneRun({ failedItemCount: 1, failedDescendantCount: 0 }), [startStep, outerLoop(1)]),
      workflowWith([send])
    );
    expect(entries).toContain(t("workflows.run.failedEntriesOne", { count: "1", total: "600" }));
    expect(entries).not.toContain(t("workflows.run.failedItemsOne", { count: "1" }));
    const children = page(
      read(doneRun({ failedDescendantCount: 5 }), [startStep, outerLoop(1)]),
      fanOut
    );
    expect(children).toContain(t("workflows.run.failedChildRunsOne", { count: "1", total: "600" }));
    expect(children).not.toContain(t("workflows.run.failedDescendantRunsMany", { count: "5" }));
    expect(children).toContain(t("workflows.run.showFailedChildRuns"));
  });

  it("warns in the loop's panel and on an entry row whose own loop failed entries", () => {
    const loopPanel = (failed: number) =>
      panel("each_client", doneRun(), [startStep, outerLoop(failed)], { workflow: fanOut });
    expect(loopPanel(1)).toContain(t("workflows.run.doneWithFailures"));
    expect(loopPanel(0)).not.toContain(t("workflows.run.doneWithFailures"));
    const nested = workflowWith([innerLoop([send])]);
    expect(loopEntriesOf(nested, [entryLoop(0, 1)])).toContain(t("workflows.run.doneWithFailures"));
    expect(loopEntriesOf(nested, [entryLoop(0, 0)])).not.toContain(
      t("workflows.run.doneWithFailures")
    );
  });
});

describe("a Workflow the instance accepts no start of", () => {
  const NOT_BUILT = {
    code: "not_supported_yet",
    message: "This engine does not run a step of the type 'agent' yet (not_supported_yet)"
  };
  const blocked = (issues: { code: string; message: string }[], mayStart = true) =>
    toWorkflow(
      {
        name: "weekly-check",
        publishedRevision: 1,
        config: {
          name: "Weekly check",
          steps: [{ id: "start", type: "trigger", triggers: [{ kind: "manual" }] }]
        }
      },
      { revisionId: "rev_1", refusedFor: issues, mayStart }
    );
  const page = (workflow: Workflow) =>
    render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "weekly-check",
        read: { workflow, problem: undefined, retry: noop },
        runsAvailable: true,
        onOpenChild: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );

  it("shows the engine's reason and switches its start off", () => {
    const workflow = blocked([NOT_BUILT]);
    expect(startOffered(workflow)).toBe(false);
    const markup = page(workflow);
    expect(markup).toContain("does not run a step of the type &#x27;agent&#x27; yet");
    expect(markup).toMatch(/<button[^>]* disabled=""[^>]*>.*Start now/su);
  });

  it("shows no start, switched off or not, to a reader who may not start", () => {
    expect(page(blocked([NOT_BUILT], false))).not.toContain(t("workflows.startNow"));
    expect(page(blocked([]))).not.toContain(' disabled=""');
  });
});

describe("a test run of a Workflow's draft (EW-5t)", () => {
  const draft = toWorkflow(
    {
      name: "notify-clients",
      config: {
        ...definitionOf(),
        inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] }
      },
      publishedRevision: undefined
    },
    { mayStart: false },
    { draftRevision: 3 }
  );
  const testRun = (input: Partial<RunResource> = {}) =>
    run({
      id: "wr_test",
      mode: "test",
      status: "done",
      startedBy: { id: "user_kai", label: "Kai" },
      ...ended,
      ...input
    });
  const steps = [
    startStep,
    stepRun({ id: "sr_clients", stepId: "clients", effect: "reading", target: "live" }),
    stepRun({
      id: "sr_send",
      stepId: "send",
      effect: "changing",
      target: "dry_run",
      publishedWouldAsk: "approval",
      outputPreview: {
        text: JSON.stringify({
          wouldHaveDone: {
            operation: "connection.crm.write",
            input: { client: "client-anna", note: "Hello" },
            wouldAsk: "approval"
          }
        }),
        truncated: false
      }
    })
  ];
  const testPanel = (stepId: string, runExtra?: Partial<PanelRun>) =>
    panel(stepId, testRun(), steps, { workflow: draft, ...(runExtra ? { runExtra } : {}) });

  it("offers Test run in the draft bar only to a reader who may write, with the draft's form", () => {
    const page = (bar: { onTest?: () => void }) =>
      render(
        createElement(WorkflowPageView, {
          workspaceId: "cw_1",
          workflowId: "notify-clients",
          read: { workflow: draft, problem: undefined, retry: noop },
          runsAvailable: true,
          draft: { state: "unpublished", onPublish: noop, ...bar },
          onOpenChild: noop,
          onOpenRoute: noop,
          onStart: noop
        })
      );
    expect(page({ onTest: noop })).toContain(`>${t("workflows.test.button")}</`);
    expect(page({})).not.toContain(`>${t("workflows.test.button")}</`);
    expect(draft.draft?.testForm.fields.map((field) => field.name)).toEqual(["note"]);
  });

  it("says on its page that it is a test run of the draft, and the App draft it came from (DP-1)", () => {
    const markup = render(runPage(read(testRun(), steps), { workflow: draft }));
    expect(markup).toContain("data-test-run");
    expect(markup).toContain(t("workflows.run.testLine", { person: "Kai" }));
    // The canvas draws the draft the run is of: no word of an earlier revision.
    expect(markup).not.toContain("data-run-revision");
    const fromApp = testRun({ startedFrom: { kind: "app", app: "Mandantenbrief" } });
    expect(toWorkflowRun(fromApp).fromApp).toBe("Mandantenbrief");
    expect(toWorkflowRun(testRun()).fromApp).toBeUndefined();
    expect(render(runPage(read(fromApp, steps), { workflow: draft }))).toContain("Mandantenbrief");
  });

  it("marks each step with its target, and what a simulated step would have done in words", () => {
    expect(testPanel("clients")).toContain('data-target="live"');
    const send = testPanel("send");
    expect(send).toContain('data-target="dry_run"');
    expect(send).toContain("data-simulated");
    expect(send).toContain(">client-anna<");
    expect(send).not.toMatch(/wouldHaveDone|wouldAsk/u);
    // A published run would ask for an approval the test did not.
    expect(send).toContain('data-published-asks="approval"');
    expect(testPanel("clients")).not.toContain("data-published-asks");
  });

  it("offers Run live once beside a simulated step, and says when it is set and when used", () => {
    const button = `>${t("workflows.liveOnce.button")}</`;
    expect(testPanel("send")).not.toContain(button);
    expect(testPanel("send", { liveOnce: { state: "off", switchOn: noop } })).toContain(button);
    const set = testPanel("send", { liveOnce: { state: "set", switchOn: noop } });
    expect(set).toContain(t("workflows.liveOnce.done"));
    expect(set).not.toContain(button);
    const used = testPanel("send", {
      liveOnce: {
        state: "used",
        used: { runId: "wr_test", at: "2026-10-14T09:00:05.000Z" },
        switchOn: noop
      }
    });
    expect(used).toContain('data-live-once="used"');
    expect(used).toContain(`>${t("workflows.liveOnce.again")}</`);
  });

  it("marks each entry of a loop with where its changing step went", () => {
    const entryRuns = [0, 1].map((index) =>
      stepRun({
        id: `sr_send_${String(index)}`,
        stepId: "send",
        containerStepRunId: "sr_loop",
        iteration: { index },
        effect: "changing",
        target: index === 0 ? "live" : "dry_run"
      })
    );
    expect(loopEntries(entryRuns.map(toWorkflowStepRun)).map((entry) => entry.targets)).toEqual([
      ["live"],
      ["dry_run"]
    ]);
    const markup = loopEntriesOf(draft, entryRuns, {
      counts: { total: 2, done: 2, failed: 0, running: 0 }
    });
    expect(markup).toContain('data-target="live"');
    expect(markup).toContain('data-target="dry_run"');
  });
});

describe("re-running a run from a step (EW-11)", () => {
  const clientsRun = stepRun({
    id: "sr_clients",
    stepId: "clients",
    outputPreview: { text: '{"clients":[]}', truncated: false }
  });
  const control = (input: Partial<StepRerunControl> = {}): StepRerunControl => ({
    offered: true,
    changed: false,
    start: noop,
    ...input
  });
  const donePanel = (options: {
    rerun?: StepRerunControl;
    reusedFrom?: string;
    reached?: boolean;
  }) =>
    panel(
      "clients",
      run({ status: "done", ...ended }),
      options.reached === false ? [] : [clientsRun],
      {
        tab: options.reached === false ? "what" : "run",
        ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
        ...(options.reusedFrom === undefined
          ? {}
          : { runExtra: { reusedFrom: { runId: options.reusedFrom, open: noop } } })
      }
    );

  it("maps the run a re-run re-runs", () => {
    const rerunOf = { runId: "wr_first", fromStep: "result", reusedSteps: ["clients"] };
    expect(toWorkflowRun(run({ rerunOf })).rerunOf).toEqual(rerunOf);
    expect(toWorkflowRun(run()).rerunOf).toBeUndefined();
  });

  it("offers to run again from a step, reached or not, and says why where it is refused", () => {
    expect(donePanel({ rerun: control() })).toContain('data-step-rerun="offered"');
    expect(donePanel({})).not.toContain("data-step-rerun");
    expect(donePanel({ rerun: control(), reached: false })).toContain('data-step-rerun="offered"');
    const refusal = t("workflows.rerun.changed", { step: "Load the clients" });
    const refused = donePanel({ rerun: control({ offered: false, refusal }) });
    expect(refused).toContain('data-step-rerun="refused"');
    expect(refused).not.toContain(t("workflows.rerun.button"));
  });

  it("marks a step a re-run took from the run it re-runs, with the way there", () => {
    const markup = donePanel({ reusedFrom: "wr_first" });
    expect(markup).toContain('data-reused-from="wr_first"');
    expect(markup).toContain(t("workflows.rerun.openOriginal"));
  });
});

describe("a run that continued as new in the runs list (EW-CAN, check 112)", () => {
  const workflow = toWorkflow(
    { name: "notify-clients", config: definitionOf(), publishedRevision: 2 },
    { mayStart: true }
  );
  /** A part of the Lauf `2026-10-17` whose first part is `wr_1`. */
  const part = (
    number: number,
    extra: Partial<RunResource> & { status: RunResource["status"] }
  ): RunResource => ({
    id: `wr_${number}`,
    workflow: "notify-clients",
    trigger: "schedule",
    startedBy: { id: "sp_1", label: "Importer" },
    createdAt: `2026-10-17T0${number}:00:00.000Z`,
    startedAt: `2026-10-17T0${number}:00:05.000Z`,
    runKey: "2026-10-17",
    labels: { source: "ledger" },
    definitionRevisionId: "rev_a",
    stepRunCount: 20_000,
    continuation: {
      rootRunId: "wr_1",
      ...(number === 1 ? {} : { previousRunId: `wr_${number - 1}` }),
      number
    },
    ...extra
  });
  const part1 = toWorkflowRun(
    part(1, { status: "continued", finishedAt: "2026-10-17T01:59:00.000Z" })
  );
  const part2 = toWorkflowRun(
    part(2, { status: "continued", finishedAt: "2026-10-17T02:59:00.000Z" })
  );
  // A republish between part 2 and part 3 moved part 3 to the next version.
  const part3 = toWorkflowRun(
    part(3, { status: "running", definitionRevisionId: "rev_b", stepRunCount: 10_004 })
  );
  const other = toWorkflowRun(
    run({ id: "wr_other", status: "done", createdAt: "2026-10-17T02:30:00.000Z" })
  );

  /** Mounts the runs list in the DOM; `show` renders it again with other rows. */
  function mount() {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const show = (rows: WorkflowRunList["rows"], hasMore: boolean) =>
      act(() => {
        root.render(
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(
              UiRoot,
              { mode: "light", labels: uiLabelsEn },
              createElement(WorkflowRunsPageView, {
                workspaceId: "cw_1",
                workflowId: "notify-clients",
                workflow,
                runs: {
                  rows,
                  failed: false,
                  hasMore,
                  loadingMore: false,
                  loadMore: noop,
                  retry: noop
                },
                runsAvailable: true,
                now: new Date("2026-10-17T12:00:00.000Z"),
                onStart: noop,
                onOpenRoute: noop
              })
            )
          )
        );
      });
    const group = () => {
      const row = host.querySelector<HTMLElement>('[data-run-group="wr_1"]');
      if (!row) throw new Error("No Lauf row.");
      return row;
    };
    const toggle = () => {
      const button = group().querySelector<HTMLButtonElement>("button");
      if (!button) throw new Error("The Lauf row does not unfold.");
      return button;
    };
    const runLinks = () =>
      [...host.querySelectorAll("a")]
        .map((link) => link.getAttribute("href") ?? "")
        .filter((href) => href.includes("/runs/"))
        .map((href) => href.slice(href.lastIndexOf("/") + 1));
    const unmount = () => {
      act(() => root.unmount());
      host.remove();
    };
    return { host, show, group, toggle, runLinks, unmount };
  }

  it("shows the parts as one Lauf where its newest part stands, and opens to each part", () => {
    const view = mount();
    try {
      // Newest first: part 3, another run started by hand between the parts, then parts 2 and 1.
      view.show([part3, other, part2, part1], false);
      expect(view.host.querySelectorAll("[data-run-group]")).toHaveLength(1);
      expect(view.group().getAttribute("data-run-parts")).toBe("3");
      expect(view.runLinks()).toEqual(["wr_other"]);
      expect(view.group().textContent).toContain("50,004 steps");
      // No revision id reaches the reader.
      expect(view.host.textContent).not.toContain("rev_");

      act(() => view.toggle().click());
      expect(view.runLinks()).toEqual(["wr_3", "wr_2", "wr_1", "wr_other"]);
      const parts = [...view.group().querySelectorAll<HTMLElement>("[data-run-part]")];
      // Only the part a republish moved is marked.
      expect(parts.map((row) => row.querySelector("[data-revision-changed]") !== null)).toEqual([
        true,
        false,
        false
      ]);
      act(() => view.toggle().click());
      expect(view.runLinks()).toEqual(["wr_other"]);
    } finally {
      view.unmount();
    }
  });

  it("stays open as earlier parts arrive, and shows carried failures before they do", () => {
    const view = mount();
    try {
      view.show([part3, part2], true);
      act(() => view.toggle().click());
      expect(view.runLinks()).toEqual(["wr_3", "wr_2"]);
      // The next page brings part 1: the same row counts it and stays open.
      view.show([part3, part2, part1], false);
      expect(view.toggle().getAttribute("aria-expanded")).toBe("true");
      expect(view.runLinks()).toEqual(["wr_3", "wr_2", "wr_1"]);
      view.show([toWorkflowRun(part(3, { status: "done", failedItemCount: 1 }))], true);
      expect(view.group().textContent).toContain(t("workflows.run.doneWithFailures"));
    } finally {
      view.unmount();
    }
  });
});
