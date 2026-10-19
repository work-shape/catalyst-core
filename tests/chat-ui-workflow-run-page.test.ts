import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  LoopEntriesView,
  StartDialog,
  StepPanel,
  StepTranscriptView,
  WorkflowRunPageView,
  WorkflowsHostProvider,
  resolveWorkflowRights,
  placedSteps,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  workflowGraph,
  type WorkflowRunRead
} from "@work-shape/catalyst-chat-ui/workflows";
import { definitionOf, workflowOf } from "./support/workflow-run-page-fixtures";
import { workflowsContext } from "./chat-ui-build-fixtures";
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
    stepsFailed: false,
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
    /** The label of the Workflow's account, and the reader's instance actions in a host. */
    account?: string;
    instanceActions?: readonly string[];
    /** The transcript an open agent step's panel loaded. */
    transcript?: ReactNode;
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
      now
    },
    tab: options.tab ?? "run",
    onTabChange: noop,
    entries: null,
    ...(options.transcript === undefined ? {} : { transcript: options.transcript }),
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
    ["confirmation_unattended", "confirmationUnattended"],
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
  it("says where the technical account is changed, in both languages", () => {
    const failed = run({
      status: "failed",
      ...ended,
      error: { code: "principal_inactive", message: "x" }
    });
    const steps = [startStep, failedStep("principal_inactive")];
    expect(panel("clients", failed, steps)).toContain(
      "An administrator restores the account or switches it on under Settings › API access, or you choose another active account in the workflow."
    );
    expect(panel("clients", failed, steps, { locale: "de" })).toContain(
      "Ein Administrator stellt das Konto unter Einstellungen › API-Zugang wieder her oder schaltet es ein, oder du wählst im Workflow ein anderes aktives Konto."
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
    const admin = { ...options, instanceActions: ["service_principals.manage"] };
    const member = { ...options, instanceActions: [] };
    expect(panel("clients", failed, [refused], admin)).toContain(
      "The workflow may not do this: its account “Booking checks” may not use the Connection “CRM”."
    );
    expect(panel("clients", failed, [refused], admin)).toContain(
      "Under Settings › API access, allow the account “Booking checks” to use the Connection “CRM”, then run the workflow again."
    );
    expect(panel("clients", failed, [refused], { ...admin, locale: "de" })).toContain(
      "Der Workflow darf das nicht: Sein Konto „Booking checks“ darf die Verbindung „CRM“ nicht verwenden."
    );
    expect(panel("clients", failed, [refused], { ...admin, locale: "de" })).toContain(
      "Erlaube dem Konto „Booking checks“ unter Einstellungen › API-Zugang, die Verbindung „CRM“ zu verwenden, und starte den Workflow dann erneut."
    );
    // Whoever administers no account is still told to ask, and never told to ask by an admin.
    expect(panel("clients", failed, [refused], member)).toContain(
      t("workflows.advice.missingRight")
    );
    expect(panel("clients", failed, [refused], admin)).not.toContain(
      t("workflows.advice.missingRight")
    );
    // The node of the drawing names the Connection too.
    const graph = workflowGraph(workflowOf().steps, en, {
      run: toWorkflowRun(failed),
      stepRuns: [toWorkflowStepRun(refused)],
      now
    });
    expect(graph.nodes.find((node) => node.id === "clients")?.footer).toBe(
      "The workflow may not do this: its account may not use the Connection “CRM”."
    );
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

describe("the datasets a step's output names", () => {
  const clients = {
    id: "ds_clients",
    rowSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        since: { type: ["integer", "null"] },
        active: { type: "boolean" },
        tags: { anyOf: [{ type: "string" }, { type: "number" }] }
      }
    },
    rowCount: 5000,
    bytes: 1_258_291,
    state: "complete" as const
  };
  const reference = { $dataset: "ds_clients", rowCount: 5000, bytes: 1_258_291 };

  it("says its rows, its size and its columns, and shows no row and no id", () => {
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
    expect(markup).toContain(t("workflows.dataset.heading"));
    expect(markup).toContain("Clients");
    expect(markup).toContain(t("workflows.dataset.size", { rows: "5,000", size: "1.2 MB" }));
    for (const [field, kind] of [
      ["name", "text"],
      ["since", "wholeNumber"],
      ["active", "yesNo"],
      ["tags", "value"]
    ] as const) {
      expect(markup).toContain(`>${field}<`);
      expect(markup).toContain(t(`workflows.dataset.kind.${kind}`));
    }
    expect(markup).not.toContain(t("workflows.dataset.writing"));
    expect(markup).not.toContain("<table");
    // The output as text, which names the dataset by its id, stays behind the fold.
    expect(markup).not.toContain("ds_clients");
    expect(markup).toContain(t("workflows.technicalDetails"));
  });

  it("finds a dataset in a cut preview and in a list, by the run's record, in German", () => {
    const cut = `{"batches":[${JSON.stringify({ ...reference, rowCount: 12, bytes: 900 })}],"note":"${"x".repeat(80)}`;
    const returned = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: { text: cut, truncated: true }
    });
    const markup = panel(
      "clients",
      run({ datasets: [{ ...clients, rowCount: 12, bytes: 900, state: "writing" }] }),
      [returned],
      { locale: "de" }
    );
    expect(markup).toContain(de("workflows.dataset.unnamed"));
    expect(markup).toContain(de("workflows.dataset.size", { rows: "12", size: "900 Byte" }));
    expect(markup).toContain(de("workflows.dataset.writing"));
    expect(markup).toContain(de("workflows.dataset.kind.wholeNumber"));
  });

  it("says the counts of a reference the instance names no record for, and once only", () => {
    const returned = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: {
        text: JSON.stringify({ first: reference, again: reference }),
        truncated: false
      }
    });
    const markup = panel("clients", run(), [returned]);
    expect(markup).toContain("First");
    expect(markup).not.toContain("Again");
    expect(markup).toContain(t("workflows.dataset.size", { rows: "5,000", size: "1.2 MB" }));
    const section = markup.slice(markup.indexOf("data-step-datasets"));
    expect(section.slice(0, section.indexOf("</section>"))).not.toContain("<dl");
  });

  it("leaves an object that only looks like a reference as the output it is", () => {
    const returned = stepRun({
      id: "sr_clients",
      stepId: "clients",
      outputPreview: { text: '{"$dataset":"ds_1","rowCount":"many","bytes":3}', truncated: false }
    });
    expect(panel("clients", run(), [returned])).not.toContain("data-step-datasets");
  });
});

