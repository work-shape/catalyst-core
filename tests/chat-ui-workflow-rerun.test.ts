import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  StepPanel,
  createInstanceSource,
  placedSteps,
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  workflowGraph,
  type StepRerunControl
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// Re-running a run from a chosen step on the Workflow screens (EW-11): the calls the instance's
// source makes, and a step's panel on the page of an ended run and of the re-run. Each fails
// without the screens of EW-11.

const en = createTranslationContext("en");
const { t } = en;
const de = createTranslationContext("de").t;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;
const now = new Date("2026-10-30T09:12:00.000Z");
const html = (text: string) => text.replaceAll("“", "“").replaceAll("'", "&#x27;");

type RunResource = Parameters<typeof toWorkflowRun>[0];

const definition = {
  id: "notify-clients",
  name: "Notify clients",
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "clients",
      name: "Load the clients",
      type: "operation",
      operation: "connection.crm.list"
    },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
};
const workflow = toWorkflow(
  { name: "notify-clients", config: definition, publishedRevision: 2 },
  { mayStart: true }
);
const run = (input: Partial<RunResource> = {}): RunResource => ({
  id: "wr_again",
  workflow: "notify-clients",
  trigger: "manual",
  mode: "live",
  status: "done",
  startedBy: { id: "user_kai", label: "Kai" },
  createdAt: "2026-10-30T09:00:00.000Z",
  ...input
});
const clientsRun = toWorkflowStepRun({
  id: "sr_clients",
  stepId: "clients",
  stepType: "operation",
  status: "done",
  attempt: 1,
  createdAt: "2026-10-30T09:00:01.000Z",
  outputPreview: { text: '{"clients":[]}', truncated: false }
});

describe("the instance's source for re-runs", () => {
  it("reads from which steps a run is re-run, and starts a re-run", async () => {
    const { client, calls } = recordedApiClient(({ operation }) =>
      operation === "workflows.rerun_steps"
        ? {
            items: [
              { step: "start", changed: false, refusal: { code: "rerun_step_not_offered" } },
              { step: "clients", changed: true },
              {
                step: "result",
                changed: false,
                refusal: { code: "rerun_step_changed", step: "clients" }
              }
            ]
          }
        : {
            id: "wr_new",
            workflow: "notify-clients",
            definitionRevisionId: "rev_2",
            mode: "live",
            trigger: "manual",
            status: "queued",
            principal: { id: "sp", name: "workflow-runner", displayLabel: "Runner" },
            startedBy: { kind: "user", id: "user_kai", label: "Kai" },
            rerunOf: { runId: "wr_first", fromStep: "clients", reusedSteps: [] },
            rootRunId: "wr_new",
            depth: 0,
            stepRunCount: 0,
            deadlineAt: "2026-10-30T10:00:00.000Z",
            createdAt: "2026-10-30T09:00:00.000Z"
          }
    );
    const source = createInstanceSource(client, "k");
    const steps = await source.runs?.rerunSteps?.("wr_first", new AbortController().signal);
    expect(steps?.[2]).toEqual({
      step: "result",
      changed: false,
      refusal: { code: "rerun_step_changed", step: "clients" }
    });
    const started = await source.runs?.rerun?.("wr_first", "clients");
    expect(started?.rerunOf).toEqual({ runId: "wr_first", fromStep: "clients", reusedSteps: [] });
    expect(calls.map((call) => call.operation)).toEqual([
      "workflows.rerun_steps",
      "workflows.rerun"
    ]);
    expect(calls[1]).toMatchObject({ params: { runId: "wr_first" } });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ fromStep: "clients" });
  });

  it("maps the run a re-run re-runs", () => {
    const mapped = toWorkflowRun(
      run({ rerunOf: { runId: "wr_first", fromStep: "result", reusedSteps: ["clients"] } })
    );
    expect(mapped.rerunOf).toEqual({
      runId: "wr_first",
      fromStep: "result",
      reusedSteps: ["clients"]
    });
    expect(toWorkflowRun(run()).rerunOf).toBeUndefined();
  });
});

describe("a step's panel on an ended run", () => {
  const control = (input: Partial<StepRerunControl> = {}): StepRerunControl => ({
    offered: true,
    changed: false,
    start: noop,
    ...input
  });
  const panel = (
    options: { rerun?: StepRerunControl; reusedFrom?: string; reached?: boolean },
    locale: "en" | "de" = "en"
  ) => {
    const graph = workflowGraph(workflow.steps, en);
    const step = placedSteps(workflow.steps).get("clients")?.step;
    const part = graph.nodes.find((node) => node.id === "clients");
    if (step === undefined || part === undefined) throw new Error("No step clients");
    const reached = options.reached !== false;
    return render(
      createElement(StepPanel, {
        step,
        part,
        run: {
          stepRun: reached ? clientsRun : undefined,
          counts: undefined,
          now,
          ...(options.reusedFrom === undefined
            ? {}
            : { reusedFrom: { runId: options.reusedFrom, open: noop } })
        },
        tab: reached ? "run" : "what",
        onTabChange: noop,
        entries: null,
        onClose: noop,
        ...(options.rerun === undefined ? {} : { rerun: options.rerun })
      }),
      locale
    );
  };

  it("offers to run again from the step, in both languages", () => {
    const markup = panel({ rerun: control() });
    expect(markup).toContain('data-step-rerun="offered"');
    expect(markup).toContain(t("workflows.rerun.button"));
    expect(markup).toContain(t("workflows.rerun.hint"));
    expect(panel({ rerun: control() }, "de")).toContain(de("workflows.rerun.button"));
    expect(panel({})).not.toContain("data-step-rerun");
    // A step the run did not reach is re-run from on its first tab.
    expect(panel({ rerun: control(), reached: false })).toContain('data-step-rerun="offered"');
  });

  it("says that a step changed since the run", () => {
    expect(panel({ rerun: control({ changed: true }) })).toContain(
      t("workflows.rerun.hintChanged")
    );
    const refusal = t("workflows.rerun.changed", { step: "Load the clients" });
    const markup = panel({ rerun: control({ offered: false, refusal }) });
    expect(markup).toContain('data-step-rerun="refused"');
    expect(markup).toContain(html(refusal));
    expect(markup).not.toContain(t("workflows.rerun.button"));
  });

  it("marks a step a re-run took from the run it re-runs, with the way there", () => {
    const markup = panel({ reusedFrom: "wr_first" });
    expect(markup).toContain('data-reused-from="wr_first"');
    expect(markup).toContain(html(t("workflows.rerun.reused")));
    expect(markup).toContain(t("workflows.rerun.openOriginal"));
    expect(panel({ reusedFrom: "wr_first" }, "de")).toContain(de("workflows.rerun.reused"));
  });
});
