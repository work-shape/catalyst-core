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
  type StepPinControl
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { recordedApiClient } from "./support/recorded-api-client";

// Pinned step outputs on the Workflow screens (EW-10): the calls the instance's source makes
// for the reader's pins, and a step's panel on a run's page and on the Workflow's page. Each
// fails without the screens of EW-10.

const en = createTranslationContext("en");
const { t } = en;
const de = createTranslationContext("de").t;
const render = (node: ReactNode, locale: "en" | "de" = "en") =>
  renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
const noop = () => undefined;
const now = new Date("2026-10-30T09:12:00.000Z");

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
const draft = toWorkflow(
  { name: "notify-clients", config: definition, publishedRevision: undefined },
  { mayStart: false },
  { draftRevision: 3 }
);
const testRun = (input: Partial<RunResource> = {}): RunResource => ({
  id: "wr_second",
  workflow: "notify-clients",
  trigger: "manual",
  mode: "test",
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

describe("the instance's source for pinned step outputs", () => {
  it("reads the reader's pins, pins a step's output of a run and drops a pin", async () => {
    const { client, calls } = recordedApiClient(({ operation }) =>
      operation === "workflows.list_pins"
        ? { items: [{ step: "clients", runId: "wr_first", pinnedAt: "2026-10-30T09:00:00.000Z" }] }
        : operation === "workflows.pin_step"
          ? { step: "clients", runId: "wr_first", pinnedAt: "2026-10-30T09:00:00.000Z" }
          : { removed: true }
    );
    const source = createInstanceSource(client, "k");
    expect(await source.drafts?.listPins?.("notify-clients", new AbortController().signal)).toEqual(
      [{ step: "clients", runId: "wr_first", pinnedAt: "2026-10-30T09:00:00.000Z" }]
    );
    await source.drafts?.pinStep?.("notify-clients", "clients", "wr_first");
    await source.drafts?.unpinStep?.("notify-clients", "clients");
    expect(calls.map((call) => call.operation)).toEqual([
      "workflows.list_pins",
      "workflows.pin_step",
      "workflows.unpin_step"
    ]);
    expect(calls[1]).toMatchObject({ params: { workflow: "notify-clients", step: "clients" } });
    expect(JSON.parse(calls[1]?.body ?? "{}")).toEqual({ runId: "wr_first" });
    expect(calls[2]).toMatchObject({ params: { workflow: "notify-clients", step: "clients" } });
  });

  it("maps the steps a test run took from a pin", () => {
    const run = toWorkflowRun(
      testRun({ pinnedSteps: [{ step: "clients", sourceRunId: "wr_first" }] })
    );
    expect(run.pinnedSteps).toEqual([{ step: "clients", sourceRunId: "wr_first" }]);
    expect(toWorkflowRun(testRun({ pinnedSteps: [] })).pinnedSteps).toBeUndefined();
  });
});

describe("a step's panel with a pin", () => {
  const control = (input: Partial<StepPinControl> = {}): StepPinControl => ({
    fromThisRun: false,
    pinnable: true,
    busy: false,
    pin: noop,
    unpin: noop,
    openRun: noop,
    ...input
  });
  const panel = (
    options: {
      pin?: StepPinControl;
      pinnedFrom?: string;
      run?: boolean;
    },
    locale: "en" | "de" = "en"
  ) => {
    const graph = workflowGraph(draft.steps, en);
    const step = placedSteps(draft.steps).get("clients")?.step;
    const part = graph.nodes.find((node) => node.id === "clients");
    if (step === undefined || part === undefined) throw new Error("No step clients");
    return render(
      createElement(StepPanel, {
        step,
        part,
        run:
          options.run === false
            ? undefined
            : {
                stepRun: clientsRun,
                counts: undefined,
                now,
                ...(options.pinnedFrom === undefined
                  ? {}
                  : { pinnedFrom: { runId: options.pinnedFrom, open: noop } })
              },
        tab: options.run === false ? "what" : "run",
        onTabChange: noop,
        entries: null,
        onClose: noop,
        ...(options.pin === undefined ? {} : { pin: options.pin })
      }),
      locale
    );
  };

  it("offers to use a step's output in test runs, in both languages", () => {
    const markup = panel({ pin: control() });
    expect(markup).toContain('data-step-pin="off"');
    expect(markup).toContain(`>${t("workflows.pin.button")}</`);
    expect(markup).toContain(t("workflows.pin.hint"));
    expect(markup).not.toContain(`>${t("workflows.pin.unpin")}</`);
    expect(panel({ pin: control() }, "de")).toContain(`>${de("workflows.pin.button")}</`);
    expect(panel({})).not.toContain("data-step-pin");
  });

  it("says the output is pinned from this run, and offers Unpin", () => {
    const markup = panel({
      pin: control({
        fromThisRun: true,
        pinned: { runId: "wr_second", pinnedAt: "2026-10-30T09:05:00.000Z" }
      })
    });
    expect(markup).toContain('data-step-pin="this-run"');
    expect(markup).toContain(t("workflows.pin.fromThisRun").replaceAll("'", "&#x27;"));
    expect(markup).toContain(`>${t("workflows.pin.unpin")}</`);
    expect(markup).not.toContain(`>${t("workflows.pin.button")}</`);
    expect(markup).not.toContain(`>${t("workflows.pin.openRun")}</`);
  });

  it("offers this run's output instead of another run's, and the way to that run", () => {
    const markup = panel({
      pin: control({ pinned: { runId: "wr_first", pinnedAt: "2026-10-30T08:00:00.000Z" } })
    });
    expect(markup).toContain('data-step-pin="other-run"');
    expect(markup).toContain(`>${t("workflows.pin.instead")}</`);
    expect(markup).toContain(`>${t("workflows.pin.openRun")}</`);
    expect(markup).toContain(`>${t("workflows.pin.unpin")}</`);
  });

  it("marks a step its test run took from a pin, with the way to the source run", () => {
    const markup = panel({ pinnedFrom: "wr_first" });
    expect(markup).toContain('data-pinned-from="wr_first"');
    expect(markup).toContain(t("workflows.pin.used").replaceAll("'", "&#x27;"));
    expect(panel({ pinnedFrom: "wr_first" }, "de")).toContain(de("workflows.pin.used"));
    // The pin names the run the mark leads to: it offers no second way there, and no re-pin.
    const same = panel({
      pinnedFrom: "wr_first",
      pin: control({ pinned: { runId: "wr_first", pinnedAt: "2026-10-30T08:00:00.000Z" } })
    });
    expect(same.split(`>${t("workflows.pin.openRun")}</`)).toHaveLength(2);
    expect(same).not.toContain(`>${t("workflows.pin.instead")}</`);
    expect(same).toContain(`>${t("workflows.pin.unpin")}</`);
  });

  it("shows a pinned step on the Workflow's page with Unpin", () => {
    const markup = panel({
      run: false,
      pin: control({
        pinnable: false,
        pinned: { runId: "wr_first", pinnedAt: "2026-10-30T08:00:00.000Z" }
      })
    });
    expect(markup).toContain('data-step-pin="other-run"');
    expect(markup).toContain(`>${t("workflows.pin.unpin")}</`);
    expect(markup).toContain(`>${t("workflows.pin.openRun")}</`);
    expect(markup).not.toContain(`>${t("workflows.pin.instead")}</`);
  });
});
