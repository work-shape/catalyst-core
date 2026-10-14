import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@vivd-catalyst/chat-ui";
import {
  LoopEntriesView,
  StartDialog,
  StepPanel,
  WorkflowPageView,
  WorkflowRunPageView,
  createInstanceSource,
  loopEntries,
  placedSteps,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  workflowGraph
} from "@vivd-catalyst/chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// The test run of a Workflow's draft on its screens (EW-5t, ADR-0031): Test run in the draft
// bar, the calls the instance's source makes for it and for "Run live once", and the run page
// of a test run with the target of each step. Each fails without the screens of EW-5t.

const en = createTranslationContext("en");
const { t } = en;
const de = createTranslationContext("de").t;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;
const now = new Date("2026-10-14T09:12:00.000Z");

type RunResource = Parameters<typeof toWorkflowRun>[0];
type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];

const definition = {
  id: "notify-clients",
  name: "Notify clients",
  inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "clients",
      name: "Load the clients",
      type: "operation",
      operation: "connection.crm.list"
    },
    { id: "send", name: "Send the note", type: "operation", operation: "connection.crm.write" },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
};
const draft = toWorkflow(
  { name: "notify-clients", config: definition, publishedRevision: undefined },
  { mayStart: false },
  { draftRevision: 3 }
);

const testRun = (input: Partial<RunResource> = {}): RunResource => ({
  id: "wr_test",
  workflow: "notify-clients",
  trigger: "manual",
  mode: "test",
  status: "done",
  startedBy: { id: "user_kai", label: "Kai" },
  createdAt: "2026-10-14T09:00:00.000Z",
  startedAt: "2026-10-14T09:00:01.000Z",
  finishedAt: "2026-10-14T09:00:09.000Z",
  ...input
});
const stepRun = (
  input: Partial<StepRunResource> & Pick<StepRunResource, "id" | "stepId">
): StepRunResource => ({
  stepType: "operation",
  status: "done",
  attempt: 1,
  createdAt: "2026-10-14T09:00:01.000Z",
  startedAt: "2026-10-14T09:00:01.000Z",
  finishedAt: "2026-10-14T09:00:02.000Z",
  ...input
});

describe("Test run in the draft bar", () => {
  const page = (bar: { onTest?: () => void }, locale: "en" | "de" = "en") =>
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
      }),
      locale
    );

  it("stands before Publish for a reader who may write the Workflow, in both languages", () => {
    const markup = page({ onTest: noop });
    expect(markup).toContain(`>${t("workflows.test.button")}</`);
    expect(markup.indexOf(t("workflows.test.button"))).toBeLessThan(
      markup.indexOf(`>${t("workflows.draft.publish")}</`)
    );
    expect(page({ onTest: noop }, "de")).toContain(`>${de("workflows.test.button")}</`);
    expect(page({})).not.toContain(`>${t("workflows.test.button")}</`);
  });

  it("asks for the draft's inputs and says what a test run does", () => {
    expect(draft.draft?.testForm.fields.map((field) => field.name)).toEqual(["note"]);
    const dialog = render(
      createElement(StartDialog, {
        name: "Notify clients",
        form: draft.draft?.testForm,
        test: true,
        loading: false,
        error: undefined,
        onConfirm: noop,
        onClose: noop
      })
    );
    expect(dialog).toContain(t("workflows.test.title", { name: "Notify clients" }));
    expect(dialog).toContain(t("workflows.test.body").replaceAll("'", "&#x27;"));
    expect(dialog).toContain(t("workflows.test.confirm"));
  });
});

describe("the instance's source for a test run", () => {
  const instance = () => {
    const { client, calls } = recordedApiClient(({ operation }) =>
      operation === "workflows.test"
        ? {
            ...testRun({ status: "queued" }),
            definitionRevisionId: "rev_draft_3",
            principal: { id: "sp_1", name: "workflow-runner", displayLabel: "Workflow runner" },
            startedBy: { kind: "user", id: "user_kai", label: "Kai" },
            stepRunCount: 0,
            deadlineAt: "2026-10-14T21:00:00.000Z"
          }
        : { draftRevision: 3, part: "send" }
    );
    return { source: createInstanceSource(client, "k"), calls };
  };

  it("starts a test run of the draft with the input of its form", async () => {
    const { source, calls } = instance();
    const run = await source.drafts?.test("notify-clients", { note: "Hello" });
    expect(run).toMatchObject({ id: "wr_test", test: true });
    expect(calls[0]).toMatchObject({
      operation: "workflows.test",
      params: { workflow: "notify-clients" }
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ input: { note: "Hello" } });
  });

  it("switches one step live for the next test run, for the draft it read", async () => {
    const { source, calls } = instance();
    await source.drafts?.runLiveOnce("notify-clients", "send", 3);
    expect(calls[0]).toMatchObject({
      operation: "assets.run_live_once",
      params: { kind: "workflow", name: "notify-clients" }
    });
    expect(JSON.parse(calls[0]?.body ?? "{}")).toEqual({ part: "send", expectedRevision: 3 });
  });
});

