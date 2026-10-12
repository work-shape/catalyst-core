import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  CancelRunDialog,
  StartDialog,
  WorkflowPageView,
  WorkflowRunPageView,
  WorkflowRunsPageView,
  WorkflowsPageView,
  cancelOffered,
  runListRefreshMs,
  runRefreshMs,
  startOffered,
  toWorkflow,
  toWorkflowListItem,
  toWorkflowRun,
  toWorkflowStepRun,
  type WorkflowRunList,
  type WorkflowRunRead
} from "@vivd-catalyst/chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The screens of the Workflows area, each state from fixtures built here and taken through the
// mapping of the data module, as an answer of the instance is. Every test here fails without
// the area: the screens and the mapping did not exist.

const { t } = createTranslationContext("en");
const de = createTranslationContext("de").t;

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const now = new Date("2026-10-12T09:12:00.000Z");
const noop = () => undefined;
const READER = { read: true, start: true, write: false };

type RunResource = Parameters<typeof toWorkflowRun>[0];
type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];

/** A definition as an asset record carries it: the parsed `workflow.yaml`. */
const definition = {
  id: "notify-clients",
  name: "Notify clients",
  description: "Reads the clients and sends each of them a note.",
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "clients",
      name: "Read the clients",
      description: "Fetches every active client.",
      type: "operation",
      operation: "connection.crm.list",
      input: {}
    },
    {
      id: "each_client",
      name: "For each client",
      type: "loop",
      items: { step: "clients", path: "clients" },
      itemName: "client",
      itemLabel: "name",
      steps: [
        {
          id: "check",
          name: "Check the bookings",
          type: "code",
          file: "check.py",
          input: { client: { ref: { step: "each_client", path: "" } } },
          inputSchema: { type: "object" },
          outputSchema: { type: "object" }
        },
        {
          id: "send",
          name: "Send the note",
          type: "operation",
          operation: "connection.crm.write",
          input: {}
        }
      ]
    },
    {
      id: "summary",
      name: "Write the summary",
      type: "agent",
      instructions: "summary.md",
      input: {
        findings: { ref: { step: "each_client", path: "" } },
        month: { ref: { step: "start", path: "month" } }
      },
      inputSchema: { type: "object" },
      outputSchema: { type: "object" }
    },
    { id: "result", name: "Result", type: "output", input: {} }
  ],
  wiring: [
    { from: "start", to: "clients" },
    { from: "clients", to: "each_client" },
    { from: "each_client", to: "summary" },
    { from: "summary", to: "result" }
  ]
};

const workflow = toWorkflow({ name: "notify-clients", config: definition, publishedRevision: 3 });

