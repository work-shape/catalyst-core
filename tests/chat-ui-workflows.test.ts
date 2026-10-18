import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
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
  type WorkflowRunList,
  type WorkflowRunRead
} from "@work-shape/catalyst-chat-ui/workflows";
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

  it("tells whoever may not build what a Workflow is, and offers nothing to build", () => {
    const markup = render(listPage([]));
    expect(markup).toContain(
      "No workflows yet. A workflow, for example, sends a summary every Monday or reminds clients of overdue invoices."
    );
    expect(markup).not.toContain("builder");
    expect(markup).toContain(t("workflows.description"));
    expect(markup).not.toContain("<button");
    expect(render(listPage([]), "de")).toContain(de("workflows.emptyReadOnly"));
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
    expect(markup).toContain(t("workflows.showMore"));
    expect(markup).not.toContain(t("workflows.empty"));
    expect(markup).not.toContain(t("workflows.emptyReadOnly"));
  });

  it("offers a builder the agent with two examples on the empty list", () => {
    const markup = render(createElement(WorkflowsPageView, { ...listPage([]).props, onNew: noop }));
    expect(markup).toContain(t("workflows.empty"));
    expect(markup).toContain(">Build one with the agent</button>");
    expect(markup).toContain('aria-label="Examples to start with"');
    expect(markup).toContain("Monday task summary");
    expect(markup).toContain("Reminder of overdue invoices");
    expect(markup).not.toContain(t("workflows.emptyReadOnly"));
    const german = render(
      createElement(WorkflowsPageView, { ...listPage([]).props, onNew: noop }),
      "de"
    );
    expect(german).toContain(">Einen mit dem Agenten bauen</button>");
    expect(german).toContain(de("workflows.exampleSummaryTitle"));
  });

  it("drops the head's New while the empty list offers the agent, and shows it once there are Workflows", () => {
    const page = (rows: Parameters<typeof listPage>[0]) =>
      render(createElement(WorkflowsPageView, { ...listPage(rows).props, onNew: noop }));
    const empty = page([]);
    expect(empty).toContain(">Build one with the agent</button>");
    expect(empty).not.toContain(t("workflows.new"));
    // While the list loads, New stands: making one never waits for the answer.
    expect(page(undefined)).toContain(t("workflows.new"));
    const listed = page([summary]);
    expect(listed).toContain(t("workflows.new"));
    expect(listed).not.toContain("Build one with the agent");
  });

  it("lists each Workflow by its name and its sentence, with a link to its page", () => {
    const markup = render(listPage([summary]));
    expect(markup).toContain("Notify clients");
    expect(markup).toContain("Reads the clients and sends each of them a note.");
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients"');
    // The card's target is named as one sentence with the Workflow's name, in either language.
    expect(markup).toContain('aria-label="Open Notify clients"');
    expect(render(listPage([summary]), "de")).toContain('aria-label="Notify clients öffnen"');
    // The whole card opens the Workflow: the link to its page is the card's one target.
    expect(markup.match(/data-card-target=""/gu)).toHaveLength(1);
    expect(markup).toMatch(
      /<a[^>]*data-card-target=""[^>]*href="\/w\/cw_1\/workflows\/notify-clients"/u
    );
    // The id is a builder's: the row never shows it as text.
    expect(markup.replaceAll('href="/w/cw_1/workflows/notify-clients"', "")).not.toContain(
      "notify-clients"
    );
  });

  it("says how the latest run of a Workflow stands, as its last run, or that it has none", () => {
    const never = render(listPage([summary]));
    expect(never).not.toContain(t("workflows.run.failed"));
    expect(never).toContain(t("workflows.noRunsPlain"));
    expect(never).not.toContain(t("workflows.lastRun"));
    // A Workflow that never ran has no runs to lead to.
    expect(never).not.toContain('href="/w/cw_1/workflows/notify-clients/runs"');
    const markup = render(
      listPage([
        {
          ...summary,
          lastRun: { id: "wr_9", status: "failed", startedAt: "2026-10-12T09:00:00.000Z" }
        }
      ])
    );
    expect(markup).toContain(t("workflows.run.failed"));
    expect(markup).toContain(t("workflows.lastRun"));
    expect(markup).toContain('dateTime="2026-10-12T09:00:00.000Z"');
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients/runs"');
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
        workspaceId: "cw_1",
        list: {
          rows: [draft],
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
    expect(markup).toContain("First draft");
    expect(markup).toContain(t("workflows.draft.unpublished"));
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

  it("lists the processes first and keeps data Workflows behind Data flows (WF-KIND)", () => {
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
    expect(
      toAssetWorkflowListItem({ name: "d", title: "D", updatedAt: now.toISOString() }).kind
    ).toBe("process");
    // A draft never published takes the kind its asset row names, a process where it names none.
    const draft = (attributes?: Record<string, string | boolean>) =>
      toAssetWorkflowListItem({
        name: "d",
        title: "D",
        updatedAt: now.toISOString(),
        ...(attributes ? { attributes } : {})
      }).kind;
    expect(draft({ workflowKind: "data" })).toBe("data");
    expect(draft({ workflowKind: "process" })).toBe("process");
    expect(draft({ workflowKind: "other" })).toBe("process");
    expect(draft({})).toBe("process");

    const markup = render(listPage([importer, reminder]));
    expect(markup).toContain("Notify clients");
    expect(markup).not.toContain("Invoice import");
    // One chip, off while the processes are listed.
    expect(markup).toMatch(/<button[^>]*aria-pressed="false"[^>]*>.*Data flows/u);
    expect(markup.match(/aria-pressed=/gu)).toHaveLength(1);
    expect(render(listPage([importer, reminder]), "de")).toContain(">Datenflüsse<");
    // Without a data Workflow there is nothing to choose between.
    expect(render(listPage([reminder]))).not.toContain(t("workflows.kindData"));
    // Only data Workflows: the processes say where the others are, and the list is not empty.
    const onlyData = render(listPage([importer]));
    expect(onlyData).toContain(t("workflows.kindProcessEmpty"));
    expect(onlyData).not.toContain(t("workflows.emptyReadOnly"));
  });
});

describe("the page of a Workflow", () => {
  const page = (
    input: {
      workflow?: typeof workflow;
      problem?: "missing" | "unavailable" | "failed";
      runsAvailable?: boolean;
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
      runsAvailable: input.runsAvailable ?? true,
      onOpenChild: noop,
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

  it("says in its head whom every run acts as, by the account's label", () => {
    const named = toWorkflow(
      { name: "notify-clients", config: definition, publishedRevision: 3 },
      { mayStart: true, runsAs: "Monthly close" }
    );
    expect(render(page({ workflow: named }))).toContain("Runs as Monthly close");
    expect(render(page({ workflow: named }), "de")).toContain("Läuft als Monthly close");
    // Without a label the head names no account: never the definition's own name of it.
    expect(render(page())).not.toContain("Runs as");
  });

  it("offers neither a start nor the runs where the instance runs no Workflow", () => {
    const markup = render(page({ runsAvailable: false }));
    expect(markup).toContain("Notify clients");
    expect(markup).not.toContain(t("workflows.startNow"));
    expect(markup).not.toContain('href="/w/cw_1/workflows/notify-clients/runs"');
  });

  it("shows no id, no operation name and no file name of the definition", () => {
    for (const locale of ["en", "de"] as const) {
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
      const markup = render(page({ workflow: blocked }), locale);
      for (const internal of ["connection.crm", "check.py", "summary.md", "workflow-runner"]) {
        expect(markup).not.toContain(internal);
      }
      expect(markup).toContain(
        locale === "de"
          ? "Das technische Konto „Booking checks“ ist deaktiviert."
          : "The technical account “Booking checks” is disabled."
      );
    }
  });

  it("offers the start of a Workflow with inputs, and none where the form cannot ask for one", () => {
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
    expect(render(page({ workflow: limit }))).toContain(t("workflows.startNow"));
    // A required list has no field: the start stays with the agent and the API.
    const list = asking({
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"]
    });
    expect(startOffered(list)).toBe(false);
    expect(render(page({ workflow: list }))).not.toContain(t("workflows.startNow"));
  });

  it("offers the start only where a revision is published and the reader may start it", () => {
    const readOnly = { ...workflow, mayStart: false };
    expect(startOffered(workflow)).toBe(true);
    expect(startOffered(readOnly)).toBe(false);
    expect(startOffered({ ...workflow, published: false })).toBe(false);
    expect(startOffered({ ...workflow, startsByHand: false })).toBe(false);
    // A reader sees the Workflow and its drawing, and no start.
    const markup = render(page({ workflow: readOnly }));
    expect(markup).toContain(workflow.name);
    expect(markup).not.toContain(t("workflows.startNow"));
  });

  it("shows placeholders while the Workflow loads", () => {
    const markup = render(
      createElement(WorkflowPageView, {
        workspaceId: "cw_1",
        workflowId: "notify-clients",
        read: { workflow: undefined, problem: undefined, retry: noop },
        runsAvailable: true,
        onOpenChild: noop,
        onOpenRoute: noop,
        onStart: noop
      })
    );
    expect(markup).toContain("animate-pulse");
    expect(markup).toContain(t("workflows.backToList"));
    expect(markup).not.toContain("notify-clients</");
  });

  it("shows the not-found state for a Workflow that is not there, with the way to the list", () => {
    const markup = render(page({ problem: "missing" }));
    expect(markup).toContain("data-not-found");
    expect(markup).toContain(`>${t("workflows.missing")}</h1>`);
    // One step, and no head that waits for a name: no placeholder, no tabs, no start.
    expect(markup).toMatch(/<a[^>]*href="\/w\/cw_1\/workflows"[^>]*>Back to Workflows<\/a>/u);
    expect(markup).not.toContain("animate-pulse");
    expect(markup).not.toContain(t("workflows.tabs"));
    expect(markup).not.toContain('data-testid="workflow-canvas"');
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
    expect(markup).toContain('data-slot="breadcrumb"');
    expect(markup).toMatch(/aria-current="page"[^>]*>Send reminders</u);
    expect(markup).toContain('href="/w/cw_1/workflows/notify-clients"');
    // The head, its start and its runs are those of the Workflow that is shown.
    expect(markup).toContain(">Send reminders</h1>");
    expect(markup).toContain('href="/w/cw_1/workflows/send-reminders/runs"');
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

  it("asks for the inputs in the dialog, each with its label, its hint and its default", () => {
    const form = startFormOf({
      type: "object",
      properties: {
        month: { type: "string", format: "date", title: "Month", description: "The first day." },
        limit: { type: "integer", default: 10 },
        region: { type: "string", enum: ["north", "south"] },
        dry_run: { type: "boolean", default: true }
      },
      required: ["month", "region"]
    });
    const refused = [{ path: ["limit"], message: "must be <= 100" }];
    const markup = (locale: "en" | "de") =>
      render(
        createElement(StartDialog, {
          name: "Top customers",
          form,
          loading: false,
          error: undefined,
          refusedValues: refused,
          onConfirm: noop,
          onClose: noop
        }),
        locale
      );
    const en = markup("en");
    expect(en).toContain(t("workflows.startForm.body"));
    expect(en).not.toContain(t("workflows.start.bodyManual"));
    expect(en).toContain(">Month<");
    expect(en).toContain("The first day.");
    expect(en).toContain('type="date"');
    // The name stands as words where the schema gives no title; no key is shown.
    expect(en).toContain(">Dry run<");
    expect(en).not.toContain("dry_run<");
    expect(en).toContain('value="10"');
    expect(en).toContain(">north<");
    // The instance's sentence on a value stands under its field.
    expect(en).toContain("must be &lt;= 100");
    expect(en).toContain(t("workflows.startForm.refused"));
    expect(markup("de")).toContain(de("workflows.startForm.body"));
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

  it("says on a failed row why it failed, in the sentence of its page, on one line", () => {
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
    // A failed run whose reason did not arrive says the general sentence; a done run none.
    expect(reasons).toEqual([t("workflows.reason.missingRight"), t("workflows.reason.other")]);
    expect(markup).toMatch(/data-run-reason="" class="block truncate"/u);
    expect(markup).not.toContain("FORBIDDEN");
    expect(markup).not.toContain("The instance&#x27;s own sentence");
    expect(render(page(runList({ rows })), "de")).toContain(de("workflows.reason.missingRight"));
  });

  it("marks a test run of the draft among the runs", () => {
    const rows = [
      toWorkflowRun(runResource({ id: "wr_3", status: "done", mode: "test" })),
      toWorkflowRun(runResource({ id: "wr_1", status: "done" }))
    ];
    const markup = render(page(runList({ rows })));
    expect(markup.match(/data-test-run=""/gu)).toHaveLength(1);
    expect(markup).toContain(t("workflows.run.testBadge"));
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
    expect(markup.match(/data-empty-runs="3"/gu)).toHaveLength(1);
    expect(markup.match(/data-empty-runs=/gu)).toHaveLength(1);
    expect(markup).toContain(">3 empty runs<");
    // Folded, the three empty runs are behind the row; the others stand, a lone empty one too.
    for (const shown of ["wr_9", "wr_5", "wr_4", "wr_3", "wr_2"]) {
      expect(markup).toContain(`href="/w/cw_1/workflows/notify-clients/runs/${shown}"`);
    }
    for (const folded of ["wr_8", "wr_7", "wr_6"]) {
      expect(markup).not.toContain(`/runs/${folded}"`);
    }
    expect(markup).toContain(t("workflows.showMore"));
    expect(render(page(runList({ rows })), "de")).toContain(">3 leere Läufe<");
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
    expect(cancelOffered(going, "user_1", onInstance(false), undefined)).toBe(true);
    expect(cancelOffered(going, "user_2", onInstance(false), undefined)).toBe(false);
    expect(cancelOffered(going, "user_2", onInstance(true), undefined)).toBe(true);
    expect(cancelOffered(ended, "user_1", onInstance(true), undefined)).toBe(false);
  });

  const unread = {
    run: undefined,
    silentSince: undefined,
    stepsFailed: false,
    stepRuns: undefined,
    retry: noop
  };

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
