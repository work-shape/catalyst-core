import { useState } from "react";
import {
  Badge,
  Button,
  List,
  ListRow,
  LoadError,
  SegmentedControl,
  SegmentedControlItem,
  SkeletonList,
  TargetBadge
} from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { FailureBanner } from "./failure-banner";
import { useLoopEntries, type LoopEntriesRead } from "./workflow-data";
import { failureHappened, stepConnection } from "./workflow-model";
import type {
  WorkflowLoopCounts,
  WorkflowStepRunView,
  WorkflowStepTarget,
  WorkflowStepView
} from "./workflow-views";
import { RunStateBadge } from "./workflows-frame";

type EntryFilter = "failed" | "running" | "all";

/** One entry of a loop, from the step runs the page holds of it. */
export interface LoopEntry {
  index: number;
  label?: string;
  status: "failed" | "running" | "done" | "cancelled";
  /** The step run that failed, where one did. */
  failed?: WorkflowStepRunView;
  /** A loop of the entry ended `done` with failed entries of its own. */
  withFailedEntries?: true;
  /** Where the calls of its steps that change something went, each once, in a test run. */
  targets?: readonly WorkflowStepTarget[];
  /** In a test run: a run of the published revision would ask for an approval in this entry. */
  publishedWouldAsk?: true;
}

/**
 * The entries a list of step runs speaks of, in the order they first appear. An entry failed
 * when one of its steps did, and is at work while one of its steps has not ended.
 */
export function loopEntries(stepRuns: readonly WorkflowStepRunView[]): LoopEntry[] {
  const entries = new Map<number, LoopEntry>();
  for (const stepRun of stepRuns) {
    const index = stepRun.iteration?.index;
    if (index === undefined) {
      continue;
    }
    const label = stepRun.iteration?.label;
    const held = entries.get(index) ?? {
      index,
      ...(label === undefined ? {} : { label }),
      status: "done" as const
    };
    const going =
      stepRun.status === "queued" || stepRun.status === "running" || stepRun.status === "waiting";
    const { target } = stepRun;
    const targets =
      target === undefined || stepRun.effect !== "changing" || held.targets?.includes(target)
        ? held.targets
        : [...(held.targets ?? []), target];
    const counted = {
      ...held,
      ...(targets === undefined ? {} : { targets }),
      ...(stepRun.publishedWouldAsk === "approval" ? { publishedWouldAsk: true as const } : {}),
      ...((stepRun.loop?.failed ?? 0) > 0 ? { withFailedEntries: true as const } : {})
    };
    entries.set(
      index,
      stepRun.status === "failed"
        ? { ...counted, status: "failed", failed: stepRun }
        : counted.status === "failed"
          ? counted
          : going
            ? { ...counted, status: "running" }
            : stepRun.status === "cancelled" && counted.status === "done"
              ? { ...counted, status: "cancelled" }
              : counted
    );
  }
  return [...entries.values()];
}

/** The filter a loop's entries open on: the failed ones are what a reader came for. */
export function defaultEntryFilter(counts: WorkflowLoopCounts, runEnded: boolean): EntryFilter {
  return counts.failed > 0 ? "failed" : counts.running > 0 && !runEnded ? "running" : "all";
}

/**
 * The entries of a loop in the panel of its step: the failed ones, the ones at work, or all.
 * The instance filters; the counts on the filter are the loop's own.
 */
export function LoopEntries({
  runId,
  loop,
  stepRun,
  runEnded,
  onOpenChild
}: {
  runId: string;
  /** The loop, whose steps name the step an entry failed at. */
  loop: WorkflowStepView;
  stepRun: WorkflowStepRunView & { loop: WorkflowLoopCounts };
  runEnded: boolean;
  /** Opens the child run an entry's `workflow` step started. */
  onOpenChild(step: WorkflowStepView, stepRun: WorkflowStepRunView): void;
}) {
  const [chosen, setChosen] = useState<EntryFilter>();
  const filter = chosen ?? defaultEntryFilter(stepRun.loop, runEnded);
  const read = useLoopEntries({
    runId,
    containerStepRunId: stepRun.id,
    status: filter === "all" ? undefined : filter,
    following: !runEnded
  });
  return (
    <LoopEntriesView
      loop={loop}
      counts={stepRun.loop}
      filter={filter}
      onFilterChange={setChosen}
      read={read}
      onOpenChild={onOpenChild}
    />
  );
}