function runResource(input: Partial<RunResource> = {}): RunResource {
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

function stepRunResource(
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

function runRead(run: RunResource, stepRuns: readonly StepRunResource[]): WorkflowRunRead {
  return {
    run: toWorkflowRun(run),
    problem: undefined,
    silentSince: undefined,
    stepRuns: stepRuns.map(toWorkflowStepRun),
    retry: noop
  };
}

const runPage = (
  read: WorkflowRunRead,
  options: { canCancel?: boolean; stopping?: boolean } = {}
) =>
  createElement(WorkflowRunPageView, {
    workspaceId: "cw_1",
    workflowId: "notify-clients",
    workflow,
    read,
    now,
    canCancel: options.canCancel ?? false,
    canRunAgain: false,
    stopping: options.stopping ?? false,
    onCancel: noop,
    onRunAgain: noop,
    onOpenRoute: noop
  });

function runList(input: Partial<WorkflowRunList> = {}): WorkflowRunList {
  return {
    rows: [],
    failed: false,
    hasMore: false,
    loadingMore: false,
    loadMore: noop,
    retry: noop,
    ...input
  };
}

const startStep = stepRunResource({ id: "sr_start", stepId: "start", stepType: "trigger" });
const clientsStep = stepRunResource({
  id: "sr_clients",
  stepId: "clients",
  outputPreview: { text: '{"clients":[{"name":"Nordlicht"}]}', truncated: false }
});

describe("the list of Workflows", () => {
  const listPage = (rows: Parameters<typeof toWorkflowListItem>[0][] | undefined, failed = false) =>
    createElement(WorkflowsPageView, {
      workspaceId: "cw_1",
      list: {
        rows: rows?.map((row) => toWorkflowListItem(row)),
        failed,
        hasMore: false,
        loadingMore: false,
        loadMore: noop,
        retry: noop
      },
      now,
      onOpenRoute: noop
    });
  const summary = {
    id: "asset_1",
    kind: "workflow",
    name: "notify-clients",
    title: "Notify clients",
    description: "Reads the clients and sends each of them a note.",
    scope: { kind: "workspace" as const, workspaceId: "cw_1" },
    revision: 3,
    publishedRevision: 3,
    updatedAt: "2026-10-10T09:00:00.000Z"
  };

  it("says in one sentence that a workspace has no Workflows, and offers nothing to build", () => {
    const markup = render(listPage([]));
    expect(markup).toContain(t("workflows.emptyReadOnly"));
    expect(markup).toContain(t("workflows.description"));
    expect(markup).not.toContain("<button");
    expect(render(listPage([]), "de")).toContain(de("workflows.emptyReadOnly"));
  });

  it("lists each Workflow by its name and its sentence, with a link to its page", () => {
    const markup = render(listPage([summary]));
    expect(markup).toContain("Notify clients");
    expect(markup).toContain("Reads the clients and sends each of them a note.");
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients"');
    // The id is a builder's: the row never shows it as text.
    expect(markup.replaceAll('href="/w/cw_1/workflows/notify-clients"', "")).not.toContain(
      "notify-clients"
    );
  });

  it("gives a Workflow without a published revision no link", () => {
    const { publishedRevision: _published, ...draftOnly } = summary;
    expect(render(listPage([draftOnly]))).not.toContain("href=");
  });

  it("shows placeholders while the list loads, and the head at once", () => {
    const markup = render(listPage(undefined));
    expect(markup).toContain(t("workflows.title"));
    expect(markup).toContain("animate-pulse");
    expect(markup).not.toContain(t("workflows.emptyReadOnly"));
  });

  it("says that the list could not be loaded and offers to try again", () => {
    const markup = render(listPage(undefined, true));
    expect(markup).toContain(t("workflows.listFailed"));
    expect(markup).toContain(t("tryAgain"));
  });
});

describe("the page of a Workflow", () => {
  const page = (
    input: {
      workflow?: typeof workflow;
      problem?: "missing" | "unavailable" | "failed";
      runsAvailable?: boolean;
      rights?: typeof READER;
    } = {}
  ) =>
    createElement(WorkflowPageView, {
      workspaceId: "cw_1",
      workflowId: "notify-clients",
      read: {
        workflow: input.problem ? undefined : (input.workflow ?? workflow),
        problem: input.problem,
        retry: noop
      },
      rights: input.rights ?? READER,
      runsAvailable: input.runsAvailable ?? true,
      onOpenChild: noop,
      onLeaveChildren: noop,
      onOpenRoute: noop,
      onStart: noop
    });

  it("names the Workflow, says what it does and offers its drawing, its runs and a start", () => {
    const markup = render(page());
    expect(markup).toContain("Notify clients");
    expect(markup).toContain("Reads the clients and sends each of them a note.");
    expect(markup).toContain(t("workflows.startNow"));
    expect(markup).toContain(t("workflows.tabWorkflow"));
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients/runs"');
    // The drawing is a region of its own, named after the Workflow.
    expect(markup).toContain('data-testid="workflow-canvas"');
  });

  it("offers neither a start nor the runs where the instance runs no Workflow", () => {
    const markup = render(page({ runsAvailable: false }));
    expect(markup).toContain("Notify clients");
    expect(markup).not.toContain(t("workflows.startNow"));
    expect(markup).not.toContain('href="/w/cw_1/workflows/notify-clients/runs"');
  });

  it("shows no id, no operation name and no file name of the definition", () => {
    const markup = render(page());
    for (const internal of ["connection.crm", "check.py", "summary.md", "workflow-runner"]) {
      expect(markup).not.toContain(internal);
    }
  });

  it("leaves the start out for a Workflow that asks for input: there is no form yet", () => {
    const asking = toWorkflow({
      name: "top-customers",
      publishedRevision: 1,
      config: {
        ...definition,
        inputs: { type: "object", properties: { limit: { type: "integer" } }, required: ["limit"] }
      }
    });
    expect(startOffered(asking, READER)).toBe(false);
    expect(render(page({ workflow: asking }))).not.toContain(t("workflows.startNow"));
  });

  it("offers the start only where a revision is published and the reader may start", () => {
    expect(startOffered(workflow, READER)).toBe(true);
    expect(startOffered(workflow, { ...READER, start: false })).toBe(false);
    expect(startOffered({ ...workflow, published: false }, READER)).toBe(false);
    expect(startOffered({ ...workflow, startsByHand: false }, READER)).toBe(false);
    expect(render(page({ rights: { ...READER, start: false } }))).not.toContain(
      t("workflows.startNow")
    );
  });

  it("shows placeholders while the Workflow loads", () => {
    const markup = render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "notify-clients",
        read: { workflow: undefined, problem: undefined, retry: noop },
        rights: READER,
        runsAvailable: true,
        onOpenChild: noop,
        onLeaveChildren: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );
    expect(markup).toContain("animate-pulse");
    expect(markup).toContain(t("workflows.backToList"));
    expect(markup).not.toContain("notify-clients</");
  });

  it.each([
    ["missing", "workflows.missing"],
    ["unavailable", "workflows.unavailable"],
    ["failed", "workflows.failed"]
  ] as const)("says in a sentence when the Workflow is %s", (problem, key) => {
    const markup = render(page({ problem }));
    expect(markup).toContain(t(key));
    expect(markup).not.toContain('data-testid="workflow-canvas"');
    expect(markup.includes(t("tryAgain"))).toBe(problem === "failed");
  });

  it("names the way to a Workflow a step opened, with a way back to each before it", () => {
    const child = toWorkflow({
      name: "send-reminders",
      publishedRevision: 1,
      config: { ...definition, id: "send-reminders", name: "Send reminders" }
    });
    const markup = render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "notify-clients",
        read: { workflow, problem: undefined, retry: noop },
        way: [{ id: "send-reminders", stepName: "Send reminders" }],
        child: { workflow: child, problem: undefined, retry: noop },
        rights: READER,
        runsAvailable: true,
        onOpenChild: noop,
        onLeaveChildren: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );
    expect(markup).toContain('data-slot="breadcrumb"');
    expect(markup).toMatch(/aria-current="page"[^>]*>Send reminders</u);
    // The page stays the page of the Workflow it was opened for.
    expect(markup).toContain(">Notify clients</h1>");
  });

  it("asks once before the start and answers a refusal in the dialog", () => {
    const dialog = (error?: string) =>
      render(
        createElement(StartDialog, {
          name: "Notify clients",
          loading: false,
          error,
          onConfirm: noop,
          onClose: noop
        })
      );
    expect(dialog()).toContain(t("workflows.start.title", { name: "Notify clients" }));
    expect(dialog()).toContain(t("workflows.start.bodyManual"));
    expect(dialog(t("workflows.start.refused"))).toContain(t("workflows.start.refused"));
  });
});

