import type {
  FlowGraph,
  FlowGraphEdge,
  FlowGraphGroup,
  FlowGraphNode,
  FlowStatus
} from "@vivd-catalyst/ui";
import { formatElapsed, formatMoment } from "../control-plane/locale-format";
import type { TranslationContextValue } from "../i18n";
import { scheduleInWords } from "./schedule-words";
import { failureSentences, stepFallbackSentence } from "./workflow-model";
import type {
  WorkflowLoopCounts,
  WorkflowRunView,
  WorkflowStepRunView,
  WorkflowStepView
} from "./workflow-views";

// The drawing of a Workflow: its step list with nested blocks, turned into the nodes, groups
// and edges the canvas lays out. The file has no edges and no positions, so every edge here
// follows from the order of a list and from where a block ends. With a run, each part also
// says how far it is. Nothing here reads a step run of one item of a loop: a loop over
// thousands of items is its counts.

/** The words and the formats of the reader's language. */
export type CanvasText = Pick<TranslationContextValue, "locale" | "t">;
type Translate = CanvasText["t"];

/** What the canvas draws of one run. */
export interface CanvasRun {
  run: Pick<WorkflowRunView, "startedBy" | "createdAt" | "startedAt" | "ended">;
  /** The step runs outside every item of a loop: at most one per step of the definition. */
  stepRuns: readonly WorkflowStepRunView[];
  now: Date;
}

/** Where a sequence can be entered and where it is left. */
interface Ends {
  first: string | undefined;
  last: readonly { source: string; sourceExit?: string; skipped: boolean }[];
}

interface Place {
  /** The group the part stands in. */
  parentId: string | undefined;
  /** Inside a loop: the counts of the loop's own steps, by step id. Deeper steps have none. */
  counts: Readonly<Record<string, WorkflowLoopCounts>> | undefined;
  /** Inside a loop, at any depth: a step has one step run per item, so none of its own. */
  repeated: boolean;
  /** On a path of a condition the run did not take. */
  skipped: boolean;
  /** The block around the step has ended: what its counts leave open will not run. */
  ended: boolean;
}

const TOP: Place = {
  parentId: undefined,
  counts: undefined,
  repeated: false,
  skipped: false,
  ended: false
};

/** A step run in one of these states changes no more. */
function stepRunEnded(stepRun: WorkflowStepRunView): boolean {
  return stepRun.status === "done" || stepRun.status === "failed" || stepRun.status === "cancelled";
}

/** A step run's state as the canvas shows it. A loop waits while its items are at work. */
function statusOf(stepRun: WorkflowStepRunView): FlowStatus {
  switch (stepRun.status) {
    case "queued":
      return "idle";
    case "running":
      return "running";
    case "waiting":
      return stepRun.loop === undefined ? "waiting" : "running";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "skipped";
  }
}

/**
 * The state of a step of a loop, from how the step runs of the items stand. Once the loop has
 * ended, a step no item reached was skipped, and one some items did not reach is through.
 */
function statusOfCounts(counts: WorkflowLoopCounts, ended: boolean): FlowStatus {
  if (ended) {
    return counts.done + counts.failed === 0 ? "skipped" : counts.done === 0 ? "failed" : "done";
  }
  if (counts.running > 0) {
    return "running";
  }
  if (counts.total === 0 || counts.done + counts.failed === 0) {
    return "idle";
  }
  if (counts.done + counts.failed < counts.total) {
    return "running";
  }
  return counts.done === 0 ? "failed" : "done";
}

/**
 * "209 done · 3 failed · 8 running · 380 to go", without the parts that count nothing. Of a
 * loop that has ended nothing is still to go.
 */
