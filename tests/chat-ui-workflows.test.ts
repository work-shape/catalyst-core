import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  areaOfRoute,
  createInstanceSource,
  instanceTimeZoneOf,
  railSections,
  resolveWorkflowRights,
  shownRailSections,
  StartDialog,
  WorkflowPageView,
  WorkflowRunPageView,
  WorkflowRunsPageView,
  WorkflowsPageView,
  cancelOffered,
  listedToReader,
  runListRefreshMs,
  runRefreshMs,
  startFormOf,
  startOffered,
  toWorkflow,
  toAssetWorkflowListItem,
  toWorkflowListItem,
  toWorkflowRun,
  toWorkflowStepRun,
  WorkflowRemoveKnowledge,
  workflowsAccess,
  workflowsRowShown,
  workspaceRouteFromPath,
  workspaceRoutePath,
  type WorkflowRunList,
  type WorkflowRunRead
} from "@work-shape/catalyst-chat-ui/workflows";
import { workflowsContext } from "./chat-ui-build-fixtures";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// The screens of the Workflows area, each state from fixtures built here and taken through the
// mapping of the data module, as an answer of the instance is; who is shown the area, its
// addresses, and the question before a Workflow is deleted.

const { t } = createTranslationContext("en");

const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));

const now = new Date("2026-10-12T09:12:00.000Z");
const noop = () => undefined;
/** Rights on the instance's Workflows: `write` as given, reading always. */
const onInstance = (write: boolean) => ({
  instance: { read: true, write, publish: false, delete: false }
});

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

