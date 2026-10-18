import { useState } from "react";
import { Badge, Button, List, ListRow, SkeletonList } from "@work-shape/catalyst-ui";
import { formatMomentShort } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import type { WorkflowRunList } from "./workflow-data";
import { runFailedBecause } from "./workflow-model";
import type { WorkflowRunView } from "./workflow-views";
import {
  LoadError,
  RunStateBadge,
  durationText,
  routeLink,
  type OpenRoute
} from "./workflows-frame";

/** Who started a run, as a part of a sentence. */
export function startedByText(
  run: Pick<WorkflowRunView, "startedBy">,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  return run.startedBy === undefined
    ? t("workflows.run.startedBySchedule")
    : t("workflows.run.startedByPerson", { person: run.startedBy.name });
}

/** The run key of a run, as a part of a sentence. Nothing on a run started without one. */
export function runKeyText(
  run: Pick<WorkflowRunView, "runKey">,
  t: ReturnType<typeof useTranslation>["t"]
): string | undefined {
  return run.runKey === undefined ? undefined : t("workflows.run.keyLine", { key: run.runKey });
}

/** One row of the list: a run, or runs side by side that found nothing to do. */
type RunsListEntry =
  { kind: "run"; run: WorkflowRunView } | { kind: "empty"; runs: readonly WorkflowRunView[] };

/** The fewest empty runs side by side that fold into one row. A lone one stands as it is. */
const FOLD_FROM = 2;

/**
 * The rows of the list in their order, with each stretch of empty runs folded into one. A run
 * counts as empty by its own mark, not by the Workflow's kind now, so a Workflow whose kind
 * changed folds the runs it made as the kind it had. A test run and a failed run always stand.
 */
function foldEmptyRuns(runs: readonly WorkflowRunView[]): RunsListEntry[] {
  const entries: RunsListEntry[] = [];
  let stretch: WorkflowRunView[] = [];
  const close = () => {
    if (stretch.length >= FOLD_FROM) {
      entries.push({ kind: "empty", runs: stretch });
    } else {
      entries.push(...stretch.map((run) => ({ kind: "run" as const, run })));
    }
    stretch = [];
  };
  for (const run of runs) {
    if (run.empty && run.status === "done" && !run.test) {
      stretch.push(run);
    } else {
      close();
      entries.push({ kind: "run", run });
    }
  }
  close();
  return entries;
}

/**
 * Runs of one Workflow, newest first: when each started, who started it, how long it took and
 * how it ended, and for a failed run why, in the sentence its page says. Each row opens its run.
 * A row is two lines at every width, and a failed run's three: why it failed is a line of its
 * own, cut where it does not fit and read whole on hover. Runs side by side that found nothing
 * to do fold into one row, "3 empty runs", which unfolds to each of them.
 */
export function RunsList({
  workspaceId,
  runs,
  empty,
  loadingRows,
  now,
  onOpenRoute
}: {
  workspaceId: string;
  runs: WorkflowRunList;
  /** What stands in the list's place while the Workflow has no run. */
  empty: string;
  /** How many rows the list is expected to have, for its placeholder. */
  loadingRows: number;
  now: Date;
  onOpenRoute: OpenRoute;
}) {
  const { locale, t } = useTranslation();
  const rows = runs.rows;
  // The runs whose folded stretch the reader opened.
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3">
      {runs.failed ? (
        <LoadError onRetry={runs.retry}>{t("workflows.runs.listFailed")}</LoadError>
      ) : null}
      {rows === undefined ? (
        runs.failed ? null : (
          <SkeletonList rows={loadingRows} />
        )
      ) : rows.length === 0 ? (
        <p className="text-body text-muted-foreground">{empty}</p>
      ) : (
        <List aria-label={t("workflows.sectionRuns")}>
          {foldEmptyRuns(rows).map((entry) => {
            if (entry.kind === "run") {
              return (
                <RunRow
                  key={entry.run.id}
                  run={entry.run}
                  workspaceId={workspaceId}
                  now={now}
                  onOpenRoute={onOpenRoute}
                />
              );
            }
            const newest = entry.runs[0];
            const oldest = entry.runs[entry.runs.length - 1];
            // A stretch grows at either end as runs arrive or older pages load: it stays open
            // while any run it held was open.
            const open = entry.runs.some((run) => unfolded.has(run.id));
            const label = t("workflows.runs.emptyGroup", {
              count: new Intl.NumberFormat(locale).format(entry.runs.length)
            });
            return (
              <ListRow
                key={`empty:${oldest?.id ?? ""}`}
                data-empty-runs={entry.runs.length}
                expandable
                expanded={open}
                onExpandedChange={(next) =>
                  setUnfolded((current) => {
                    const changed = new Set(current);
                    for (const run of entry.runs) {
                      if (next) changed.add(run.id);
                      else changed.delete(run.id);
                    }
                    return changed;
                  })
                }
                title={label}
                description={
                  newest === undefined || oldest === undefined
                    ? undefined
                    : t("workflows.runs.emptyGroupLine", {
                        from: formatMomentShort(oldest.createdAt, locale),
                        to: formatMomentShort(newest.createdAt, locale)
                      })
                }
                chips={<RunStateBadge status="done" />}
              >
                <List aria-label={label}>
                  {entry.runs.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      workspaceId={workspaceId}
                      now={now}
                      onOpenRoute={onOpenRoute}
                    />
                  ))}
                </List>
              </ListRow>
            );
          })}
        </List>
      )}
      {runs.hasMore ? (
        <Button
          variant="outline"
          className="justify-self-start"
          loading={runs.loadingMore}
          onClick={runs.loadMore}
        >
          {t("workflows.showMore")}
        </Button>
      ) : null}
    </div>
  );
}

/**
 * One run as a row: when it started, who started it, how long it took and how it ended, and
 * for a failed run why. The row opens the run.
 */
function RunRow({
  run,
  workspaceId,
  now,
  onOpenRoute
}: {
  run: WorkflowRunView;
  workspaceId: string;
  now: Date;
  onOpenRoute: OpenRoute;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const duration = durationText(run, now, translation);
  const startedLine = [runKeyText(run, t), startedByText(run, t), duration]
    .filter((part) => part !== undefined)
    .join(" · ");
  const failedBecause = runFailedBecause(run, t);
  return (
    <ListRow
      // The state stands beside the time, so the time is the short one and is never cut.
      title={formatMomentShort(run.createdAt, locale)}
      description={
        failedBecause === undefined ? (
          startedLine
        ) : (
          // The row cuts this whole line, so its two parts say how each breaks: the
          // reason stays one line, who and how long wraps where the window is narrow.
          <>
            <span data-run-reason="" className="block truncate" title={failedBecause}>
              {failedBecause}
            </span>
            <span className="block whitespace-normal sm:truncate">{startedLine}</span>
          </>
        )
      }
      descriptionWraps={failedBecause === undefined}
      chips={
        <>
          {run.test ? (
            <Badge tone="info" size="sm" data-test-run="">
              {t("workflows.run.testBadge")}
            </Badge>
          ) : null}
          <RunStateBadge status={run.status} />
        </>
      }
      link={
        <a
          {...routeLink(
            {
              kind: "workflow-run",
              collaborationWorkspaceId: workspaceId,
              workflow: run.workflowId,
              run: run.id
            },
            onOpenRoute
          )}
        />
      }
    />
  );
}