describe("the runs of a Workflow", () => {
  const page = (runs: WorkflowRunList, runsAvailable = true) =>
    createElement(WorkflowRunsPageView, {
      workspaceId: "cw_1",
      workflowId: "notify-clients",
      workflow,
      runs,
      rights: READER,
      runsAvailable,
      now,
      onStart: noop,
      onOpenRoute: noop
    });

  it("names the Workflow and says that there are no runs", () => {
    const markup = render(page(runList()));
    expect(markup).toContain("Notify clients");
    expect(markup).toContain(t("workflows.noRuns"));
  });

  it("lists each run with how it ended, each a link to its run", () => {
    const rows = [
      toWorkflowRun(runResource({ id: "wr_2", status: "failed", trigger: "schedule" })),
      toWorkflowRun(runResource({ id: "wr_1", status: "done" }))
    ];
    const markup = render(page(runList({ rows })));
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients/runs/wr_2"');
    expect(markup).toContain(t("workflows.run.failed"));
    expect(markup).toContain(t("workflows.run.done"));
    expect(markup).toContain("Ada Lovelace");
  });

  it("offers more runs where the instance has more", () => {
    const rows = [toWorkflowRun(runResource({ status: "failed", trigger: "schedule" }))];
    const markup = render(page(runList({ rows, hasMore: true })));
    expect(markup).toContain(t("workflows.showMore"));
  });

  it("says that the runs could not be loaded", () => {
    const markup = render(page(runList({ rows: undefined, failed: true })));
    expect(markup).toContain(t("workflows.runs.listFailed"));
    expect(markup).toContain(t("tryAgain"));
  });

  it("says that the instance runs no Workflow yet, in both languages", () => {
    expect(render(page(runList(), false))).toContain(t("workflows.runsUnavailable"));
    expect(render(page(runList(), false), "de")).toContain(de("workflows.runsUnavailable"));
  });

  it("reads a list again only while one of its runs is going", () => {
    expect(runListRefreshMs([toWorkflowRun(runResource({ status: "done" }))])).toBe(false);
    expect(runListRefreshMs([toWorkflowRun(runResource({ status: "running" }))])).toBe(5_000);
    expect(runListRefreshMs([])).toBe(false);
  });
});