const workflow = toWorkflow(
  { name: "notify-clients", config: definition, publishedRevision: 3 },
  { mayStart: true }
);

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
    stepsFailed: false,
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
  const listPage = (
    rows: Parameters<typeof toWorkflowListItem>[0][] | undefined,
    failed = false,
    runsAvailable = true
  ) =>
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
      runsAvailable,
      onOpenRoute: noop,
      onStart: noop
    });
  const summary = {
    id: "notify-clients",
    name: "Notify clients",
    description: "Reads the clients and sends each of them a note."
  };

  it("offers a builder the agent on the empty list, a reader nothing, and New once there are Workflows", () => {
    expect(render(listPage([]))).not.toContain("<button");
    const page = (rows: Parameters<typeof listPage>[0]) =>
      render(createElement(WorkflowsPageView, { ...listPage(rows).props, onNew: noop }));
    const empty = page([]);
    expect(empty).toContain(t("workflows.empty"));
    expect(empty).not.toContain(t("workflows.new"));
    // While the list loads, New stands: making one never waits for the answer.
    expect(page(undefined)).toContain(t("workflows.new"));
    expect(page([summary])).toContain(t("workflows.new"));
    expect(page([summary])).not.toContain(t("workflows.empty"));
  });

  // DISCOVERY-PAGING: a page may come back empty with more to read. The list is empty only once
  // read to its end; before that it offers the next page, not its empty state.
  it("offers the next page, not the empty state, where an empty page has more after it", () => {
    const view = listPage([]);
    const markup = render(
      createElement(WorkflowsPageView, {
        ...view.props,
        onNew: noop,
        list: { ...view.props.list, hasMore: true }
      })
    );
    expect(markup).toContain("data-workflows-more");
    expect(markup).not.toContain(t("workflows.empty"));
    expect(markup).not.toContain(t("workflows.emptyReadOnly"));
  });

  it("links each card to its Workflow, and to its runs only once it ran", () => {
    const never = render(listPage([summary]));
    expect(never.match(/data-card-target=""/gu)).toHaveLength(1);
    expect(never).toMatch(
      /<a[^>]*data-card-target=""[^>]*href="\/w\/cw_1\/workflows\/notify-clients"/u
    );
    expect(never).not.toContain('href="/w/cw_1/workflows/notify-clients/runs"');
    const ran = render(
      listPage([
        {
          ...summary,
          lastRun: { id: "wr_9", status: "failed", startedAt: "2026-10-12T09:00:00.000Z" }
        }
      ])
    );
    expect(ran).toContain(t("workflows.run.failed"));
    expect(ran).toContain('href="/w/cw_1/workflows/notify-clients/runs"');
  });

  it("lists a draft never published to who may write Workflows, opening on its page (NAV-2)", () => {
    const draft = toAssetWorkflowListItem({
      name: "first-draft",
      title: "First draft",
      updatedAt: "2026-10-12T09:00:00.000Z"
    });
    expect(listedToReader(draft, onInstance(true))).toBe(true);
    expect(listedToReader(draft, onInstance(false))).toBe(false);
    expect(listedToReader(toWorkflowListItem(summary), onInstance(false))).toBe(true);
    const markup = render(
      createElement(WorkflowsPageView, {
        ...listPage([]).props,
        list: { ...listPage([]).props.list, rows: [draft] }
      })
    );
    expect(markup).toContain('href="/w/cw_1/workflows/first-draft"');
    expect(markup).not.toContain(t("workflows.startNow"));
  });

  it("warns that a Workflow cannot be started, but not one that only runs on its schedule", () => {
    const issue = (code: string) => ({ code, message: "Refused." });
    const scheduled = render(listPage([{ ...summary, reasons: [issue("no_manual_trigger")] }]));
    expect(scheduled).not.toContain(t("workflows.notRunnable.badge"));
    const refused = render(listPage([{ ...summary, reasons: [issue("not_supported_yet")] }]));
    expect(refused).toContain(t("workflows.notRunnable.badge"));
  });

  it("offers a start on the card of a Workflow the reader may start, with or without inputs", () => {
    const usable = {
      ...summary,
      actions: ["workflow.read", "workflow.use"],
      inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] }
    };
    expect(render(listPage([usable]))).toContain(t("workflows.startNow"));
    // Not to a reader, not where the instance runs no Workflow, and not where it is refused.
    expect(render(listPage([{ ...usable, actions: ["workflow.read"] }]))).not.toContain(
      t("workflows.startNow")
    );
    expect(render(listPage([usable], false, false))).not.toContain(t("workflows.startNow"));
    const issue = { code: "no_manual_trigger", message: "Refused." };
    expect(render(listPage([{ ...usable, reasons: [issue] }]))).not.toContain(
      t("workflows.startNow")
    );
    // A required input the form has no field for leaves the start to the agent and the API.
    const list = { type: "object", properties: { ids: { type: "array" } }, required: ["ids"] };
    expect(render(listPage([{ ...usable, inputs: list }]))).not.toContain(t("workflows.startNow"));
  });

  it("offers to try again where the list could not be loaded", () => {
    expect(render(listPage(undefined, true))).toContain(t("tryAgain"));
  });

  it("lists every Workflow at first and offers the kinds as a filter (WF-KIND)", () => {
    const importer = {
      id: "invoice-import",
      name: "Invoice import",
      description: "Puts each new invoice into the knowledge base.",
      kind: "data" as const
    };
    const reminder = { ...summary, kind: "process" as const };
    expect(toWorkflowListItem(importer).kind).toBe("data");
    // A Workflow the list names without a kind, and a draft never published, are processes.
    expect(toWorkflowListItem(summary).kind).toBe("process");
    const draft = (attributes?: Record<string, string | boolean>) =>
      toAssetWorkflowListItem({
        name: "d",
        title: "D",
        updatedAt: now.toISOString(),
        ...(attributes ? { attributes } : {})
      }).kind;
    expect(draft({ workflowKind: "data" })).toBe("data");
    expect(draft({ workflowKind: "other" })).toBe("process");
    expect(draft()).toBe("process");

    // Every Workflow stands on the list at first: nothing waits behind a filter.
    const markup = render(listPage([importer, reminder]));
    expect(markup).toContain("Notify clients");
    expect(markup).toContain("Invoice import");
    expect(markup).toContain(t("workflows.kindData"));
    // Without both kinds there is nothing to choose between.
    expect(render(listPage([reminder]))).not.toContain(t("workflows.kindData"));
    const onlyData = render(listPage([importer]));
    expect(onlyData).toContain("Invoice import");
    expect(onlyData).not.toContain(t("workflows.kindAll"));
  });

  // A Workflow's card names the Apps that start it: two by name, the rest counted, each a link
  // to its App in the workspace that owns it. No line where none does.
  it("names two Apps that start a Workflow on its card, counts the rest, and links each", () => {
    const app = (name: string, title: string, workspaceId?: string) => ({
      name,
      title,
      scope:
        workspaceId === undefined
          ? { kind: "instance" as const }
          : { kind: "workspace" as const, workspaceId }
    });
    const card = (appCallers?: ReturnType<typeof app>[]) => {
      const view = listPage([]);
      return render(
        createElement(WorkflowsPageView, {
          ...view.props,
          list: {
            ...view.props.list,
            rows: [toWorkflowListItem(summary, appCallers ? { appCallers } : undefined)]
          }
        })
      );
    };
    const apps = [
      app("a", "Alpha", "cw_2"),
      app("b", "Beta"),
      app("c", "Gamma"),
      app("d", "Delta")
    ];
    const markup = card(apps);
    const appLink = (workspace: string, name: string) =>
      `href="${workspaceRoutePath({ kind: "app", collaborationWorkspaceId: workspace, app: name })}"`;
    expect(markup).toContain(appLink("cw_2", "a"));
    expect(markup).toContain(appLink("cw_1", "b"));
    expect(markup).not.toContain(appLink("cw_1", "c"));
    expect(markup).toContain("2 more");
    expect(card()).not.toContain("data-workflow-app-callers");
    expect(card([])).not.toContain("data-workflow-app-callers");
  });
});

