import type {
  FlowChange,
  FlowGraph,
  FlowGraphEdge,
  FlowGraphGroup,
  FlowGraphNode,
  FlowLane,
  FlowStatus
} from "@work-shape/catalyst-ui";
import type { WorkflowConditionOutput } from "@work-shape/catalyst-core";
import { formatDuration, formatMoment } from "../../shared/locale-format";
import type { TranslationContextValue } from "../../shared/i18n";
import { NO_RECIPIENT_NAMES, recipientsLine, type RecipientNames } from "./recipient-names";
import { MAIL_ICON_FALLBACK, mailAnswerOf, mailSummary } from "./mail-step";
import { triggerInWords } from "./schedule-words";
import {
  failureHappened,
  stepConnection,
  stepFallbackSentence,
  type InstanceTimeZone
} from "./workflow-model";
import type {
  WorkflowLoopCounts,
  WorkflowRunView,
  WorkflowStepRunView,
  WorkflowStepView
} from "./workflow-views";
import { personName } from "../../shared/person-name";

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
  run: Pick<WorkflowRunView, "startedBy" | "createdAt" | "startedAt" | "ended" | "runsAs">;
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
  /** In a parallel block: the path the part stands on, which is its lane on the canvas. */
  lane?: string;
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

/**
 * A step run's state as the canvas shows it. A loop waits while its items are at work, and one
 * that ended `done` with failed items is done with failures.
 */
function statusOf(stepRun: WorkflowStepRunView): FlowStatus {
  switch (stepRun.status) {
    case "queued":
      return "idle";
    case "running":
      return "running";
    case "waiting":
      return stepRun.loop === undefined ? "waiting" : "running";
    case "done":
      return (stepRun.loop?.failed ?? 0) > 0 ? "doneWithFailures" : "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "skipped";
  }
}

/** Of items that are all through: failed where none was done, with failures where some were. */
function statusOfThrough(counts: WorkflowLoopCounts): FlowStatus {
  return counts.done === 0 ? "failed" : counts.failed > 0 ? "doneWithFailures" : "done";
}

/**
 * The state of a step of a loop, from how the step runs of the items stand. Once the loop has
 * ended, a step no item reached was skipped, and one some items did not reach is through.
 */