describe("the page of a test run", () => {
  const steps = [
    stepRun({ id: "sr_start", stepId: "start", stepType: "trigger" }),
    stepRun({ id: "sr_clients", stepId: "clients", effect: "reading", target: "live" }),
    stepRun({ id: "sr_send", stepId: "send", effect: "changing", target: "dry_run" })
  ].map(toWorkflowStepRun);

  it("says it is a test run of the draft and whose rights it read with", () => {
    const markup = render(
      createElement(WorkflowRunPageView, {
        workspaceId: "cw_1",
        workflowId: "notify-clients",
        workflow: draft,
        read: {
          run: toWorkflowRun(testRun()),
          problem: undefined,
          silentSince: undefined,
          stepRuns: steps,
          stepRunsCut: false,
          retry: noop
        },
        now,
        canCancel: false,
        canRunAgain: true,
        stopping: false,
        onCancel: noop,
        onRunAgain: noop,
        onOpenRoute: noop
      })
    );
    expect(markup).toContain("data-test-run");
    expect(markup).toContain(t("workflows.run.testBadge"));
    expect(markup).toContain(t("workflows.run.testLine", { person: "Kai" }));
    expect(markup).toContain(t("workflows.run.testAgain"));
    // The canvas draws the draft the run is of: no word of an earlier revision.
    expect(markup).not.toContain("data-run-revision");
  });

  /** The panel of one step of the test run, with "Run live once" where it is offered. */
  const panel = (stepId: string, liveOnce?: { state: "idle" | "busy" | "done" }) => {
    const graph = workflowGraph(draft.steps, en, {
      run: toWorkflowRun(testRun()),
      stepRuns: steps,
      now
    });
    const step = placedSteps(draft.steps).get(stepId)?.step;
    const part = graph.nodes.find((node) => node.id === stepId);
    if (step === undefined || part === undefined) throw new Error(`No step ${stepId}`);
    return render(
      createElement(StepPanel, {
        step,
        part,
        run: {
          stepRun: steps.find((entry) => entry.stepId === stepId),
          counts: undefined,
          now,
          ...(liveOnce ? { liveOnce: { ...liveOnce, switchOn: noop } } : {})
        },
        tab: "run",
        onTabChange: noop,
        entries: null,
        onClose: noop
      })
    );
  };

  it("marks each step with its target", () => {
    expect(panel("clients")).toContain('data-step-target="live"');
    expect(panel("clients")).toContain(`>${t("workflows.target.live")}</`);
    const send = panel("send");
    expect(send).toContain('data-step-target="dry_run"');
    expect(send).toContain(`>${t("workflows.target.dry_run")}</`);
  });

  it("offers Run live once beside a simulated step, and says when it is set", () => {
    expect(panel("send", { state: "idle" })).toContain(`>${t("workflows.liveOnce.button")}</`);
    const set = panel("send", { state: "done" });
    expect(set).toContain(t("workflows.liveOnce.done"));
    expect(set).not.toContain(`>${t("workflows.liveOnce.button")}</`);
    expect(panel("send")).not.toContain(t("workflows.liveOnce.button"));
  });

  it("marks each entry of a loop with where its changing step went", () => {
    const entryRuns = [0, 1].map((index) =>
      toWorkflowStepRun(
        stepRun({
          id: `sr_send_${String(index)}`,
          stepId: "send",
          containerStepRunId: "sr_loop",
          iteration: { index },
          effect: "changing",
          target: index === 0 ? "live" : "dry_run"
        })
      )
    );
    expect(loopEntries(entryRuns).map((entry) => entry.targets)).toEqual([["live"], ["dry_run"]]);
    const loop = placedSteps(draft.steps).get("send")?.step;
    if (loop === undefined) throw new Error("No step send");
    const markup = render(
      createElement(LoopEntriesView, {
        loop,
        counts: { total: 2, done: 2, failed: 0, running: 0 },
        filter: "all",
        onFilterChange: noop,
        read: {
          stepRuns: entryRuns,
          failed: false,
          hasMore: false,
          loadingMore: false,
          loadMore: noop,
          retry: noop
        }
      })
    );
    expect(markup).toContain('data-step-target="live"');
    expect(markup).toContain('data-step-target="dry_run"');
  });
});