describe("the page of a Workflow", () => {
  const page = (
    input: {
      workflow?: typeof workflow;
      problem?: "missing" | "unavailable" | "failed";
      runsAvailable?: boolean;
      lastRun?: {
        id: string;
        status: "failed" | "done" | "limit_reached";
        failedItemCount: number;
        failedDescendantCount: number;
      };
      liveSteps?: (typeof workflow)["steps"];
    } = {}
  ) =>
    createElement(WorkflowPageView, {
      ...(input.liveSteps === undefined ? {} : { liveSteps: input.liveSteps }),
      ...(input.lastRun === undefined ? {} : { lastRun: input.lastRun }),
      workspaceId: "cw_1",
      workflowId: "notify-clients",
      read: {
        workflow: input.problem ? undefined : (input.workflow ?? workflow),
        problem: input.problem,
        retry: noop
      },
      runsAvailable: input.runsAvailable ?? true,
      onOpenChild: noop,
      onOpenRoute: noop,
      onStart: noop
    });

  it("offers its drawing, its runs and a start, and neither where the instance runs no Workflow", () => {
    const markup = render(page());
    expect(markup).toContain(t("workflows.startNow"));
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients/runs"');
    expect(markup).toContain('data-testid="workflow-canvas"');
    const off = render(page({ runsAvailable: false }));
    expect(off).not.toContain(t("workflows.startNow"));
    expect(off).not.toContain('href="/w/cw_1/workflows/notify-clients/runs"');
  });

  it("says in its head when the published revision runs, not the draft the reader is shown", () => {
    const monday = { kind: "schedule", cron: "0 8 * * 1", timeZone: "Europe/Berlin" };
    const config = (triggers: readonly Record<string, unknown>[]) => ({
      ...definition,
      steps: [{ ...definition.steps[0], triggers }, ...definition.steps.slice(1)]
    });
    const shown = (
      pointers: { draftRevision?: number; publishedRevision?: number },
      liveSteps?: (typeof workflow)["steps"]
    ) =>
      /data-workflow-when=""[^>]*>([^<]*)</u.exec(
        render(
          page({
            workflow: toWorkflow(
              {
                name: "notify-clients",
                config: config([monday]),
                publishedRevision: pointers.publishedRevision
              },
              { mayStart: true, runsAs: "Monthly close" },
              pointers
            ),
            ...(liveSteps === undefined ? {} : { liveSteps })
          })
        )
      )?.[1];
    expect(shown({ draftRevision: 3, publishedRevision: 3 })).toBe(
      "Runs every Monday at 08:00 AM (Berlin time)"
    );
    // The draft differs: the line waits for the published revision and says that one.
    expect(shown({ draftRevision: 4, publishedRevision: 3 })).toBeUndefined();
    const live = toWorkflow(
      { name: "notify-clients", config: config([{ kind: "manual" }]), publishedRevision: 3 },
      { mayStart: true }
    ).steps;
    expect(shown({ draftRevision: 4, publishedRevision: 3 }, live)).toBe(
      t("workflows.schedule.manualOnly")
    );
    // Never published: it runs in no way yet.
    expect(shown({ draftRevision: 1 })).toContain("Runs every Monday");
    expect(shown({ draftRevision: 1 })).not.toBe("Runs every Monday at 08:00 AM (Berlin time)");
  });

  it("says at the top that the last run failed, with the way to it", () => {
    const run = (status: "failed" | "done" | "limit_reached", failedItemCount = 0) => ({
      id: "wr_9",
      status,
      failedItemCount,
      failedDescendantCount: 0
    });
    expect(render(page({ lastRun: run("limit_reached") }))).toContain("data-last-run-failed");
    expect(render(page({ lastRun: run("done", 2) }))).toContain("data-last-run-failed");
    const failed = render(page({ lastRun: run("failed") }));
    expect(failed).toContain('href="/w/cw_1/workflows/notify-clients/runs/wr_9"');
    // A run that ended well says nothing, and nothing is said where the instance runs none.
    expect(render(page({ lastRun: run("done") }))).not.toContain("data-last-run-failed");
    expect(render(page({ lastRun: run("failed"), runsAvailable: false }))).not.toContain(
      "data-last-run-failed"
    );
  });

  it("shows no id, no operation name, no file name and no account name of the definition", () => {
    const blocked = {
      ...workflow,
      refusedFor: [
        {
          code: "principal_inactive",
          message: "The internal account workflow-runner is disabled.",
          principalDisplayLabel: "Booking checks"
        }
      ]
    };
    const markup = render(page({ workflow: blocked }));
    for (const internal of ["connection.crm", "check.py", "summary.md", "workflow-runner"]) {
      expect(markup).not.toContain(internal);
    }
    expect(markup).toContain("Booking checks");
  });

  it("offers the start only where a revision is published, the reader may start it and the form can ask", () => {
    expect(startOffered(workflow)).toBe(true);
    expect(startOffered({ ...workflow, mayStart: false })).toBe(false);
    expect(startOffered({ ...workflow, published: false })).toBe(false);
    expect(startOffered({ ...workflow, startsByHand: false })).toBe(false);
    expect(render(page({ workflow: { ...workflow, mayStart: false } }))).not.toContain(
      t("workflows.startNow")
    );
    const asking = (inputs: Record<string, unknown>) =>
      toWorkflow(
        { name: "top-customers", publishedRevision: 1, config: definition },
        { mayStart: true, startForm: startFormOf(inputs) }
      );
    const limit = asking({
      type: "object",
      properties: { limit: { type: "integer" } },
      required: ["limit"]
    });
    expect(startOffered(limit)).toBe(true);
    // A required list has no field: the start stays with the agent and the API.
    const list = asking({
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"]
    });
    expect(startOffered(list)).toBe(false);
    expect(render(page({ workflow: list }))).not.toContain(t("workflows.startNow"));
  });

  it("shows no drawing where the Workflow could not be read, and a retry only where it failed", () => {
    for (const problem of ["missing", "unavailable", "failed"] as const) {
      const markup = render(page({ problem }));
      expect(markup).not.toContain('data-testid="workflow-canvas"');
      expect(markup.includes(t("tryAgain"))).toBe(problem === "failed");
    }
    const missing = render(page({ problem: "missing" }));
    expect(missing).toContain("data-not-found");
    expect(missing).toContain('href="/w/cw_1/workflows"');
  });

  it("shows a Workflow a step opened as its own page, with a link back to each before it", () => {
    const child = toWorkflow({
      name: "send-reminders",
      publishedRevision: 1,
      config: { ...definition, id: "send-reminders", name: "Send reminders" }
    });
    const markup = render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "send-reminders",
        read: { workflow: child, problem: undefined, retry: noop },
        trail: [
          {
            id: "notify-clients",
            name: "Notify clients",
            route: {
              kind: "workflow",
              collaborationWorkspaceId: "cw_1",
              workflow: "notify-clients"
            }
          }
        ],
        runsAvailable: true,
        onOpenChild: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients"');
    // The start and the runs are those of the Workflow that is shown.
    expect(markup).toContain('href="/w/cw_1/workflows/send-reminders/runs"');
  });

  it("asks for the inputs in the start dialog, with defaults and the instance's refusal of a value", () => {
    const form = startFormOf({
      type: "object",
      properties: {
        month: { type: "string", format: "date", title: "Month" },
        limit: { type: "integer", default: 10 },
        region: { type: "string", enum: ["north", "south"] }
      },
      required: ["month", "region"]
    });
    const markup = render(
      createElement(StartDialog, {
        name: "Top customers",
        form,
        loading: false,
        error: undefined,
        refusedValues: [{ path: ["limit"], message: "must be <= 100" }],
        onConfirm: noop,
        onClose: noop
      })
    );
    expect(markup).toContain('type="date"');
    expect(markup).toContain('value="10"');
    expect(markup).toContain(">north<");
    expect(markup).toContain("must be &lt;= 100");
  });
});