export function countsLine(
  counts: WorkflowLoopCounts,
  { t, locale }: CanvasText,
  ended = false
): string {
  const number = (value: number) => value.toLocaleString(locale);
  const left = ended ? 0 : Math.max(0, counts.total - counts.done - counts.failed - counts.running);
  return [
    counts.done > 0 ? t("workflows.run.countDone", { count: number(counts.done) }) : undefined,
    counts.failed > 0
      ? t("workflows.run.countFailed", { count: number(counts.failed) })
      : undefined,
    counts.running > 0
      ? t("workflows.run.countRunning", { count: number(counts.running) })
      : undefined,
    left > 0 ? t("workflows.run.countLeft", { count: number(left) }) : undefined
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
}

/** The words above a step's title: its type as a reader would say it. */
function stepEyebrow(step: Pick<WorkflowStepView, "kind" | "effect">, t: Translate) {
  switch (step.kind) {
    case "trigger":
      return t("workflows.step.trigger");
    case "operation":
      return step.effect === "reading"
        ? t("workflows.step.reading")
        : step.effect === "changing"
          ? t("workflows.step.changing")
          : t("workflows.step.operation");
    case "loop":
      return t("workflows.canvas.loop");
    case "code":
      return t("workflows.step.code");
    case "agent":
      return t("workflows.step.agent");
    case "notify":
      return t("workflows.step.notify");
    case "output":
      return t("workflows.step.output");
    case "workflow":
      return t("workflows.canvas.workflow");
    case "condition":
      return t("workflows.canvas.condition");
    case "parallel":
      return t("workflows.canvas.parallel");
  }
}

/** The title of a step on the canvas and in its panel. */
function stepTitle(step: WorkflowStepView, { t, locale }: CanvasText): string {
  if (step.kind === "trigger" && step.starts !== undefined) {
    // C9: the schedule arrives as a cron expression; the common forms are put into words here.
    return step.starts.cron === undefined
      ? t(step.starts.onSchedule ? "workflows.schedule.custom" : "workflows.schedule.manualOnly")
      : (scheduleInWords(step.starts.cron, { t, locale }) ?? t("workflows.schedule.custom"));
  }
  if (step.kind === "loop" && step.itemName !== undefined) {
    return t("workflows.step.loop", { item: step.itemName });
  }
  return step.name;
}

/** The generic icon of what an operation step works on: a Data Store, a Connection, a tool. */
function sourceIcon(step: Pick<WorkflowStepView, "sourceKind">): string {
  return step.sourceKind === "data_store"
    ? "database"
    : step.sourceKind === "connection"
      ? "connection"
      : "tool";
}

/** The generic icons of a step: what it shows, and what it shows where no icon is registered. */
function stepIcon(step: WorkflowStepView): Pick<FlowGraphNode, "icon" | "iconFallback" | "accent"> {
  switch (step.kind) {
    case "trigger":
      return { icon: step.starts?.onSchedule === true ? "schedule" : "manual" };
    case "operation":
      // C8: the `service` of the step's Connection names its icon in the client's registry.
      return {
        ...(step.service === undefined ? {} : { icon: step.service }),
        iconFallback: sourceIcon(step)
      };
    case "loop":
      return { icon: "repeat" };
    case "code":
      return { icon: "code" };
    case "agent":
      return { icon: "agent", accent: true };
    case "notify":
      return { icon: step.channel === "mail" ? "mail" : "notify" };
    case "output":
      return { icon: "result" };
    case "workflow":
      return { icon: "subflow" };
    case "condition":
    case "parallel":
      return { icon: "branch" };
  }
}

function stepSummary(step: WorkflowStepView, { t, locale }: CanvasText): string | undefined {
  if (step.kind === "trigger") {
    return step.starts?.onSchedule === true && step.starts.byHand
      ? t("workflows.canvas.orByHand")
      : undefined;
  }
  if (step.description !== undefined) {
    return step.description;
  }
  if (step.kind === "loop") {
    return step.concurrency !== undefined && step.concurrency > 1
      ? t("workflows.canvas.atATime", { count: step.concurrency.toLocaleString(locale) })
      : undefined;
  }
  const fallback = stepFallbackSentence(step);
  return fallback === undefined ? undefined : t(fallback);
}

/** The drawing of a Workflow: a graph of the canvas that always names its groups. */
export type WorkflowGraph = FlowGraph & { groups: FlowGraphGroup[] };

/**
 * The graph of a Workflow, and of one run of it where `run` is given. A step is a node, a
 * `loop` and a `parallel` are groups that hold their steps, a `condition` is a node with one
 * exit per path, and a `workflow` step is a node that opens the child. `condition` and
 * `parallel` are drawn whether or not the engine of the instance runs them.
 */
export function workflowGraph(
  steps: readonly WorkflowStepView[],
  text: CanvasText,
  run?: CanvasRun
): WorkflowGraph {
  const { t, locale } = text;
  const nodes: FlowGraphNode[] = [];
  const groups: FlowGraphGroup[] = [];
  const edges: FlowGraphEdge[] = [];
  // A step of a loop has a step run per item, which has an `iteration`; those are not read.
  const stepRuns = new Map(
    (run?.stepRuns ?? [])
      .filter((stepRun) => stepRun.iteration === undefined)
      .map((stepRun) => [stepRun.stepId, stepRun])
  );
  const duration = (stepRun: WorkflowStepRunView) =>
    stepRun.startedAt === undefined
      ? undefined
      : formatElapsed(
          stepRun.startedAt,
          stepRun.finishedAt === undefined
            ? (run?.now ?? new Date())
            : new Date(stepRun.finishedAt),
          locale
        );

  const base = (step: WorkflowStepView, place: Place) => ({
    id: step.id,
    ...(place.parentId === undefined ? {} : { parentId: place.parentId }),
    ...stepIcon(step),
    eyebrow: stepEyebrow(step, t),
    title: stepTitle(step, text)
  });

  /** What a run says on a part: its state, one line and a time. */
  const ran = (
    step: WorkflowStepView,
    place: Place
  ): Partial<Pick<FlowGraphNode, "status" | "footer" | "meta" | "title">> => {
    if (run === undefined) {
      return {};
    }
    if (place.skipped) {
      return { status: "skipped" };
    }
    const counts = place.counts?.[step.id];
    if (counts !== undefined) {
      // C4: the counts of a loop's own steps. A total of none says nothing yet.
      const line = countsLine(counts, text, place.ended);
      return {
        status: statusOfCounts(counts, place.ended),
        ...(line === "" ? {} : { footer: line })
      };
    }
    const stepRun = place.repeated ? undefined : stepRuns.get(step.id);
    if (stepRun === undefined) {
      return {};
    }
    const status = statusOf(stepRun);
    const took = duration(stepRun);
    if (step.kind === "trigger") {
      return {
        status,
        title:
          run.run.startedBy === undefined
            ? t("workflows.run.startStepSchedule")
            : t("workflows.run.startStepPerson", { person: run.run.startedBy.name }),
        footer: formatMoment(stepRun.startedAt ?? run.run.startedAt ?? run.run.createdAt, locale)
      };
    }
    return {
      status,
      // C5: the sentence of the failure's reason, until the contract carries one per step.
      ...(stepRun.failure === undefined
        ? stepRun.status === "cancelled"
          ? { footer: t("workflows.run.cancelled") }
          : {}
        : { footer: t(failureSentences(stepRun.failure.reason).happened) }),
      ...(took === undefined || status === "idle" ? {} : { meta: took })
    };
  };

  const sequence = (list: readonly WorkflowStepView[], place: Place): Ends => {
    let first: string | undefined;
    let last: Ends["last"] = [];
    for (const step of list) {
      const part = one(step, place);
      if (part.first === undefined) {
        continue;
      }
      for (const end of last) {
        edges.push({
          source: end.source,
          target: part.first,
          ...(end.sourceExit === undefined ? {} : { sourceExit: end.sourceExit }),
          ...(end.skipped ? { state: "skipped" as const } : {})
        });
      }
      first ??= part.first;
      last = part.last;
    }
    return { first, last };
  };

  const one = (step: WorkflowStepView, place: Place): Ends => {
    const summary = stepSummary(step, text);
    const described = summary === undefined ? {} : { summary };
    const state = ran(step, place);
    const stepRun = place.repeated || place.skipped ? undefined : stepRuns.get(step.id);
    const straight: Ends = { first: step.id, last: [{ source: step.id, skipped: false }] };

    if (step.kind === "loop" || step.kind === "parallel") {
      const counts = stepRun?.loop;
      const through = counts === undefined ? 0 : counts.done + counts.failed;
      const took = stepRun === undefined ? undefined : duration(stepRun);
      const note =
        counts === undefined
          ? undefined
          : [took, countsLine(counts, text, stepRun !== undefined && stepRunEnded(stepRun))]
              .filter((part) => part)
              .join(" · ");
      groups.push({
        ...base(step, place),
        kind: step.kind,
        ...described,
        ...(state.status === undefined ? {} : { status: state.status }),
        ...(counts === undefined
          ? {}
          : {
              counts,
              countsLabel: t("workflows.run.count", {
                done: through.toLocaleString(locale),
                total: counts.total.toLocaleString(locale)
              }),
              ...(note ? { note } : {}),
              action: {
                label:
                  counts.failed > 0
                    ? t("workflows.canvas.showFailed", {
                        count: counts.failed.toLocaleString(locale)
                      })
                    : t("workflows.canvas.showEntries")
              }
            })
      });
      const inside: Place = {
        parentId: step.id,
        // The counts are those of the block's own steps. A step run of a block that itself
        // repeats is one of many, so its counts say nothing of the whole.
        counts: place.repeated ? undefined : stepRun?.bodyCounts,
        repeated: place.repeated || step.kind === "loop",
        skipped: place.skipped,
        ended: place.ended || (stepRun !== undefined && stepRunEnded(stepRun))
      };
      if (step.kind === "loop") {
        sequence(step.steps, inside);
      } else {
        // The paths of a parallel block have no order among them: no edge joins two of them.
        for (const branch of step.branches ?? []) {
          sequence(branch.steps, inside);
        }
      }
      return straight;
    }

    if (step.kind === "condition") {
      const branches = step.branches ?? [];
      const taken = stepRun?.taken;
      nodes.push({
        ...base(step, place),
        kind: "condition",
        ...described,
        exits: branches.map((branch) => ({
          id: branch.id,
          label:
            branch.name ??
            t(branch.id === "then" ? "workflows.canvas.exitThen" : "workflows.canvas.exitElse")
        })),
        ...(state.status === undefined ? {} : { status: state.status })
      });
      const last: Ends["last"][number][] = [];
      for (const branch of branches) {
        const skipped = place.skipped || (taken !== undefined && taken !== branch.id);
        const path = sequence(branch.steps, { ...place, skipped });
        if (path.first === undefined) {
          // A path without steps leaves the condition where the block ends.
          last.push({ source: step.id, sourceExit: branch.id, skipped });
          continue;
        }
        edges.push({
          source: step.id,
          sourceExit: branch.id,
          target: path.first,
          ...(skipped ? { state: "skipped" as const } : {})
        });
        last.push(...path.last.map((end) => ({ ...end, skipped: end.skipped || skipped })));
      }
      return { first: step.id, last };
    }

    nodes.push({
      ...base(step, place),
      kind: step.kind === "workflow" ? "subflow" : "step",
      ...described,
      ...(step.source === undefined
        ? {}
        : {
            chip: {
              label: step.source,
              icon: step.service ?? sourceIcon(step)
            }
          }),
      ...(step.kind === "workflow" ? { action: { label: t("workflows.canvas.open") } } : {}),
      ...state
    });
    return straight;
  };

  sequence(steps, TOP);
  return { nodes, groups, edges };
}

/** A step with where it stands among the blocks of its definition. */
export interface PlacedStep {
  step: WorkflowStepView;
  /** The block the step stands in directly. */
  blockId: string | undefined;
  /** Inside a loop, at any depth: a run has one step run of it per entry. */
  repeated: boolean;
}

/** Every step of a definition by its id, with the steps of its blocks. */
export function placedSteps(steps: readonly WorkflowStepView[]): Map<string, PlacedStep> {
  const found = new Map<string, PlacedStep>();
  const walk = (
    list: readonly WorkflowStepView[],
    blockId: string | undefined,
    repeated: boolean
  ) => {
    for (const step of list) {
      found.set(step.id, { step, blockId, repeated });
      walk(step.steps, step.id, repeated || step.kind === "loop");
      for (const branch of step.branches ?? []) {
        walk(branch.steps, step.id, repeated);
      }
    }
  };
  walk(steps, undefined, false);
  return found;
}
