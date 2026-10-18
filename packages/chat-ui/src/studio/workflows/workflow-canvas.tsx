import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { FlowCanvas, type FlowGraph } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { LoopEntries } from "./loop-entries";
import { StepPanel, stepPanelTabs, type StepPanelRun, type StepPanelTab } from "./step-panel";
import type { LiveOnceControl } from "./test-run";
import { placedSteps, workflowGraph } from "./workflow-canvas-model";
import { useRecipientNames } from "./workflows-host";
import type {
  WorkflowRunView,
  WorkflowStepRunView,
  WorkflowStepView,
  WorkflowView
} from "./workflow-views";

/** What the canvas draws of one run. */
export interface WorkflowCanvasRun {
  run: WorkflowRunView;
  /** The step runs outside every entry of a loop. Absent until they arrived. */
  stepRuns: readonly WorkflowStepRunView[] | undefined;
  now: Date;
  /** In a test run: "Run live once" for a step that changes something, where it is offered. */
  liveOnce?: (
    step: WorkflowStepView,
    stepRun: WorkflowStepRunView | undefined
  ) => LiveOnceControl | undefined;
}

/**
 * A request to open the entries of a loop in the panel. Each request is a new object, so the
 * same loop can be asked for again after the reader closed its panel.
 */
export interface WorkflowCanvasFocus {
  stepId: string;
}

/** The same graph object for as long as nothing of it changed, so the canvas lays out once. */
function useSameGraph<Graph extends FlowGraph>(graph: Graph): Graph {
  const key = JSON.stringify(graph);
  const [held, setHeld] = useState({ key, graph });
  if (held.key !== key) {
    setHeld({ key, graph });
    return graph;
  }
  return held.graph;
}

/**
 * A Workflow on the canvas, read-only: its steps as nodes, a loop and a parallel block as
 * frames around their steps. With a run, every part says how far it is. A step opens the one
 * side panel; a failed step of an ended run opens it by itself.
 */
