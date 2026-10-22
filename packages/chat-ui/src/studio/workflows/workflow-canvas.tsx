import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Banner,
  Button,
  FlowCanvas,
  type FlowGraph,
  type FlowInsertPlace,
  type FlowInsertPoints
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { LoopEntries } from "./loop-entries";
import { DeleteStepDialog, StepMenu, stepMovable } from "./step-actions";
import { findStep, heldIds, type StepPlace, type WorkflowManifest } from "./step-edits";
import { StepPalette } from "./step-palette";
import {
  StepPanel,
  StepTranscript,
  stepPanelTabs,
  type StepPanelRun,
  type StepPanelTab
} from "./step-panel";
import { StepSettings, StepSettingsBar } from "./step-settings";
import type { Translate } from "./step-settings-parts";
import type { LiveOnceControl } from "./test-run";
import type { WorkflowEdit } from "./workflow-draft";
import type { WorkflowEditing } from "./workflow-editing";
import { placedSteps, workflowGraph } from "./workflow-canvas-model";
import { useRecipientNames, useWorkflowsHost } from "./workflows-host";
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

/** Where a step goes when it is put at a place of the canvas (workflow-canvas 9.6). */
export function stepPlaceOf(place: FlowInsertPlace): StepPlace {
  switch (place.kind) {
    case "edge":
      return { kind: "after", step: place.source };
    case "exit":
      return { kind: "first", block: place.nodeId, path: place.exitId };
    case "end":
      return { kind: "last", block: place.groupId };
  }
}

/** The step a place is named by: the step before it, the condition or the block. */
const anchorOf = (place: FlowInsertPlace) =>
  place.kind === "edge" ? place.source : place.kind === "exit" ? place.nodeId : place.groupId;

/**
 * The places of the canvas where a step can be added or a moving step put, for a draft edited
 * by hand. A place is offered only where the draft holds what names it; the end of a parallel
 * block is no place, as its paths have no end in common. While a step moves, no place beside
 * it or inside it is offered.
 */