describe("the runs of a Workflow", () => {
  const page = (runs: WorkflowRunList, runsAvailable = true) =>
    createElement(WorkflowRunsPageView, {
      workspaceId: "cw_1",
      workflowId: "notify-clients",
      workflow,
      runs,
      runsAvailable,
      now,
      onStart: noop,
      onOpenRoute: noop
    });

  it("lists each run with how it ended, each a link to its run", () => {
    const rows = [
      toWorkflowRun(runResource({ id: "wr_2", status: "failed", trigger: "schedule" })),
      toWorkflowRun(runResource({ id: "wr_1", status: "done", mode: "test" }))
    ];
    const markup = render(page(runList({ rows })));
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients/runs/wr_2"');
    expect(markup).toContain(t("workflows.run.failed"));
    expect(markup).toContain(t("workflows.run.done"));
    expect(markup.match(/data-test-run=""/gu)).toHaveLength(1);
  });

  // ACCEPT-2a E1: a run's time names the zone it is shown in, beside a schedule in its own zone.
  it("names the zone of each run's time", () => {
    const rows = [toWorkflowRun(runResource({ id: "wr_1", status: "done", trigger: "schedule" }))];
    const shown = new Date("2026-10-12T09:00:00.000Z").toLocaleString("de", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short"
    });
    expect(shown).toMatch(/\d \S+$/u);
    expect(render(page(runList({ rows })), "de")).toContain(`>${shown}<`);
  });

  it("says on a failed row why it failed, never the instance's code or sentence", () => {
    const rows = [
      toWorkflowRun(
        runResource({
          id: "wr_3",
          status: "failed",
          error: { code: "FORBIDDEN", message: "The instance's own sentence" }
        })
      ),
      toWorkflowRun(runResource({ id: "wr_2", status: "limit_reached" })),
      toWorkflowRun(runResource({ id: "wr_1", status: "done" }))
    ];
    const markup = render(page(runList({ rows })));
    const reasons = [...markup.matchAll(/data-run-reason=""[^>]*>([^<]*)</gu)].map(
      (match) => match[1]
    );
    expect(reasons).toEqual([t("workflows.reason.missingRight"), t("workflows.reason.other")]);
    expect(markup).not.toContain("FORBIDDEN");
    expect(markup).not.toContain("The instance&#x27;s own sentence");
  });

  it("folds empty runs side by side into one row, and keeps every other run a row (WF-KIND)", () => {
    const rows = [
      toWorkflowRun(runResource({ id: "wr_9", status: "done" })),
      toWorkflowRun(runResource({ id: "wr_8", status: "done", empty: true })),
      toWorkflowRun(runResource({ id: "wr_7", status: "done", empty: true })),
      toWorkflowRun(runResource({ id: "wr_6", status: "done", empty: true })),
      toWorkflowRun(runResource({ id: "wr_5", status: "failed", empty: true })),
      toWorkflowRun(runResource({ id: "wr_4", status: "done", empty: true, mode: "test" })),
      toWorkflowRun(runResource({ id: "wr_3", status: "done", empty: true })),
      toWorkflowRun(runResource({ id: "wr_2", status: "done" }))
    ];
    // Only a run that ended done is empty, whatever else the instance marks.
    expect(rows.map((run) => run.empty)).toEqual([
      false,
      true,
      true,
      true,
      false,
      true,
      true,
      false
    ]);
    const markup = render(page(runList({ rows, hasMore: true })));
    expect(markup.match(/data-empty-runs=/gu)).toHaveLength(1);
    expect(markup).toContain('data-empty-runs="3"');
    // Folded, the three empty runs are behind the row; the others stand, a lone empty one too.
    for (const shown of ["wr_9", "wr_5", "wr_4", "wr_3", "wr_2"]) {
      expect(markup).toContain(`href="/w/cw_1/workflows/notify-clients/runs/${shown}"`);
    }
    for (const folded of ["wr_8", "wr_7", "wr_6"]) {
      expect(markup).not.toContain(`/runs/${folded}"`);
    }
    expect(markup).toContain(t("workflows.showMore"));
  });

  it("offers to try again where the runs could not be loaded, and lists none where the instance runs none", () => {
    expect(render(page(runList({ rows: undefined, failed: true })))).toContain(t("tryAgain"));
    expect(render(page(runList(), false))).toContain(t("workflows.runsUnavailable"));
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
    expect(runRefreshMs(toWorkflowRun(runResource({ status: "waiting" })))).toBe(2_000);
    for (const status of ["done", "failed", "cancelled", "limit_reached"] as const) {
      expect(runRefreshMs(toWorkflowRun(runResource({ status })))).toBe(false);
    }
    expect(runRefreshMs(undefined)).toBe(false);
  });

  it("offers the cancel on a going run where it may be cancelled, and not on an ended or stopping one", () => {
    const going = runRead(runResource(), [startStep]);
    expect(render(runPage(going, { canCancel: true }))).toContain(t("workflows.run.cancel"));
    expect(render(runPage(going, { canCancel: false }))).not.toContain(t("workflows.run.cancel"));
    expect(render(runPage(going, { canCancel: true, stopping: true }))).not.toContain(
      t("workflows.run.cancel")
    );
    const done = runResource({ status: "done", finishedAt: "2026-10-12T09:00:42.000Z" });
    expect(render(runPage(runRead(done, [startStep]), { canCancel: false }))).not.toContain(
      t("workflows.run.cancel")
    );
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
    expect(withStep).not.toContain(t("workflows.reason.other"));
    // Until the step has arrived, the run says why it ended, never by its code.
    const without = render(runPage(runRead(failedRun, [startStep])));
    expect(without).toContain(t("workflows.reason.other"));
    expect(without).not.toContain("operation_failed");
  });

  it("says which limit stopped a run that reached one, never by its code", () => {
    const run = runResource({
      status: "limit_reached",
      finishedAt: "2026-10-12T09:30:00.000Z",
      error: { code: "step_limit", message: "The run reached its limit of 50000 steps" }
    });
    const markup = render(runPage(runRead(run, [startStep, clientsStep])));
    expect(markup).toContain(t("workflows.reason.stepLimit"));
    expect(markup).not.toContain("step_limit");
  });

  it("leads from a child run back to the run that started it", () => {
    const child = runResource({
      id: "wr_2",
      trigger: "parent",
      parentRunId: "wr_1",
      parentWorkflow: "quarter-close"
    });
    const markup = render(runPage(runRead(child, [startStep])));
    expect(markup).toContain('href="/w/cw_1/workflows/quarter-close/runs/wr_1"');
  });

  it("offers the cancel to whoever started the run, and to whoever may write Workflows", () => {
    const going = toWorkflowRun(runResource());
    const ended = toWorkflowRun(runResource({ status: "done" }));
    expect(cancelOffered(going, "user_1", onInstance(false), undefined)).toBe(true);
    expect(cancelOffered(going, "user_2", onInstance(false), undefined)).toBe(false);
    expect(cancelOffered(going, "user_2", onInstance(true), undefined)).toBe(true);
    expect(cancelOffered(ended, "user_1", onInstance(true), undefined)).toBe(false);
  });

  it("offers a retry only where the run failed to load, and keeps the last state while the instance is silent", () => {
    const unread = {
      run: undefined,
      silentSince: undefined,
      stepsFailed: false,
      stepRuns: undefined,
      retry: noop
    };
    for (const problem of ["missing", "unavailable", "failed"] as const) {
      expect(render(runPage({ ...unread, problem })).includes(t("tryAgain"))).toBe(
        problem === "failed"
      );
    }
    const read = runRead(runResource(), [startStep]);
    const markup = render(runPage({ ...read, silentSince: now.getTime() - 9_000 }));
    expect(markup).toContain(t("workflows.run.stale", { seconds: 9 }));
    expect(markup).toContain(t("workflows.run.running"));
  });
});