describe("what an operation step says it does", () => {
  const told = workflowOf(undefined, {
    clients: { effect: "reading", source: { kind: "connection", title: "Client register" } },
    send: { effect: "changing", source: { kind: "connection" } }
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
        },
        onOpenChild: noop
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

describe("a fan-out that ended done with failed child runs", () => {
  // REH-900: a parent whose loop went on past a failed child read as a plain green "Done", and
  // the canvas, fitted to 600 children, was zoomed too far out to show the loop's counts.
  const fanOut = workflowOf({
    each_client: {
      steps: [
        {
          id: "check",
          name: "Check the client",
          type: "workflow",
          workflow: "client-check",
          input: {}
        }
      ]
    }
  });
  const loopRun = (failed: number) =>
    stepRun({
      id: "sr_loop",
      stepId: "each_client",
      stepType: "loop",
      loop: { total: 600, done: 600 - failed, failed, running: 0 }
    });
  const page = (failed: number, locale: "en" | "de" = "en", status: "done" | "failed" = "done") =>
    render(
      runPage(read(run({ status, ...ended }), [startStep, loopRun(failed)]), {
        workflow: fanOut
      }),
      locale
    );

  it("says it finished with failures, with the count, and offers the failed child runs", () => {
    const markup = page(1);
    expect(markup).toContain(t("workflows.run.doneWithFailures"));
    expect(markup).toContain(t("workflows.run.failedChildRunsOne", { count: "1", total: "600" }));
    expect(markup).toContain(t("workflows.run.showFailedChildRuns"));
    expect(markup).toContain('data-run-failed-entries=""');
  });

  it("says it in German, with the plural", () => {
    const markup = page(3, "de");
    expect(markup).toContain(de("workflows.run.doneWithFailures"));
    expect(markup).toContain(de("workflows.run.failedChildRunsMany", { count: "3", total: "600" }));
    expect(markup).toContain(de("workflows.run.showFailedChildRuns"));
  });

  it("calls them entries where the loop starts no child run", () => {
    const markup = render(
      runPage(read(run({ status: "done", ...ended }), [startStep, loopRun(2)]))
    );
    expect(markup).toContain(t("workflows.run.failedEntriesMany", { count: "2", total: "600" }));
    expect(markup).toContain(t("workflows.run.showFailedEntries"));
  });

  it("counts every loop of a kind, and names child runs and other entries apart", () => {
    const twoLoops = toWorkflow({
      name: "notify-clients",
      publishedRevision: 1,
      config: {
        ...definitionOf({
          each_client: {
            steps: [
              { id: "check", name: "Check", type: "workflow", workflow: "client-check", input: {} }
            ]
          }
        }),
        steps: [
          ...definitionOf().steps.slice(0, 2),
          {
            id: "each_client",
            name: "For each client",
            type: "loop",
            items: { step: "clients", path: "" },
            steps: [
              { id: "check", name: "Check", type: "workflow", workflow: "client-check", input: {} }
            ]
          },
          {
            id: "each_partner",
            name: "For each partner",
            type: "loop",
            items: { step: "clients", path: "" },
            steps: [
              {
                id: "check_partner",
                name: "Check",
                type: "workflow",
                workflow: "client-check",
                input: {}
              }
            ]
          },
          {
            id: "each_note",
            name: "For each note",
            type: "loop",
            items: { step: "clients", path: "" },
            steps: [
              { id: "send", name: "Send", type: "operation", operation: "connection.crm.write" }
            ]
          }
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
        { workflow: twoLoops }
      )
    );
    expect(markup).toContain(t("workflows.run.failedChildRunsOne", { count: "1", total: "610" }));
    expect(markup).toContain(t("workflows.run.failedEntriesMany", { count: "2", total: "50" }));
    expect(markup).toContain(t("workflows.run.showFailedChildRuns"));
  });

  // A loop's counts count entries, not child runs: an entry whose body does more than start
  // one child run can fail elsewhere, and two child runs per entry are not one per entry.
  const genericBody = (steps: readonly Record<string, unknown>[]) =>
    render(
      runPage(read(run({ status: "done", ...ended }), [startStep, loopRun(1)]), {
        workflow: workflowOf({ each_client: { steps } })
      })
    );
  const child = (id: string) => ({
    id,
    name: "Check the client",
    type: "workflow" as const,
    workflow: "client-check",
    input: {}
  });

  it("calls them entries where the loop's body also does other work than its child run", () => {
    const markup = genericBody([
      child("check"),
      { id: "send", name: "Send", type: "operation", operation: "connection.crm.write" }
    ]);
    expect(markup).toContain(t("workflows.run.failedEntriesOne", { count: "1", total: "600" }));
    expect(markup).toContain(t("workflows.run.showFailedEntries"));
    expect(markup).not.toContain(t("workflows.run.showFailedChildRuns"));
  });

  it("calls them entries where each entry starts more than one child run", () => {
    const markup = genericBody([child("check"), child("check_again")]);
    expect(markup).toContain(t("workflows.run.failedEntriesOne", { count: "1", total: "600" }));
    expect(markup).not.toContain(
      t("workflows.run.failedChildRunsOne", { count: "1", total: "600" })
    );
  });

  it("shows no state for a done run until its step runs say whether entries failed", () => {
    const loading: WorkflowRunRead = {
      ...read(run({ status: "done", ...ended }), []),
      stepRuns: undefined
    };
    const markup = render(runPage(loading, { workflow: fanOut }));
    expect(markup).not.toContain(t("workflows.run.done"));
    expect(markup).not.toContain(t("workflows.run.doneWithFailures"));
  });

  it("stays a plain Done where nothing failed, and leaves a failed run to its own banner", () => {
    const clean = page(0);
    expect(clean).toContain(t("workflows.run.done"));
    expect(clean).not.toContain(t("workflows.run.doneWithFailures"));
    expect(clean).not.toContain("data-run-failed-entries");
    expect(page(1, "en", "failed")).not.toContain("data-run-failed-entries");
  });

  it("opens the child run from the row of a failed entry", () => {
    const loop = placedSteps(fanOut.steps).get("each_client")?.step;
    if (loop === undefined) throw new Error("The Workflow has no loop.");
    const failedChild = toWorkflowStepRun(
      stepRun({
        id: "sr_0_check",
        stepId: "check",
        stepType: "workflow",
        status: "failed",
        containerStepRunId: "sr_loop",
        iteration: { index: 0, label: "1002 · Weber KG" },
        childRunId: "wr_child_1002",
        error: { code: "child_failed", message: "x" }
      })
    );
    const markup = render(
      createElement(LoopEntriesView, {
        loop,
        counts: { total: 600, done: 599, failed: 1, running: 0 },
        filter: "failed",
        onFilterChange: noop,
        read: {
          stepRuns: [failedChild],
          failed: false,
          hasMore: false,
          loadingMore: false,
          loadMore: noop,
          retry: noop
        },
        onOpenChild: noop
      })
    );
    expect(markup).toContain("1002 · Weber KG");
    expect(markup).toContain('data-child-run="wr_child_1002"');
  });
});

describe("Workflow agent step panels (CR-2)", () => {
  const agentWorkflow = () =>
    toWorkflow({
      name: "notify-clients",
      publishedRevision: 1,
      config: {
        ...definitionOf({
          clients: { type: "agent", instructions: "Check the monthly totals and return JSON." }
        }),
        tools: ["connection.bookings.read"]
      }
    });

  it.each(["en", "de"] as const)("shows instructions and tools in What it does (%s)", (locale) => {
    const markup = panel("clients", run(), [], { tab: "what", workflow: agentWorkflow(), locale });
    expect(markup).toContain("Check the monthly totals and return JSON.");
    expect(markup).toContain("connection.bookings.read");
    expect(markup).not.toContain((locale === "en" ? en : german).t("workflows.step.fallbackAgent"));
  });

  const transcript = (truncated = false) =>
    createElement(StepTranscriptView, {
      transcript: { messages: [{ role: "assistant", text: "The totals agree." }], truncated }
    });

  it.each(["en", "de"] as const)(
    "shows the loaded transcript, validated output and usage (%s)",
    (locale) => {
      const text = locale === "en" ? en : german;
      const agent = {
        runId: "run_ai",
        status: "completed" as const,
        usage: { modelCallCount: 1, inputTokens: 7, outputTokens: 3, totalTokens: 10 }
      };
      const resource = stepRun({
        id: "sr_ai",
        stepId: "clients",
        stepType: "agent",
        agent,
        outputPreview: { text: '{"balanced":true}', truncated: false }
      });
      const markup = panel("clients", run(), [resource], {
        workflow: agentWorkflow(),
        locale,
        transcript: transcript(true)
      });
      expect(markup).toContain("The totals agree.");
      expect(markup).toContain(text.t("workflows.panel.agentTranscriptTruncated"));
      expect(markup).toContain("balanced");
      expect(markup).toContain(text.t("workflows.panel.agentUsage"));
      // A reader without run data gets neither: the panel loads no transcript for them.
      const hidden = panel("clients", run(), [{ ...resource, outputPreview: undefined }], {
        workflow: agentWorkflow(),
        locale
      });
      expect(hidden).not.toContain("The totals agree.");
      expect(hidden).not.toContain("balanced");
    }
  );

  it.each(["en", "de"] as const)(
    "names the operation that needed a confirmation (%s)",
    (locale) => {
      const text = locale === "en" ? en : german;
      const markup = panel(
        "clients",
        run({
          status: "failed",
          ...ended,
          error: { code: "confirmation_unattended", message: "x" }
        }),
        [
          stepRun({
            id: "sr_ai",
            stepId: "clients",
            stepType: "agent",
            status: "failed",
            error: {
              code: "confirmation_unattended",
              message: "x",
              operation: "connection.bookings.write"
            }
          })
        ],
        { workflow: agentWorkflow(), locale }
      );
      expect(markup).toContain(
        text.t("workflows.reason.confirmationUnattendedNamed", {
          operation: "connection.bookings.write"
        })
      );
    }
  );

  it("shows a failure before the transcript so the next action stays visible", () => {
    const markup = panel(
      "clients",
      run(),
      [
        stepRun({
          id: "sr_ai",
          stepId: "clients",
          stepType: "agent",
          status: "failed",
          error: { code: "confirmation_unattended", message: "Unattended" },
          agent: {
            runId: "run_ai",
            status: "failed",
            usage: { modelCallCount: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 }
          }
        })
      ],
      { workflow: agentWorkflow(), transcript: transcript() }
    );
    expect(markup.indexOf("data-failure-happened")).toBeGreaterThan(0);
    expect(markup.indexOf("data-failure-happened")).toBeLessThan(
      markup.indexOf("The totals agree.")
    );
  });
});