export function editPlaces(
  graph: FlowGraph,
  manifest: WorkflowManifest,
  moving: string | undefined,
  t: Translate
): Pick<FlowInsertPoints, "shows"> & { words(place: FlowInsertPlace, adding: boolean): string } {
  const held = new Set(
    moving === undefined ? [] : heldIds(findStep(manifest, moving) ?? { id: moving })
  );
  const title = (id: string) =>
    graph.nodes.find((node) => node.id === id)?.title ??
    graph.groups?.find((group) => group.id === id)?.title ??
    id;
  return {
    shows(place) {
      const anchor = anchorOf(place);
      if (findStep(manifest, anchor) === undefined || held.has(anchor)) return false;
      if (place.kind === "edge" && place.target === moving) return false;
      if (place.kind === "end") {
        return graph.groups?.find((group) => group.id === place.groupId)?.kind !== "parallel";
      }
      return true;
    },
    words(place, adding) {
      return place.kind === "edge"
        ? t(adding ? "workflows.place.addAfter" : "workflows.place.after", {
            name: title(place.source)
          })
        : place.kind === "exit"
          ? t(adding ? "workflows.place.addOnExit" : "workflows.place.onExit", {
              path:
                graph.nodes
                  .find((node) => node.id === place.nodeId)
                  ?.exits?.find((exit) => exit.id === place.exitId)?.label ?? place.exitId
            })
          : t(adding ? "workflows.place.addAtEnd" : "workflows.place.atEnd", {
              name: title(place.groupId)
            });
    }
  };
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
  focus,
  editing,
  edit
}: {
  /** The Workflow, once its record arrived. */
  workflow: WorkflowView | undefined;
  /**
   * Editing by hand, for a reader who may write the Workflow: the canvas draws the draft with
   * what is not saved and marks what differs from the published revision; a step's panel has
   * its Settings.
   */
  editing?: WorkflowEditing;
  /** "Change with the agent", for what Settings does not edit. */
  edit?: WorkflowEdit;
  run?: WorkflowCanvasRun;
  /** Opens what a `workflow` step starts: the child run where there is one, else its Workflow. */
  onOpenChild(step: WorkflowStepView, stepRun: WorkflowStepRunView | undefined): void;
  /** Opens the entries of a loop, as its "Show the failed" does. */
  focus?: WorkflowCanvasFocus;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const recipients = useRecipientNames();
  const host = useWorkflowsHost();
  const [selectedId, setSelectedId] = useState<string>();
  const [tab, setTab] = useState<StepPanelTab>("what");
  // Once the reader chose a step, or closed the panel, it no longer opens by itself.
  const chose = useRef(false);
  // The step being moved, while the canvas offers the places it can go; the step whose delete
  // is asked about; and why the instance refused the last move.
  const [moving, setMoving] = useState<string>();
  const [deleting, setDeleting] = useState<string>();
  const [moveRefused, setMoveRefused] = useState<{ name: string; sentence: string }>();

  const steps = workflow === undefined ? undefined : (editing?.steps ?? workflow.steps);
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
      recipients,
      host?.instanceTimeZone,
      run === undefined ? editing?.marks : undefined
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

  // Settings for every step of the draft but one the draft removed; never in a run.
  // A removed step has no Settings, but one the agent deleted while it was being changed keeps
  // them open to say that the change was dropped.
  const settingsOffered = (id: string) =>
    run === undefined &&
    editing !== undefined &&
    (editing.marks.get(id)?.change !== "removed" || editing.dropped.includes(id));

  const open = (id: string, wanted?: StepPanelTab) => {
    const stepRun = runOf(id);
    const fallback: StepPanelTab = stepRun?.stepRun?.failure === undefined ? "what" : "run";
    const next = wanted ?? fallback;
    setSelectedId(id);
    setTab(stepPanelTabs(stepRun, settingsOffered(id)).includes(next) ? next : "what");
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

  // Steps are added, moved and deleted on the draft, never on a run.
  const editable = run === undefined ? editing : undefined;
  const nameOf = (id: string) => {
    const name = editable === undefined ? undefined : findStep(editable.manifest, id)?.name;
    return typeof name === "string" && name !== "" ? name : id;
  };
  const places =
    editable === undefined ? undefined : editPlaces(graph, editable.manifest, moving, t);
  let insertPoints: FlowInsertPoints | undefined;
  if (editable !== undefined && places !== undefined) {
    insertPoints =
      moving === undefined
        ? {
            mode: "add",
            label: (place) => places.words(place, true),
            shows: places.shows,
            // The "+" opens the palette; the pick is what adds.
            onPress: () => undefined,
            around: (place, point) => (
              <StepPalette
                onPick={(step) => {
                  const id = editable.add(stepPlaceOf(place), step.fields, step.name);
                  chose.current = true;
                  setSelectedId(id);
                  setTab("settings");
                }}
              >
                {point}
              </StepPalette>
            )
          }
        : {
            mode: "move",
            label: (place) => places.words(place, false),
            shows: places.shows,
            onCancel: () => setMoving(undefined),
            onPress: (place) => {
              const step = moving;
              const name = nameOf(step);
              setMoving(undefined);
              editable
                .commit({ kind: "move", step, at: stepPlaceOf(place) })
                .then((sentence) => {
                  if (sentence !== undefined) setMoveRefused({ name, sentence });
                })
                .catch(() => undefined);
            }
          };
  }

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

  // An agent step's transcript is read once its panel shows the run, never for the list.
  const agentRun = selectedRun?.stepRun?.agent === undefined ? undefined : selectedRun.stepRun;
  const transcript =
    run === undefined || agentRun === undefined || tab !== "run" ? null : (
      <StepTranscript
        key={agentRun.id}
        runId={run.run.id}
        stepRunId={agentRun.id}
        following={!run.run.ended}
      />
    );

  const actions =
    editable === undefined || selected === undefined || !stepMovable(editable, selected.step.id)
      ? undefined
      : (() => {
          const id = selected.step.id;
          return (
            <StepMenu
              editing={editable}
              onMove={() => {
                setMoveRefused(undefined);
                setSelectedId(undefined);
                setMoving(id);
              }}
              onDelete={() => setDeleting(id)}
            />
          );
        })();

  return (
    <div className="relative size-full min-h-0 min-w-0">
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
        {...(insertPoints === undefined ? {} : { insertPoints })}
        panel={
          selected === undefined || part === undefined ? undefined : (
            <StepPanel
              step={selected.step}
              account={run === undefined ? workflow?.runsAs : run.run.runsAs}
              part={part}
              run={selectedRun}
              tab={tab}
              onTabChange={setTab}
              entries={entries}
              transcript={transcript}
              actions={actions}
              onOpenChild={
                selected.step.kind === "workflow"
                  ? () => onOpenChild(selected.step, selectedRun?.stepRun)
                  : undefined
              }
              {...(editing === undefined || !settingsOffered(selected.step.id)
                ? {}
                : {
                    settings: {
                      content: (
                        <StepSettings stepId={selected.step.id} editing={editing} edit={edit} />
                      ),
                      footer: <StepSettingsBar stepId={selected.step.id} editing={editing} />,
                      editing: editing.unsaved.size > 0
                    }
                  })}
              onClose={() => {
                chose.current = true;
                setSelectedId(undefined);
              }}
            />
          )
        }
      />
      {moving === undefined ? null : (
        <Banner
          className="absolute top-3 left-3 z-10 max-w-md shadow-sm"
          data-move-hint=""
          title={t("workflows.move.hint", { name: nameOf(moving) })}
          action={
            <Button type="button" size="sm" variant="outline" onClick={() => setMoving(undefined)}>
              {t("workflows.move.cancel")}
            </Button>
          }
        />
      )}
      {moveRefused === undefined ? null : (
        <Banner
          className="absolute top-3 left-3 z-10 max-w-md shadow-sm"
          tone="danger"
          title={t("workflows.move.refused", { name: moveRefused.name })}
          onDismiss={() => setMoveRefused(undefined)}
        >
          {moveRefused.sentence}
        </Banner>
      )}
      {editable === undefined || deleting === undefined ? null : (
        <DeleteStepDialog
          editing={editable}
          stepId={deleting}
          onClose={() => setDeleting(undefined)}
          onDeleted={() => {
            setDeleting(undefined);
            setSelectedId(undefined);
          }}
        />
      )}
    </div>
  );
}