// Who is shown the Workflows area: its row in the rail and its addresses. One function
// decides both, from the module's switch and the rights the instance names.
describe("who is shown the Workflows area", () => {
  const modulesOn = { workflows: { enabled: true } };
  const reader = { actions: ["workflow.read"], assetActions: [] };

  it("opens it for a person who may read every or one single Workflow, and closes it otherwise", () => {
    expect(workflowsAccess({ modules: modulesOn, workspaces: true, context: reader })).toBe("open");
    expect(
      workflowsAccess({
        modules: modulesOn,
        workspaces: true,
        context: { actions: [], assetActions: ["workflow.read"] }
      })
    ).toBe("open");
    expect(
      workflowsAccess({
        modules: modulesOn,
        workspaces: true,
        context: { actions: ["app.read", "workflow.use"], assetActions: ["app.read"] }
      })
    ).toBe("closed");
  });

  // NAV-VIS-1 review: the row follows the server's flag alone, so a member the flag names
  // through `workflow.use` or a narrower `workflow.write` reaches the area it leads to.
  it("opens it for a person the instance names the row, without the right to read", () => {
    const member = {
      actions: ["workflow.use"],
      assetActions: [],
      visibleSections: ["workflows" as const]
    };
    expect(workflowsAccess({ modules: modulesOn, workspaces: true, context: member })).toBe("open");
    expect(workflowsRowShown("open", member)).toBe(true);
    expect(workflowsAccess({ modules: modulesOn, workspaces: false, context: member })).toBe(
      "closed"
    );
  });

  it("closes it while the module is off or there is no workspace, and decides nothing before the instance answered", () => {
    expect(workflowsAccess({ modules: {}, workspaces: true, context: reader })).toBe("closed");
    expect(
      workflowsAccess({
        modules: { workflows: { enabled: false } },
        workspaces: true,
        context: reader
      })
    ).toBe("closed");
    expect(workflowsAccess({ modules: modulesOn, workspaces: false, context: reader })).toBe(
      "closed"
    );
    expect(workflowsAccess({ modules: undefined, workspaces: true, context: reader })).toBe(
      "unknown"
    );
    expect(workflowsAccess({ modules: modulesOn, workspaces: true, context: undefined })).toBe(
      "unknown"
    );
  });

  // NAV-VIS-1: the instance names the row where its list shows the person a Workflow or they
  // may write one, so a member is never shown an empty row.
  it("shows the rail row only where the area is open and the instance names it", () => {
    const ids = (workflows: boolean) =>
      shownRailSections(railSections, { apps: true, workflows }).map((section) => section.id);
    expect(ids(true)).toEqual(["apps", "workflows"]);
    expect(ids(false)).toEqual(["apps"]);
    const named = { visibleSections: ["workflows" as const] };
    expect(workflowsRowShown("open", named)).toBe(true);
    expect(workflowsRowShown("unknown", named)).toBe(true);
    expect(workflowsRowShown("open", { visibleSections: [] })).toBe(false);
    expect(workflowsRowShown("closed", named)).toBe(false);
    expect(workflowsRowShown("unknown", undefined)).toBe(false);
  });
});