function statusOfCounts(counts: WorkflowLoopCounts, ended: boolean): FlowStatus {
  if (ended) {
    return counts.done + counts.failed === 0 ? "skipped" : statusOfThrough(counts);
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
  return statusOfThrough(counts);
}

/**
 * "209 done · 3 failed · 8 running · 380 to go", without the parts that count nothing. Of a
 * loop that has ended nothing is still to go.
 */
export function countsLine(
  counts: WorkflowLoopCounts,
  { t, locale }: CanvasText,
  ended = false,
  /** Leaves the failed out, where they stand beside the line in a colour of their own. */
  withFailed = true
): string {
  const number = (value: number) => value.toLocaleString(locale);
  const left = ended ? 0 : Math.max(0, counts.total - counts.done - counts.failed - counts.running);
  return [
    counts.done > 0 ? t("workflows.run.countDone", { count: number(counts.done) }) : undefined,
    withFailed && counts.failed > 0
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
function stepEyebrow(step: Pick<WorkflowStepView, "kind" | "effect" | "mail">, t: Translate) {
  switch (step.kind) {
    case "trigger":
      return t("workflows.step.trigger");
    case "operation":
      // workflow-canvas 3, Send email: "E-Mail senden" / "Sends an e-mail".
      if (step.mail !== undefined) return t("workflows.mail.eyebrow");
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
function stepTitle(
  step: WorkflowStepView,
  { t, locale }: CanvasText,
  instanceTimeZone: InstanceTimeZone | undefined
): string {
  if (step.kind === "trigger" && step.starts !== undefined) {
    // C9: the schedule arrives as a cron expression; the common forms are put into words here.
    return triggerInWords(step.starts, { t, locale }, instanceTimeZone);
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
      // The sender's icon: the instance's `system-mail` mark where the assembly registers one,
      // else the generic mail icon. The transport has none.
      if (step.mail !== undefined) {
        return {
          ...(step.mail.icon === undefined ? {} : { icon: step.mail.icon }),
          iconFallback: MAIL_ICON_FALLBACK
        };
      }
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

function stepSummary(
  step: WorkflowStepView,
  { t, locale }: CanvasText,
  recipients: RecipientNames
): string | undefined {
  if (step.kind === "notify") {
    // workflow-canvas.md, Notify: the node says who receives it.
    const line = recipientsLine(step.to, recipients, { t, locale });
    if (line !== undefined) return line;
  }
  if (step.kind === "trigger") {
    return step.starts?.onSchedule === true && step.starts.byHand
      ? t("workflows.canvas.orByHand")
      : undefined;
  }
  if (step.mail !== undefined) {
    // workflow-canvas 3, Send email: the first recipient, how many more, and the subject.
    const line = mailSummary(step.mail, recipients, { t, locale });
    if (line !== undefined) return line;
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

/**
 * The footer of a Send email step that ended well: "Sent to 3 at 07:42", "Sent to you as a test
 * at 07:42", or "Simulated" in a test run. Nothing where the output says neither.
 */
export function mailFooter(
  stepRun: Pick<WorkflowStepRunView, "output" | "target" | "finishedAt">,
  { t, locale }: CanvasText
): string | undefined {
  if (stepRun.target === "dry_run") return t("workflows.mail.simulated");
  const answer = mailAnswerOf(stepRun.output);
  // A test send's answer is the run's data: without it, that it went out as a test is known.
  if (answer?.kind !== "sent")
    return stepRun.target === "test" ? t("workflows.mail.sentTest") : undefined;
  const at = answer.sentAt ?? stepRun.finishedAt;
  const time =
    at === undefined
      ? undefined
      : new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(
          new Date(at)
        );
  if (answer.test) {
    return time === undefined
      ? t("workflows.mail.sentTest")
      : t("workflows.mail.sentTestAt", { time });
  }
  const count = answer.count.toLocaleString(locale);
  return time === undefined
    ? t("workflows.mail.sentTo", { count })
    : t("workflows.mail.sentToAt", { count, time });
}

/** The counts of a block's own steps added up: how far the block is as a whole. */
function summed(
  counts: Readonly<Record<string, WorkflowLoopCounts>> | undefined
): WorkflowLoopCounts | undefined {
  if (counts === undefined) return undefined;
  const all = Object.values(counts);
  if (all.length === 0) return undefined;
  return all.reduce(
    (sum, part) => ({
      total: sum.total + part.total,
      done: sum.done + part.done,
      failed: sum.failed + part.failed,
      running: sum.running + part.running
    }),
    { total: 0, done: 0, failed: 0, running: 0 }
  );
}

/**
 * A condition and the conditions that stand alone in its `else`, one inside the other: the
 * tests of one multi-way fork, in the order they are made.
 */
export function conditionChain(step: WorkflowStepView): WorkflowStepView[] {
  const chain = [step];
  for (let test = step; ;) {
    const otherwise = test.branches?.find((branch) => branch.id === "else")?.steps;
    const only = otherwise?.length === 1 ? otherwise[0] : undefined;
    if (only?.kind !== "condition") return chain;
    chain.push(only);
    test = only;
  }
}

/** A path of a condition. */
type ConditionPath = WorkflowConditionOutput["taken"];

/**
 * One way out of a fork: the exit it leaves by, its words, and the steps on it. A test further
 * down the chain stands on the way it opens, which is its row of the fork.
 */
interface ForkPath {
  exit: string;
  label: string;
  steps: readonly WorkflowStepView[];
  test?: WorkflowStepView;
}

/**
 * The exit of a path of a condition further down a chain: the condition's id and the path,
 * so a place on it names the condition it belongs to. The first condition's are `then` and
 * `else`.
 */
function chainExit(conditionId: string, path: ConditionPath): string {
  return `${conditionId}:${path}`;
}

/** The ways out of a chain of conditions: each test's `then`, then the last `else`. */
function forkPaths(chain: readonly WorkflowStepView[], t: Translate): ForkPath[] {
  const pathOf = (test: WorkflowStepView, id: ConditionPath) =>
    test.branches?.find((branch) => branch.id === id);
  const paths = chain.map((test, index) => {
    const then = pathOf(test, "then");
    return {
      exit: index === 0 ? "then" : chainExit(test.id, "then"),
      label:
        index === 0
          ? (then?.name ?? t("workflows.canvas.exitThen"))
          : t("workflows.canvas.exitElseIf", { name: test.name }),
      steps: then?.steps ?? [],
      ...(index === 0 ? {} : { test })
    };
  });
  const last = chain.at(-1) ?? chain[0];
  const otherwise = last === undefined ? undefined : pathOf(last, "else");
  paths.push({
    exit: chain.length === 1 || last === undefined ? "else" : chainExit(last.id, "else"),
    label: otherwise?.name ?? t("workflows.canvas.exitElse"),
    steps: otherwise?.steps ?? []
  });
  return paths;
}

/**
 * The drawing of a Workflow: a graph of the canvas that always names its groups. A test further
 * down a chain of conditions is a row of its fork, not a node; `tests` holds what its panel
 * shows of it.
 */
export type WorkflowGraph = FlowGraph & { groups: FlowGraphGroup[]; tests: FlowGraphNode[] };

/**
 * How a step of a draft differs from the published revision, for its mark on the canvas
 * (workflow-canvas 9.5), and the published step a changed one was.
 */
export interface CanvasMark {
  change: FlowChange;
  was?: WorkflowStepView;
}

/**
 * The graph of a Workflow, and of one run of it where `run` is given. A step is a node, a
 * `loop` and a `parallel` are groups that hold their steps, a `condition` is a node with one
 * exit per path, and a `workflow` step is a node that opens the child. `condition` and
 * `parallel` are drawn whether or not the engine of the instance runs them.
 */
export function workflowGraph(
  steps: readonly WorkflowStepView[],
  text: CanvasText,
  run?: CanvasRun,
  /** The names of who a Notify step reaches, as far as the reader may read them. */
  recipients: RecipientNames = NO_RECIPIENT_NAMES,
  /** The instance's zone, for a schedule saved without one of its own. */
  instanceTimeZone?: InstanceTimeZone,
  /** The marks of a draft against the published revision, by step id. */
  marks?: ReadonlyMap<string, CanvasMark>
): WorkflowGraph {
  const { t, locale } = text;
  const nodes: FlowGraphNode[] = [];
  const groups: FlowGraphGroup[] = [];
  const edges: FlowGraphEdge[] = [];
  const tests: FlowGraphNode[] = [];
  // A step of a loop has a step run per item, which has an `iteration`; those are not read.
  const stepRuns = new Map(
    (run?.stepRuns ?? [])
      .filter((stepRun) => stepRun.iteration === undefined)
      .map((stepRun) => [stepRun.stepId, stepRun])
  );
  // To the second, as the timeline of the run says it.
  const elapsed = (start: string, end: Date) =>
    formatDuration(end.getTime() - Date.parse(start), locale);
  const duration = (stepRun: WorkflowStepRunView) =>
    stepRun.startedAt === undefined
      ? undefined
      : elapsed(
          stepRun.startedAt,
          stepRun.finishedAt === undefined ? (run?.now ?? new Date()) : new Date(stepRun.finishedAt)
        );

  const marked = (step: WorkflowStepView): Pick<FlowGraphNode, "change" | "oldSummary"> => {
    const mark = marks?.get(step.id);
    if (mark === undefined) return {};
    // A changed step whose sentence changed shows the published one struck through.
    const old =
      mark.was === undefined || mark.change === "new" || mark.change === "removed"
        ? undefined
        : stepSummary(mark.was, text, recipients);
    return {
      change: mark.change,
      ...(old === undefined || old === stepSummary(step, text, recipients)
        ? {}
        : { oldSummary: old })
    };
  };

  const base = (step: WorkflowStepView, place: Place) => ({
    id: step.id,
    ...(place.parentId === undefined ? {} : { parentId: place.parentId }),
    ...(place.lane === undefined ? {} : { lane: place.lane }),
    ...stepIcon(step),
    eyebrow: stepEyebrow(step, t),
    title: stepTitle(step, text, instanceTimeZone),
    ...marked(step)
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
    // A step of a block that runs once has a step run of its own, which says more than counts.
    const stepRun = place.repeated ? undefined : stepRuns.get(step.id);
    const counts = place.counts?.[step.id];
    if (counts !== undefined && stepRun === undefined) {
      // C4: the counts of a loop's own steps. A total of none says nothing yet.
      const line = countsLine(counts, text, place.ended);
      return {
        status: statusOfCounts(counts, place.ended),
        ...(line === "" ? {} : { footer: line })
      };
    }
    if (stepRun === undefined) {
      // Of a run that has ended, a step without a step run was not reached. A step of a loop
      // has one per entry and none of its own, so its place says nothing here.
      return run.run.ended && !place.repeated
        ? { status: "skipped", footer: t("workflows.canvas.notReached") }
        : {};
    }
    const status = statusOf(stepRun);
    const took = duration(stepRun);
    if (step.kind === "trigger") {
      return {
        status,
        title:
          run.run.startedBy === undefined
            ? t("workflows.run.startStepSchedule")
            : t("workflows.run.startStepPerson", { person: personName(run.run.startedBy.name, t) }),
        footer: formatMoment(stepRun.startedAt ?? run.run.startedAt ?? run.run.createdAt, locale)
      };
    }
    const mailed =
      step.mail !== undefined && stepRun.status === "done" && stepRun.failure === undefined
        ? mailFooter(stepRun, text)
        : undefined;
    return {
      status,
      // C5: the sentence of the failure's reason, until the contract carries one per step.
      ...(stepRun.failure === undefined
        ? stepRun.status === "cancelled"
          ? { footer: t("workflows.run.cancelled") }
          : mailed === undefined
            ? {}
            : { footer: mailed }
        : {
            footer: failureHappened(stepRun.failure, t, {
              account: run.run.runsAs,
              connection: stepConnection(step, stepRun)
            })
          }),
      ...(took === undefined || status === "idle" ? {} : { meta: took })
    };
  };

  /** The step runs a block made directly on one of its paths. */
  const onPath = (block: WorkflowStepRunView, path: string) =>
    (run?.stepRuns ?? []).filter(
      (stepRun) =>
        stepRun.containerStepRunId === block.id &&
        stepRun.branch === path &&
        stepRun.iteration === undefined
    );

  /**
   * How one path of a parallel block went, for its lane: its state and how long it took, from
   * its first step's start to its last step's end. A block that repeats in a loop has a step
   * run per item and its lanes say nothing.
   */
  const lane = (
    branch: { id: string; steps: readonly WorkflowStepView[] },
    block: WorkflowStepRunView | undefined,
    skipped: boolean
  ): Pick<FlowLane, "status" | "meta"> => {
    if (run === undefined) return {};
    if (block === undefined) return skipped ? { status: "skipped" } : {};
    const made = onPath(block, branch.id);
    const blockEnded = stepRunEnded(block);
    if (made.length === 0) return blockEnded ? { status: "skipped" } : {};
    const going = made.filter((stepRun) => !stepRunEnded(stepRun));
    const through = going.length === 0 && (blockEnded || made.length >= branch.steps.length);
    const status: FlowStatus = made.some((stepRun) => stepRun.status === "failed")
      ? "failed"
      : !through
        ? going.some((stepRun) => stepRun.status === "waiting")
          ? "waiting"
          : "running"
        : made.some((stepRun) => stepRun.status === "done")
          ? "done"
          : "skipped";
    const starts = made.flatMap((stepRun) =>
      stepRun.startedAt === undefined ? [] : [stepRun.startedAt]
    );
    const ends = made.flatMap((stepRun) =>
      stepRun.finishedAt === undefined ? [] : [Date.parse(stepRun.finishedAt)]
    );
    const start = starts.sort()[0];
    if (start === undefined) return { status };
    const end = through && ends.length > 0 ? new Date(Math.max(...ends)) : run.now;
    return { status, meta: elapsed(start, end) };
  };

  /**
   * The path of a chain of conditions the run took, by its exit: the first test that held, or
   * the last `else`. A condition says it by `taken`, or by the path its first step run is on;
   * the next test of the chain having run says its `else` was taken.
   */
  const takenPath = (
    chain: readonly WorkflowStepView[],
    paths: readonly ForkPath[],
    place: Place
  ): string | undefined => {
    if (run === undefined || place.repeated || place.skipped) return undefined;
    for (const [index, test] of chain.entries()) {
      const decided = stepRuns.get(test.id);
      const next = chain[index + 1];
      const taken =
        decided === undefined
          ? undefined
          : (decided.taken ??
            onPathAny(decided)?.branch ??
            (next !== undefined && stepRuns.has(next.id) ? "else" : undefined));
      if (taken === undefined) return undefined;
      if (taken === "then") return paths[index]?.exit;
      if (next === undefined) return paths.at(-1)?.exit;
    }
    return undefined;
  };
  const onPathAny = (block: WorkflowStepRunView) =>
    (run?.stepRuns ?? []).find(
      (stepRun) => stepRun.containerStepRunId === block.id && stepRun.branch !== undefined
    );

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
    // In a run the start says who started it, so how else it could start is left out.
    const summary =
      run !== undefined && step.kind === "trigger"
        ? undefined
        : stepSummary(step, text, recipients);
    const described = summary === undefined ? {} : { summary };
    const state = ran(step, place);
    const stepRun = place.repeated || place.skipped ? undefined : stepRuns.get(step.id);
    const straight: Ends = { first: step.id, last: [{ source: step.id, skipped: false }] };

    if (step.kind === "loop" || step.kind === "parallel") {
      // A loop counts its items; a parallel block counts the step runs of its own steps.
      const counts = step.kind === "loop" ? stepRun?.loop : summed(stepRun?.bodyCounts);
      const through = counts === undefined ? 0 : counts.done + counts.failed;
      const took = stepRun === undefined ? undefined : duration(stepRun);
      const note =
        counts === undefined
          ? undefined
          : step.kind === "parallel"
            ? took
            : [
                took,
                countsLine(counts, text, stepRun !== undefined && stepRunEnded(stepRun), false)
              ]
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
              countsLabel: t(
                step.kind === "loop" ? "workflows.run.count" : "workflows.canvas.stepsCount",
                {
                  done: through.toLocaleString(locale),
                  total: counts.total.toLocaleString(locale)
                }
              ),
              ...(counts.failed > 0
                ? {
                    failedLabel: t("workflows.run.countFailed", {
                      count: counts.failed.toLocaleString(locale)
                    })
                  }
                : {}),
              ...(note ? { note } : {}),
              ...(step.kind === "loop"
                ? {
                    action: {
                      label:
                        counts.failed > 0
                          ? t("workflows.canvas.showFailed", {
                              count: counts.failed.toLocaleString(locale)
                            })
                          : t("workflows.canvas.showEntries")
                    }
                  }
                : {})
            }),
        ...(step.kind === "parallel"
          ? {
              lanes: (step.branches ?? []).map((branch) => ({
                id: branch.id,
                label: branch.name ?? branch.id,
                ...lane(branch, stepRun, place.skipped || state.status === "skipped")
              })),
              joinLabel: t("workflows.canvas.joinAll")
            }
          : {})
      });
      const inside: Place = {
        parentId: step.id,
        // The counts are those of the block's own steps. A step run of a block that itself
        // repeats is one of many, so its counts say nothing of the whole.
        counts: place.repeated ? undefined : stepRun?.bodyCounts,
        repeated: place.repeated || step.kind === "loop",
        // A block an ended run did not reach: nor did it reach what the block holds.
        skipped: place.skipped || (stepRun === undefined && state.status === "skipped"),
        ended: place.ended || (stepRun !== undefined && stepRunEnded(stepRun))
      };
      if (step.kind === "loop") {
        sequence(step.steps, inside);
      } else {
        // The paths of a parallel block have no order among them: no edge joins two of them.
        // Each is a lane of the block, side by side with the others.
        for (const branch of step.branches ?? []) {
          sequence(branch.steps, { ...inside, lane: branch.id });
        }
      }
      return straight;
    }

    if (step.kind === "condition") {
      // A condition in the `else` of another is one more way out of the same fork.
      const chain = conditionChain(step);
      const paths = forkPaths(chain, t);
      const taken = takenPath(chain, paths, place);
      // A test of the chain that failed says so on the fork; otherwise the first test speaks.
      const failed = chain.find(
        (test) => !place.repeated && stepRuns.get(test.id)?.status === "failed"
      );
      const decided = failed === undefined ? state : ran(failed, place);
      // A further test is a row of the fork that opens its own panel and says how it went.
      const exits = paths.map((path) => {
        if (path.test === undefined) return { id: path.exit, label: path.label };
        const tested = ran(path.test, place);
        const testSummary = stepSummary(path.test, text, recipients);
        tests.push({
          ...base(path.test, place),
          kind: "condition",
          ...(testSummary === undefined ? {} : { summary: testSummary }),
          ...tested
        });
        return {
          id: path.exit,
          label: path.label,
          part: {
            id: path.test.id,
            ...(tested.status === undefined ? {} : { status: tested.status }),
            ...(tested.meta === undefined ? {} : { meta: tested.meta })
          }
        };
      });
      nodes.push({
        ...base(step, place),
        kind: "condition",
        ...described,
        exits,
        ...(decided.status === undefined ? {} : { status: decided.status }),
        ...(decided.meta === undefined ? {} : { meta: decided.meta })
      });
      const last: Ends["last"][number][] = [];
      for (const path of paths) {
        const skipped = place.skipped || (taken !== undefined && taken !== path.exit);
        const ends = sequence(path.steps, { ...place, skipped });
        if (ends.first === undefined) {
          // A path without steps leaves the condition where the block ends.
          last.push({ source: step.id, sourceExit: path.exit, skipped });
          continue;
        }
        edges.push({
          source: step.id,
          sourceExit: path.exit,
          target: ends.first,
          ...(skipped ? { state: "skipped" as const } : {})
        });
        last.push(...ends.last.map((end) => ({ ...end, skipped: end.skipped || skipped })));
      }
      return { first: step.id, last };
    }

    nodes.push({
      ...base(step, place),
      kind: step.kind === "workflow" ? "subflow" : "step",
      ...described,
      ...(step.mail !== undefined
        ? (step.mail.senderName ?? step.mail.senderTitle) === undefined
          ? {}
          : {
              // The sender by the name the mail goes out with, never the transport.
              chip: {
                label: step.mail.senderName ?? step.mail.senderTitle ?? "",
                ...(step.mail.icon === undefined ? {} : { icon: step.mail.icon }),
                iconFallback: MAIL_ICON_FALLBACK
              }
            }
        : step.source === undefined
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
  return { nodes, groups, edges, tests };
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