/** The list of a loop's entries for a given reading. */
export function LoopEntriesView({
  loop,
  counts,
  filter,
  onFilterChange,
  read,
  onOpenChild
}: {
  loop: WorkflowStepView;
  counts: WorkflowLoopCounts;
  filter: EntryFilter;
  onFilterChange(filter: EntryFilter): void;
  read: LoopEntriesRead;
  onOpenChild(step: WorkflowStepView, stepRun: WorkflowStepRunView): void;
}) {
  const { t } = useTranslation();
  const entries = read.stepRuns === undefined ? undefined : loopEntries(read.stepRuns);
  return (
    <div className="grid min-w-0 grid-cols-1" data-loop-entries="">
      {/* The filter stays in sight while the list scrolls under it. */}
      <div className="sticky -top-4 z-10 -mx-4 -mt-4 bg-background px-4 pt-4 pb-3">
        <SegmentedControl
          size="sm"
          label={t("workflows.run.filter")}
          value={filter}
          onValueChange={(value) =>
            onFilterChange(value === "failed" || value === "running" ? value : "all")
          }
        >
          {counts.failed > 0 ? (
            <SegmentedControlItem value="failed" count={counts.failed} exactCount>
              {t("workflows.run.filterFailed")}
            </SegmentedControlItem>
          ) : null}
          {counts.running > 0 ? (
            <SegmentedControlItem value="running" count={counts.running} exactCount>
              {t("workflows.run.filterRunning")}
            </SegmentedControlItem>
          ) : null}
          <SegmentedControlItem value="all" count={counts.total} exactCount>
            {t("workflows.run.filterAll")}
          </SegmentedControlItem>
        </SegmentedControl>
      </div>
      {read.failed ? (
        <LoadError onRetry={read.retry}>{t("workflows.run.entriesFailed")}</LoadError>
      ) : entries === undefined ? (
        <SkeletonList rows={4} />
      ) : entries.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t("workflows.run.noEntries")}</p>
      ) : (
        <List aria-label={t("workflows.run.entries")}>
          {entries.map((entry) => (
            <LoopEntryRow key={entry.index} entry={entry} loop={loop} onOpenChild={onOpenChild} />
          ))}
        </List>
      )}
      {read.hasMore ? (
        <Button
          variant="outline"
          size="sm"
          className="justify-self-start"
          loading={read.loadingMore}
          onClick={read.loadMore}
        >
          {t("workflows.showMore")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One entry: its label and where it stands. A failed one says why; where it failed in a child
 * run, the row opens that run, which tells the rest. Any other failed one unfolds to why.
 */
function LoopEntryRow({
  entry,
  loop,
  onOpenChild
}: {
  entry: LoopEntry;
  loop: WorkflowStepView;
  onOpenChild(step: WorkflowStepView, stepRun: WorkflowStepRunView): void;
}) {
  const { t } = useTranslation();
  const name = entry.label ?? t("workflows.run.entry", { number: entry.index + 1 });
  const failure = entry.failed?.failure;
  const failedStep = loop.steps.find((step) => step.id === entry.failed?.stepId);
  const failedAt = failedStep?.name;
  const failedChild =
    failedStep?.kind === "workflow" && entry.failed?.childRunId !== undefined
      ? { step: failedStep, stepRun: entry.failed }
      : undefined;
  const reason =
    failure === undefined
      ? undefined
      : [
          failedAt === undefined ? undefined : t("workflows.run.atStep", { step: failedAt }),
          failureHappened(failure, t, { connection: stepConnection(failedStep, entry.failed) })
        ]
          .filter((part) => part !== undefined)
          .join(" · ");
  return (
    <ListRow
      size="compact"
      title={name}
      description={reason}
      // The panel is a narrow column in every window: the reason is read whole.
      descriptionWraps="always"
      chips={
        <>
          {(entry.targets ?? []).map((target) => (
            <TargetBadge key={target} target={target} />
          ))}
          {entry.publishedWouldAsk ? (
            <Badge tone="warning" size="sm" truncate data-published-asks="approval">
              {t("workflows.run.publishedAsksShort")}
            </Badge>
          ) : null}
          <RunStateBadge
            status={entry.status}
            withFailedEntries={entry.withFailedEntries === true}
          />
        </>
      }
      {...(failedChild === undefined
        ? { expandable: failure !== undefined }
        : { onClick: () => onOpenChild(failedChild.step, failedChild.stepRun) })}
      data-child-run={failedChild?.stepRun.childRunId}
    >
      {failure === undefined || failedChild !== undefined ? null : (
        <FailureBanner failure={failure} connection={stepConnection(failedStep, entry.failed)} />
      )}
    </ListRow>
  );
}
