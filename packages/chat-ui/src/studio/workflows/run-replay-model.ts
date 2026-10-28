import type { StepTone, TimelineRow } from "@work-shape/catalyst-ui";
import { formatDuration, formatTime } from "../../shared/locale-format";
import type { CanvasText } from "./workflow-canvas-model";
import type { WorkflowLoopCounts, WorkflowStepRunView, WorkflowStepView } from "./workflow-views";

// A run played back from its step runs (T31): the moments at which a step began or ended, the
// run as it stood at each of them, and the bars of a timeline that show which steps and which
// paths of a parallel block ran at the same time and how long each took. Only the step runs of
// the run's frame are read: a loop is one bar, its items are its counts.

/** A moment at which a step of the run began or ended, with the steps that did. */
export interface ReplayMoment {
  at: number;
  started: readonly string[];
  ended: readonly string[];
}

const time = (value: string | undefined) => (value === undefined ? undefined : Date.parse(value));

/** The moments of a run in their order: each start and each end of a step run, once. */
export function replayMoments(stepRuns: readonly WorkflowStepRunView[]): ReplayMoment[] {
  const moments = new Map<number, { started: string[]; ended: string[] }>();
  const at = (moment: number) => {
    const known = moments.get(moment);
    if (known) return known;
    const fresh = { started: [] as string[], ended: [] as string[] };
    moments.set(moment, fresh);
    return fresh;
  };
  for (const stepRun of stepRuns) {
    if (stepRun.iteration !== undefined || stepRun.kind === "trigger") continue;
    const started = time(stepRun.startedAt);
    if (started === undefined) continue;
    at(started).started.push(stepRun.stepId);
    const finished = time(stepRun.finishedAt);
    if (finished !== undefined) at(finished).ended.push(stepRun.stepId);
  }
  return [...moments.entries()]
    .sort(([a], [b]) => a - b)
    .map(([moment, steps]) => ({ at: moment, ...steps }));
}

/**
 * The step runs as they stood at a moment: what had not started is left out, and what had
 * started and not ended is running, without its outcome. A block's counts are those of its
 * own step runs at that moment; a loop's counts of then are not known, so it has none.
 */
export function stepRunsAt(
  stepRuns: readonly WorkflowStepRunView[],
  at: number
): WorkflowStepRunView[] {
  const then: WorkflowStepRunView[] = [];
  for (const stepRun of stepRuns) {
    const started = time(stepRun.startedAt);
    if (started === undefined || started > at) continue;
    const finished = time(stepRun.finishedAt);
    if (finished !== undefined && finished <= at) {
      then.push(stepRun);
      continue;
    }
    const {
      finishedAt: _finishedAt,
      failure: _failure,
      output: _output,
      datasets: _datasets,
      taken: _taken,
      loop: _loop,
      bodyCounts: _bodyCounts,
      ...going
    } = stepRun;
    then.push({ ...going, status: "running" });
  }
  return then.map((stepRun) => {
    if (stepRun.kind !== "parallel") return stepRun;
    const counts: Record<string, WorkflowLoopCounts> = {};
    for (const inside of then) {
      if (inside.containerStepRunId !== stepRun.id || inside.iteration !== undefined) continue;
      const count = counts[inside.stepId] ?? { total: 0, done: 0, failed: 0, running: 0 };
      counts[inside.stepId] = {
        total: count.total + 1,
        done: count.done + (inside.status === "done" ? 1 : 0),
        failed: count.failed + (inside.status === "failed" ? 1 : 0),
        running:
          count.running + (inside.status === "running" || inside.status === "waiting" ? 1 : 0)
      };
    }
    return { ...stepRun, bodyCounts: counts };
  });
}

function toneOf(stepRun: Pick<WorkflowStepRunView, "status" | "loop">): StepTone {
  switch (stepRun.status) {
    case "done":
      return (stepRun.loop?.failed ?? 0) > 0 ? "warning" : "success";
    case "failed":
      return "danger";
    case "running":
      return "info";
    case "waiting":
      return "warning";
    case "queued":
    case "cancelled":
      return "neutral";
  }
}

/** A span of a timeline, with its words. */
interface Span {
  start: number;
  end: number | undefined;
  tone: StepTone;
}

/**
 * The rows of a run's timeline, in the order of the definition: a step that ran is a row, a
 * path of a parallel block is a row under the block, set in, with the steps of a path of more
 * than one step under it. A step of a loop has a step run per item and no row. `at` is the
 * moment a running bar reaches.
 */
export function timelineRows(
  steps: readonly WorkflowStepView[],
  stepRuns: readonly WorkflowStepRunView[],
  at: number,
  { t, locale }: CanvasText
): TimelineRow[] {
  const byStep = new Map(
    stepRuns
      .filter((stepRun) => stepRun.iteration === undefined)
      .map((stepRun) => [stepRun.stepId, stepRun])
  );
  const rows: TimelineRow[] = [];
  const clock = (moment: number) => formatTime(new Date(moment).toISOString(), locale);
  const push = (id: string, label: string, depth: number, span: Span) => {
    const took = formatDuration((span.end ?? at) - span.start, locale);
    rows.push({
      id,
      label,
      depth,
      start: span.start,
      ...(span.end === undefined ? {} : { end: span.end }),
      tone: span.tone,
      meta: took,
      description:
        span.end === undefined
          ? t("workflows.replay.running", { name: label, start: clock(span.start), took })
          : t("workflows.replay.span", {
              name: label,
              start: clock(span.start),
              end: clock(span.end),
              took
            })
    });
  };
  const spanOf = (stepRun: WorkflowStepRunView | undefined): Span | undefined => {
    const start = time(stepRun?.startedAt);
    if (stepRun === undefined || start === undefined) return undefined;
    return { start, end: time(stepRun.finishedAt), tone: toneOf(stepRun) };
  };
  const walk = (list: readonly WorkflowStepView[], depth: number) => {
    for (const step of list) {
      if (step.kind === "trigger") continue;
      const stepRun = byStep.get(step.id);
      const span = spanOf(stepRun);
      if (span === undefined || stepRun === undefined) continue;
      push(step.id, step.name, depth, span);
      if (step.kind === "parallel") {
        for (const branch of step.branches ?? []) {
          const made = stepRuns.filter(
            (inside) =>
              inside.containerStepRunId === stepRun.id &&
              inside.branch === branch.id &&
              inside.iteration === undefined
          );
          const spans = made.flatMap((inside) => {
            const one = spanOf(inside);
            return one === undefined ? [] : [one];
          });
          if (spans.length === 0) continue;
          const through =
            spans.every((one) => one.end !== undefined) &&
            (made.length >= branch.steps.length || stepRun.finishedAt !== undefined);
          const tone: StepTone = spans.some((one) => one.tone === "danger")
            ? "danger"
            : through
              ? "success"
              : "info";
          push(`${step.id}/${branch.id}`, branch.name ?? branch.id, depth + 1, {
            start: Math.min(...spans.map((one) => one.start)),
            end: through ? Math.max(...spans.map((one) => one.end ?? at)) : undefined,
            tone
          });
          if (branch.steps.length > 1) walk(branch.steps, depth + 2);
        }
      } else if (step.kind === "condition") {
        for (const branch of step.branches ?? []) walk(branch.steps, depth + 1);
      }
    }
  };
  walk(steps, 0);
  return rows;
}