describe("what a reader holds on Workflows, by owner", () => {
  const none = { read: false, write: false, publish: false, delete: false };

  it("names the instance's own Workflows by what the instance names on its own assets", () => {
    const context = workflowsContext(["workflow.read", "workflow.publish"], {}, ["workflow.write"]);
    // A right on one single Workflow is that Workflow's to say, never a right on all of them.
    expect(resolveWorkflowRights(context, undefined)).toEqual({
      instance: { read: true, write: false, publish: true, delete: false }
    });
  });

  it("names the open workspace's own Workflows by that workspace's actions alone", () => {
    const context = workflowsContext(["workflow.read"], {
      cw_open: ["workflow.read", "workflow.write"],
      cw_other: ["workflow.write", "workflow.publish", "workflow.delete"]
    });
    expect(resolveWorkflowRights(context, "cw_open")).toEqual({
      instance: { ...none, read: true },
      workspace: { id: "cw_open", rights: { ...none, read: true, write: true } }
    });
  });

  // ACCEPT-FIX-6: an older server names no zone; a schedule then names none rather than a guess.
  it("reads the instance's zone where the instance names one, and nothing from an older server", () => {
    const current = workflowsContext([]);
    expect(instanceTimeZoneOf(current)).toEqual({ timeZone: "UTC", defaulted: true });
    const { id, name } = current.instance;
    expect(instanceTimeZoneOf({ instance: { id, name } })).toBeUndefined();
    expect(instanceTimeZoneOf({ instance: { id, name, timeZone: "Europe/Berlin" } })).toEqual({
      timeZone: "Europe/Berlin",
      defaulted: false
    });
    expect(instanceTimeZoneOf(undefined)).toBeUndefined();
  });

  it("holds nothing before the instance has answered", () => {
    expect(resolveWorkflowRights(undefined, "cw_open")).toEqual({
      instance: none,
      workspace: { id: "cw_open", rights: none }
    });
  });
});

