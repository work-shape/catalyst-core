import { useState } from "react";
import {
  Button,
  List,
  ListRow,
  SegmentedControl,
  SegmentedControlItem,
  SkeletonList
} from "@vivd-catalyst/ui";
import { useTranslation } from "../i18n";
import { FailureBanner } from "./failure-banner";
import { useLoopEntries, type LoopEntriesRead } from "./workflow-data";
import { failureSentences } from "./workflow-model";
import type { WorkflowLoopCounts, WorkflowStepRunView, WorkflowStepView } from "./workflow-views";
import { LoadError, RunStateBadge } from "./workflows-frame";

type EntryFilter = "failed" | "running" | "all";

/** One entry of a loop, from the step runs the page holds of it. */
export interface LoopEntry {
  index: number;
  label?: string;
  status: "failed" | "running" | "done" | "cancelled";
  /** The step run that failed, where one did. */
  failed?: WorkflowStepRunView;
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
    entries.set(
      index,
      stepRun.status === "failed"
        ? { ...held, status: "failed", failed: stepRun }
        : held.status === "failed"
          ? held
          : going
            ? { ...held, status: "running" }
            : stepRun.status === "cancelled" && held.status === "done"
              ? { ...held, status: "cancelled" }
              : held
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
  runEnded
}: {
  runId: string;
  /** The loop, whose steps name the step an entry failed at. */
  loop: WorkflowStepView;
  stepRun: WorkflowStepRunView & { loop: WorkflowLoopCounts };
  runEnded: boolean;
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
    />
  );
}

/** The list of a loop's entries for a given reading. */
export function LoopEntriesView({
  loop,
  counts,
  filter,
  onFilterChange,
  read
}: {
  loop: WorkflowStepView;
  counts: WorkflowLoopCounts;
  filter: EntryFilter;
  onFilterChange(filter: EntryFilter): void;
  read: LoopEntriesRead;
}) {
  const { t } = useTranslation();
  const entries = read.stepRuns === undefined ? undefined : loopEntries(read.stepRuns);
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3" data-loop-entries="">
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
      {read.failed ? (
        <LoadError onRetry={read.retry}>{t("workflows.run.entriesFailed")}</LoadError>
      ) : entries === undefined ? (
        <SkeletonList rows={4} />
      ) : entries.length === 0 ? (
        <p className="text-caption text-muted-foreground">{t("workflows.run.noEntries")}</p>
      ) : (
        <List aria-label={t("workflows.run.entries")}>
          {entries.map((entry) => (
            <LoopEntryRow key={entry.index} entry={entry} loop={loop} />
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

/** One entry: its label and where it stands. A failed one unfolds to why. */
function LoopEntryRow({ entry, loop }: { entry: LoopEntry; loop: WorkflowStepView }) {
  const { t } = useTranslation();
  const name = entry.label ?? t("workflows.run.entry", { number: entry.index + 1 });
  const failure = entry.failed?.failure;
  const failedAt = loop.steps.find((step) => step.id === entry.failed?.stepId)?.name;
  const reason =
    failure === undefined
      ? undefined
      : [
          failedAt === undefined ? undefined : t("workflows.run.atStep", { step: failedAt }),
          t(failureSentences(failure.reason).happened)
        ]
          .filter((part) => part !== undefined)
          .join(" · ");
  return (
    <ListRow
      size="compact"
      title={name}
      description={reason}
      descriptionWraps
      chips={<RunStateBadge status={entry.status} />}
      expandable={failure !== undefined}
    >
      {failure === undefined ? null : <FailureBanner failure={failure} />}
    </ListRow>
  );
}