export function WorkflowCanvas({
  workflow,
  run,
  onOpenChild,
  focus
}: {
  /** The Workflow, once its record arrived. */
  workflow: WorkflowView | undefined;
  run?: WorkflowCanvasRun;
  /** Opens what a `workflow` step starts: the child run where there is one, else its Workflow. */
  onOpenChild(step: WorkflowStepView, stepRun: WorkflowStepRunView | undefined): void;
  /** Opens the entries of a loop, as its "Show the failed" does. */
  focus?: WorkflowCanvasFocus;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const recipients = useRecipientNames();
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<StepPanelTab>("what");
  // Once the reader chose a step, or closed the panel, it no longer opens by itself.
  const chose = useRef(false);

  const steps = workflow?.steps;
  const placed = useMemo(() => placedSteps(steps ?? []), [steps]);
  const stepRuns = run?.stepRuns;
  const frame = useMemo(
    () =>
      new Map(
        (stepRuns ?? [])
          .filter((stepRun) => stepRun.iteration === undefined)
          .map((stepRun) => [stepRun.stepId, stepRun])
      ),
    [stepRuns]
  );
  const graph = useSameGraph(
    workflowGraph(
      steps ?? [],
      { locale, t },
      run === undefined ? undefined : { run: run.run, stepRuns: stepRuns ?? [], now: run.now },
      recipients
    )
  );

  const runOf = (id: string): StepPanelRun | undefined => {
    const place = placed.get(id);
    if (run === undefined || place === undefined) {
      return undefined;
    }
    const block =
      place.repeated && place.blockId !== undefined ? frame.get(place.blockId) : undefined;
    // A loop that takes the step's result runs once for each entry of it, so the loop's total
    // is the size of what the step passed on. The step run itself carries no count.
    const taker = place.repeated
      ? undefined
      : [...placed.values()].find(
          (other) => other.step.itemsFrom === id && frame.get(other.step.id)?.loop !== undefined
        );
    const passed = taker === undefined ? undefined : frame.get(taker.step.id)?.loop?.total;
    const stepRun = place.repeated ? undefined : frame.get(id);
    const liveOnce = run.liveOnce?.(place.step, stepRun);
    return {
      ...(taker === undefined || passed === undefined
        ? {}
        : { passesOn: { count: passed, step: taker.step.name } }),
      stepRun,
      ...(liveOnce === undefined ? {} : { liveOnce }),
      ...(run.run.datasets === undefined ? {} : { runDatasets: run.run.datasets }),
      counts: block?.bodyCounts?.[id],
      countsEnded: block?.finishedAt !== undefined,
      now: run.now
    };
  };

  const open = (id: string, wanted?: StepPanelTab) => {
    const stepRun = runOf(id);
    const fallback: StepPanelTab = stepRun?.stepRun?.failure === undefined ? "what" : "run";
    const next = wanted ?? fallback;
    setSelectedId(id);
    setTab(stepPanelTabs(stepRun).includes(next) ? next : "what");
  };

  // The step a run failed at is what a reader of an ended run came for.
  const failedId =
    run?.run.ended === true
      ? [...frame.values()].find((stepRun) => stepRun.failure !== undefined)?.stepId
      : undefined;
  useEffect(() => {
    if (failedId !== undefined && !chose.current && placed.has(failedId)) {
      chose.current = true;
      setSelectedId(failedId);
      setTab("run");
    }
  }, [failedId, placed]);
  useEffect(() => {
    if (focus !== undefined && placed.has(focus.stepId)) {
      chose.current = true;
      setSelectedId(focus.stepId);
      setTab("entries");
    }
  }, [focus, placed]);

  const selected = selectedId === undefined ? undefined : placed.get(selectedId);
  const part =
    selectedId === undefined
      ? undefined
      : (graph.nodes.find((node) => node.id === selectedId) ??
        graph.groups.find((group) => group.id === selectedId));
  const selectedRun = selectedId === undefined ? undefined : runOf(selectedId);
  const loopRun = selectedRun?.stepRun;
  const loopCounts = loopRun?.loop;
  let entries: ReactNode = null;
  if (run !== undefined && selected !== undefined && loopRun !== undefined && loopCounts) {
    entries = (
      <LoopEntries
        // Another loop is another list, with a filter of its own.
        key={loopRun.id}
        runId={run.run.id}
        loop={selected.step}
        stepRun={{ ...loopRun, loop: loopCounts }}
        runEnded={run.run.ended}
        onOpenChild={onOpenChild}
      />
    );
  }

  return (
    <FlowCanvas
      data-testid="workflow-canvas"
      graph={graph}
      label={t("workflows.canvas.label", { name: workflow?.name ?? t("workflows.title") })}
      emptyLabel={t("workflows.canvas.empty")}
      loading={workflow === undefined || (run !== undefined && stepRuns === undefined)}
      selectedId={selectedId}
      onSelect={(id) => {
        chose.current = true;
        if (id === undefined) {
          setSelectedId(undefined);
        } else {
          open(id);
        }
      }}
      onAction={(id) => {
        const step = placed.get(id)?.step;
        if (step === undefined) {
          return;
        }
        chose.current = true;
        if (step.kind === "workflow") {
          onOpenChild(step, frame.get(id));
        } else {
          open(id, "entries");
        }
      }}
      searchLabel={t("workflows.canvas.find")}
      panel={
        selected === undefined || part === undefined ? undefined : (
          <StepPanel
            step={selected.step}
            part={part}
            run={selectedRun}
            tab={tab}
            onTabChange={setTab}
            entries={entries}
            onOpenChild={
              selected.step.kind === "workflow"
                ? () => onOpenChild(selected.step, selectedRun?.stepRun)
                : undefined
            }
            onClose={() => {
              chose.current = true;
              setSelectedId(undefined);
            }}
          />
        )
      }
    />
  );
}