describe("the addresses of the Workflows area", () => {
  it("resolves each address and writes it again, and says not found for one it does not have", () => {
    const ws = "cw_1";
    const addresses = [
      ["/w/cw_1/workflows", { kind: "workflows", collaborationWorkspaceId: ws }],
      [
        "/w/cw_1/workflows/notify/open/remind/mail",
        {
          kind: "workflow",
          collaborationWorkspaceId: ws,
          workflow: "notify",
          opened: "remind/mail"
        }
      ],
      [
        "/w/cw_1/workflows/notify/runs/wr_7",
        { kind: "workflow-run", collaborationWorkspaceId: ws, workflow: "notify", run: "wr_7" }
      ]
    ] as const;
    for (const [path, route] of addresses) {
      expect(workspaceRouteFromPath(path)).toEqual(route);
      expect(workspaceRoutePath(route)).toBe(path);
      expect(areaOfRoute(route)).toBe("workflows");
    }
    expect(workspaceRouteFromPath("/w/cw_1/workflows/notify/runs/wr_7/more")).toEqual({
      kind: "not-found"
    });
  });
});

// KBW-2c (Knowledge Bases check 112): the question before a Workflow is deleted names the
// Knowledge Bases it fed, each with its documents, and counts those the reader cannot open.
describe("the question before a Workflow is deleted (KBW-2c)", () => {
  const view = {
    knowledgeBases: [
      { name: "contracts", title: "Contracts", documents: 12 },
      { name: "handbook", title: "Handbook", documents: 1 }
    ],
    hidden: { knowledgeBases: 2, documents: 40 }
  };
  const asset = {
    id: "asset_import",
    kind: "workflow",
    name: "import",
    title: "Import",
    scope: { kind: "instance" },
    revision: 4,
    draftRevision: 4,
    publishedRevision: 4,
    createdAt: "2026-10-10T09:00:00.000Z",
    updatedAt: "2026-10-17T09:00:00.000Z",
    config: { name: "import", manifest: { id: "import", name: "Import", steps: [] } }
  };

  it("names each Knowledge Base it fed and counts the hidden ones, and says nothing where it fed none", () => {
    const markup = render(createElement(WorkflowRemoveKnowledge, { view }));
    expect(markup).toContain("Contracts");
    expect(markup).toContain("Handbook");
    expect(markup).toContain("2 knowledge bases you cannot open");
    expect(
      render(
        createElement(WorkflowRemoveKnowledge, {
          view: { knowledgeBases: [], hidden: { knowledgeBases: 0, documents: 0 } }
        })
      )
    ).toBe("");
  });

  it("asks the instance what the delete ends, and deletes at the revision it asked at", async () => {
    const { client, calls } = recordedApiClient(({ operation }) =>
      operation === "assets.get"
        ? asset
        : operation === "knowledge_bases.workflow_sources"
          ? view
          : { version: 7, revision: 5, warnings: [] }
    );
    const removal = createInstanceSource(client, "test").removal;
    expect(await removal?.read("import", new AbortController().signal)).toEqual({
      revision: 4,
      ...view
    });
    await removal?.remove("import", 4);
    expect(
      calls.map((call) => [
        call.operation,
        call.params,
        call.body ? JSON.parse(call.body) : undefined
      ])
    ).toEqual([
      ["assets.get", { kind: "workflow", name: "import" }, undefined],
      ["knowledge_bases.workflow_sources", { workflow: "import" }, undefined],
      ["assets.delete", { kind: "workflow", name: "import" }, { expectedRevision: 4 }]
    ]);
  });

  it("answers no Knowledge Base where the instance has none", async () => {
    const { client } = recordedApiClient(({ operation }) =>
      operation === "assets.get"
        ? asset
        : Response.json(
            { error: { code: "NOT_FOUND", message: "Module 'knowledge' is off on this instance" } },
            { status: 404 }
          )
    );
    expect(
      await createInstanceSource(client, "test").removal?.read(
        "import",
        new AbortController().signal
      )
    ).toEqual({ revision: 4, knowledgeBases: [], hidden: { knowledgeBases: 0, documents: 0 } });
  });
});