describe("the page of a run", () => {
  it("reads a run again every two seconds until it has ended", () => {
    expect(runRefreshMs(toWorkflowRun(runResource({ status: "queued" })))).toBe(2_000);
    expect(runRefreshMs(toWorkflowRun(runResource({ status: "running" })))).toBe(2_000);
    expect(runRefreshMs(toWorkflowRun(runResource({ status: "waiting" })))).toBe(2_000);
    for (const status of ["done", "failed", "cancelled", "limit_reached"] as const) {
      expect(runRefreshMs(toWorkflowRun(runResource({ status })))).toBe(false);
    }
    expect(runRefreshMs(undefined)).toBe(false);
  });

  it("says of a queued run that it begins by itself, in both languages", () => {
    const read = runRead(runResource({ status: "queued", startedAt: undefined }), []);
    const markup = render(runPage(read));
    expect(markup).toContain(t("workflows.run.queued"));
    expect(markup).toContain(t("workflows.run.queuedLine"));
    expect(render(runPage(read), "de")).toContain(de("workflows.run.queuedLine"));
  });

  it("names the run, its Workflow, who started it and for how long it has run, and offers the cancel", () => {
    const markup = render(runPage(runRead(runResource(), [startStep]), { canCancel: true }));
    expect(markup).toContain(t("workflows.run.running"));
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients"');
    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain(t("workflows.run.soFar", { duration: "11 min" }));
    expect(markup).toContain(t("workflows.run.cancel"));
    expect(markup).toContain('data-testid="workflow-canvas"');
    // A run at work has nothing to say above its drawing.
    expect(markup).not.toContain("data-run-notices");
  });

  it("shows a run that is done with how long it took and no way to cancel it", () => {
    const done = runResource({ status: "done", finishedAt: "2026-10-12T09:00:42.000Z" });
    const markup = render(runPage(runRead(done, [startStep]), { canCancel: false }));
    expect(markup).toContain(t("workflows.run.done"));
    expect(markup).not.toContain(t("workflows.run.cancel"));
    expect(markup).toContain("41 sec");
    expect(markup).not.toContain(t("workflows.run.soFar", { duration: "41 sec" }));
  });

  const failedRun = runResource({
    status: "failed",
    finishedAt: "2026-10-12T09:00:12.000Z",
    error: { code: "operation_failed", message: "The call of the operation failed" }
  });

  it("leaves the reason of a failed run to the step that failed, once the page holds it", () => {
    const failedStep = stepRunResource({
      id: "sr_clients",
      stepId: "clients",
      status: "failed",
      error: { code: "operation_failed", message: "The call of the operation failed" }
    });
    const withStep = render(runPage(runRead(failedRun, [startStep, failedStep])));
    expect(withStep).toContain(t("workflows.run.failed"));
    expect(withStep).not.toContain(t("workflows.reason.other"));
    // Until the step has arrived, the run says why it ended.
    const without = render(runPage(runRead(failedRun, [startStep])));
    expect(without).toContain(t("workflows.reason.other"));
    expect(without).toContain(t("workflows.technicalDetails"));
    expect(without).not.toContain("operation_failed");
  });

  it("shows a cancelled run with when it was cancelled", () => {
    const run = runResource({ status: "cancelled", finishedAt: "2026-10-12T09:03:00.000Z" });
    const markup = render(runPage(runRead(run, [startStep])));
    expect(markup).toContain(t("workflows.run.cancelled"));
    expect(markup).toContain(
      t("workflows.run.cancelledLine", {
        time: new Date("2026-10-12T09:03:00.000Z").toLocaleTimeString("en")
      })
    );
    expect(markup).not.toContain(t("workflows.run.cancel"));
  });

  it("says which limit stopped a run that reached one", () => {
    const run = runResource({
      status: "limit_reached",
      finishedAt: "2026-10-12T09:30:00.000Z",
      error: { code: "step_limit", message: "The run reached its limit of 50000 steps" }
    });
    const markup = render(runPage(runRead(run, [startStep, clientsStep])));
    expect(markup).toContain(t("workflows.run.limitReached"));
    expect(markup).toContain(t("workflows.reason.stepLimit"));
    // The instance's own sentence waits behind a fold; its code is never shown.
    expect(markup).toContain(t("workflows.technicalDetails"));
    expect(markup).not.toContain("step_limit");
    const german = render(runPage(runRead(run, [startStep, clientsStep])), "de");
    expect(german).toContain(de("workflows.run.limitReached"));
    expect(german).toContain(de("workflows.reason.stepLimit"));
  });

  it("says that a run waits, and that a run is being stopped until the instance has ended it", () => {
    expect(render(runPage(runRead(runResource({ status: "waiting" }), [startStep])))).toContain(
      t("workflows.run.waitingLine")
    );
    const markup = render(
      runPage(runRead(runResource(), [startStep]), { canCancel: true, stopping: true })
    );
    expect(markup).toContain(t("workflows.run.stopping"));
    expect(markup).not.toContain(t("workflows.run.cancel"));
  });

  it("leads from a child run back to the run that started it", () => {
    const child = runResource({
      id: "wr_2",
      trigger: "parent",
      parentRunId: "wr_1",
      parentWorkflow: "quarter-close"
    });
    const markup = render(runPage(runRead(child, [startStep])));
    expect(markup).toContain('data-slot="breadcrumb"');
    expect(markup).toContain('href="/w/cw_1/workflows/quarter-close/runs/wr_1"');
    expect(markup).toContain(t("workflows.run.parent"));
  });

  it("offers the cancel to whoever started the run, and to whoever may write Workflows", () => {
    const going = toWorkflowRun(runResource());
    const ended = toWorkflowRun(runResource({ status: "done" }));
    expect(cancelOffered(going, "user_1", READER)).toBe(true);
    expect(cancelOffered(going, "user_2", READER)).toBe(false);
    expect(cancelOffered(going, "user_2", { ...READER, write: true })).toBe(true);
    expect(cancelOffered(ended, "user_1", { ...READER, write: true })).toBe(false);
  });

  it("asks once before a run is cancelled, with a way to keep it running", () => {
    const dialog = (error?: string, locale: "en" | "de" = "en") =>
      render(
        createElement(CancelRunDialog, { loading: false, error, onConfirm: noop, onClose: noop }),
        locale
      );
    expect(dialog()).toContain(t("workflows.run.cancelTitle"));
    expect(dialog()).toContain(t("workflows.run.cancelBody"));
    expect(dialog()).toContain(t("workflows.run.cancelKeep"));
    expect(dialog(t("workflows.run.cancelFailed"))).toContain(t("workflows.run.cancelFailed"));
    expect(dialog(undefined, "de")).toContain(de("workflows.run.cancelKeep"));
  });

  const unread = { run: undefined, silentSince: undefined, stepRuns: undefined, retry: noop };

  it("shows placeholders while the run loads", () => {
    const markup = render(runPage({ ...unread, problem: undefined }));
    expect(markup).toContain("animate-pulse");
    expect(markup).toContain(t("workflows.backToRuns"));
  });

  it.each([
    ["missing", "workflows.run.missing"],
    ["unavailable", "workflows.run.unavailable"],
    ["failed", "workflows.run.failedToLoad"]
  ] as const)("says in a sentence when the run is %s", (problem, key) => {
    const markup = render(runPage({ ...unread, problem }));
    expect(markup).toContain(t(key));
    expect(markup.includes(t("tryAgain"))).toBe(problem === "failed");
  });

  it("says for how long the instance has not answered, and keeps the last state readable", () => {
    const read = runRead(runResource(), [startStep]);
    const markup = render(runPage({ ...read, silentSince: now.getTime() - 9_000 }));
    expect(markup).toContain(t("workflows.run.stale", { seconds: 9 }));
    expect(markup).toContain(t("workflows.run.running"));
  });
});
