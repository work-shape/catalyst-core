import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import { uiLabelsDe } from "@work-shape/catalyst-ui";
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
  workflowGraph,
  type LiveOnceControl
} from "@work-shape/catalyst-chat-ui/workflows";
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
            rootRunId: "wr_test",
            depth: 0,
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

  it("reads the reader's own switches, and the test run that used one", async () => {
    const { client } = recordedApiClient(() => ({
      items: [
        { part: "send", switchedAt: "2026-10-14T09:00:00.000Z" },
        {
          part: "bill",
          switchedAt: "2026-10-14T08:00:00.000Z",
          usedByRunId: "wr_1",
          usedAt: "2026-10-14T08:30:00.000Z"
        }
      ]
    }));
    const source = createInstanceSource(client, "k");
    expect(
      await source.drafts?.listLiveOnce("notify-clients", new AbortController().signal)
    ).toEqual([
      { step: "send", switchedAt: "2026-10-14T09:00:00.000Z" },
      {
        step: "bill",
        switchedAt: "2026-10-14T08:00:00.000Z",
        used: { runId: "wr_1", at: "2026-10-14T08:30:00.000Z" }
      }
    ]);
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
          stepsFailed: false,
          stepRuns: steps,
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
  const panel = (
    stepId: string,
    liveOnce?: Omit<LiveOnceControl, "switchOn">,
    locale: "en" | "de" = "en"
  ) => {
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
      }),
      locale
    );
  };

  it("marks each step with its target", () => {
    expect(panel("clients")).toContain('data-target="live"');
    expect(panel("clients")).toContain(">Live</");
    const send = panel("send");
    expect(send).toContain('data-target="dry_run"');
    expect(send).toContain(">Simulated</");
  });

  it("offers Run live once beside a simulated step, and says when it is set and when used", () => {
    expect(panel("send", { state: "off" })).toContain(`>${t("workflows.liveOnce.button")}</`);
    const set = panel("send", { state: "set" });
    expect(set).toContain(t("workflows.liveOnce.done"));
    expect(set).not.toContain(`>${t("workflows.liveOnce.button")}</`);
    const used = panel("send", {
      state: "used",
      used: { runId: "wr_test", at: "2026-10-14T09:00:05.000Z" }
    });
    expect(used).toContain('data-live-once="used"');
    expect(used).toContain(`>${t("workflows.liveOnce.again")}</`);
    expect(used).toMatch(/Ran live in your test run of [^<]+\./u);
    expect(panel("send")).not.toContain(t("workflows.liveOnce.button"));
    // German says "live" as the target badge does, and never "auf einmal live".
    expect(panel("send", { state: "off" }, "de")).toContain(
      `>${de("workflows.liveOnce.button")}</`
    );
    expect(de("workflows.test.body")).not.toContain("auf einmal live");
    expect(de("workflows.liveOnce.button")).toBe("Einmal live ausführen");
    expect(uiLabelsDe.targetLive).toBe("Live");
    expect(de("workflows.run.publishedAsksShort")).toBe(
      "Eine veröffentlichte Ausführung fragt hier nach Freigabe"
    );
  });

  it("says in sentences what a simulated step would have done, without the engine's keys", () => {
    const send = panel("send");
    expect(send).toContain("data-simulated");
    expect(send).toContain(t("workflows.simulated.would", { operation: "connection.crm.write" }));
    expect(send).toContain(t("workflows.simulated.wouldAskApproval").replaceAll("'", "&#x27;"));
    expect(send).toContain(">client-anna<");
    expect(send).not.toMatch(/wouldHaveDone|wouldAsk/u);
    const german = panel("send", undefined, "de");
    expect(german).toContain(
      de("workflows.simulated.would", { operation: "connection.crm.write" })
    );
    expect(german).not.toMatch(/wouldHaveDone|wouldAsk/u);
  });

  it("warns where a published run would ask for an approval the test did not", () => {
    expect(panel("send")).toContain('data-published-asks="approval"');
    expect(panel("send")).toContain("A published run asks for approval here");
    expect(panel("send", undefined, "de")).toContain(
      "Eine veröffentlichte Ausführung fragt hier nach Freigabe"
    );
    expect(panel("clients")).not.toContain("data-published-asks");
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
        },
        onOpenChild: noop
      })
    );
    expect(markup).toContain('data-target="live"');
    expect(markup).toContain('data-target="dry_run"');
  });
});
