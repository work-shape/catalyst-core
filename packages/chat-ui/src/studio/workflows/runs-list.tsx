import { useState } from "react";
import { Badge, Button, List, ListRow, LoadError, SkeletonList } from "@work-shape/catalyst-ui";
import { formatMomentShortZoned } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import type { WorkflowRunList } from "./workflow-data";
import { doneWithFailedRuns, runFailedBecause } from "./workflow-model";
import { runsListEntries, type RunGroup, type RunPart } from "./run-groups";
import { TestRunBadge } from "./test-run-badge";
import type { WorkflowRunView } from "./workflow-views";
import { RunStateBadge, durationText, routeLink, type OpenRoute } from "./workflows-frame";
import { personName } from "../../shared/person-name";

/** Who started a run, as a part of a sentence. */
export function startedByText(
  run: Pick<WorkflowRunView, "startedBy">,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  return run.startedBy === undefined
    ? t("workflows.run.startedBySchedule")
    : t("workflows.run.startedByPerson", { person: personName(run.startedBy.name, t) });
}

/**
 * The run key of a run, as a part of a sentence, with the number of its part where it continued
 * as new (`2026-10-17/2`). Nothing on a run started without one.
 */
export function runKeyText(
  run: Pick<WorkflowRunView, "runKey" | "continuation">,
  t: ReturnType<typeof useTranslation>["t"]
): string | undefined {
  if (run.runKey === undefined) {
    return undefined;
  }
  return run.continuation === undefined
    ? t("workflows.run.keyLine", { key: run.runKey })
    : t("workflows.run.keyPartLine", { key: run.runKey, number: String(run.continuation.number) });
}

/**
 * Runs of one Workflow, newest first: when each started, who started it, how long it took and
 * how it ended, and for a failed run why, in the sentence its page says. Each row opens its run.
 * A row is two lines at every width, and a failed run's three: why it failed is a line of its
 * own, cut where it does not fit and read whole on hover. Runs side by side that found nothing
 * to do fold into one row, "3 empty runs", which unfolds to each of them. The parts of a run
 * that continued as new are one row, the Lauf, which unfolds to each part.
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
  // The Läufe the reader opened, by the id of their first part, which stays while parts load.
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
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
          {runsListEntries(rows).map((entry) => {
            if (entry.kind === "group") {
              const root = entry.group.rootRunId;
              return (
                <RunGroupRow
                  key={`group:${root}`}
                  group={entry.group}
                  open={openGroups.has(root)}
                  onOpenChange={(next) =>
                    setOpenGroups((current) => {
                      const changed = new Set(current);
                      if (next) changed.add(root);
                      else changed.delete(root);
                      return changed;
                    })
                  }
                  workspaceId={workspaceId}
                  now={now}
                  onOpenRoute={onOpenRoute}
                />
              );
            }
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
                        from: formatMomentShortZoned(oldest.createdAt, locale),
                        to: formatMomentShortZoned(newest.createdAt, locale)
                      })
                }
                // Only runs without failed runs below them fold (`foldEmptyRuns`), so the
                // group's state is a plain done.
                chips={<RunStateBadge status="done" withFailedEntries={false} />}
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
  part,
  workspaceId,
  now,
  onOpenRoute
}: {
  run: WorkflowRunView;
  /** Where the row is one part of a Lauf: it is named by its number, and its time follows. */
  part?: RunPart;
  workspaceId: string;
  now: Date;
  onOpenRoute: OpenRoute;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const duration = durationText(run, now, translation);
  const moment = formatMomentShortZoned(run.createdAt, locale);
  const startedLine = (
    part === undefined ? [runKeyText(run, t), startedByText(run, t), duration] : [moment, duration]
  )
    .filter((piece) => piece !== undefined)
    .join(" · ");
  const failedBecause = runFailedBecause(run, t);
  return (
    <ListRow
      // The state stands beside the time, so the time is the short one and is never cut.
      title={part === undefined ? moment : partName(run, part.number, t)}
      data-run-part={part?.number}
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
          {part?.revisionChanged === true ? (
            <Badge tone="info" size="sm" data-revision-changed="">
              {t("workflows.runs.partRevision")}
            </Badge>
          ) : null}
          <TestRunBadge run={run} />
          <RunStateBadge status={run.status} withFailedEntries={doneWithFailedRuns(run)} />
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

/** The name of a part of a Lauf: its key with the part's number, or "Part 2" without a key. */
function partName(
  run: Pick<WorkflowRunView, "runKey">,
  number: number,
  t: ReturnType<typeof useTranslation>["t"]
): string {
  return run.runKey === undefined
    ? t("workflows.runs.part", { number: String(number) })
    : `${run.runKey}/${number}`;
}

/** How many parts a Lauf has, or which of them the list holds while earlier ones are to load. */
function partsText(group: RunGroup, t: ReturnType<typeof useTranslation>["t"], locale: string) {
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const first = group.parts[group.parts.length - 1]?.number ?? 1;
  const last = group.parts[0]?.number ?? 1;
  if (!group.partial) {
    return group.parts.length === 1
      ? t("workflows.runs.groupOnePart")
      : t("workflows.runs.groupParts", { count: format(group.parts.length) });
  }
  return first === last
    ? t("workflows.runs.groupOnePartLoaded", { number: format(first) })
    : t("workflows.runs.groupPartsLoaded", { from: format(first), to: format(last) });
}

/**
 * A run that continued as new, as one row: when its first loaded part started, its key, how
 * many parts and steps it took, who started it and how long it has run, and the state of its
 * newest part. Its labels and a change of the published version between parts stand below.
 * The row unfolds to each part, which opens that part's run with its own usage and steps.
 */
function RunGroupRow({
  group,
  open,
  onOpenChange,
  workspaceId,
  now,
  onOpenRoute
}: {
  group: RunGroup;
  open: boolean;
  onOpenChange(open: boolean): void;
  workspaceId: string;
  now: Date;
  onOpenRoute: OpenRoute;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const { earliest, latest } = group;
  // The Lauf goes on while its newest part handed on to a part the list does not hold yet.
  const duration = durationText(
    {
      ...(earliest.startedAt === undefined ? {} : { startedAt: earliest.startedAt }),
      ...(latest.status === "continued" || latest.finishedAt === undefined
        ? {}
        : { finishedAt: latest.finishedAt })
    },
    now,
    translation
  );
  const steps =
    group.stepRuns === undefined
      ? undefined
      : t(group.partial ? "workflows.runs.groupStepsLoaded" : "workflows.runs.groupSteps", {
          count: new Intl.NumberFormat(locale).format(group.stepRuns)
        });
  const keyText =
    latest.runKey === undefined ? undefined : t("workflows.run.keyLine", { key: latest.runKey });
  const startedLine = [
    keyText,
    partsText(group, t, locale),
    steps,
    startedByText(earliest, t),
    duration
  ]
    .filter((piece) => piece !== undefined)
    .join(" · ");
  const labels = Object.entries(latest.labels ?? {})
    .map(([name, value]) => `${name}: ${value}`)
    .join(" · ");
  const failedBecause = runFailedBecause(latest, t);
  const moment = formatMomentShortZoned(earliest.createdAt, locale);
  const label = t("workflows.runs.group", { date: moment });
  return (
    <ListRow
      data-run-group={group.rootRunId}
      data-run-parts={group.parts.length}
      expandable
      expanded={open}
      onExpandedChange={onOpenChange}
      title={moment}
      description={
        <>
          {failedBecause === undefined ? null : (
            <span data-run-reason="" className="block truncate" title={failedBecause}>
              {failedBecause}
            </span>
          )}
          <span className="block whitespace-normal sm:truncate">{startedLine}</span>
          {labels === "" ? null : (
            <span data-run-labels="" className="block truncate" title={labels}>
              {labels}
            </span>
          )}
          {group.revisionChanged ? (
            <span data-run-revision="" className="block truncate">
              {t("workflows.runs.groupRevision")}
            </span>
          ) : null}
        </>
      }
      chips={
        <>
          <TestRunBadge run={latest} />
          <RunStateBadge
            status={latest.status}
            stopping={latest.stopping}
            withFailedEntries={doneWithFailedRuns(latest)}
          />
        </>
      }
    >
      <List aria-label={label}>
        {group.parts.map((part) => (
          <RunRow
            key={part.run.id}
            run={part.run}
            part={part}
            workspaceId={workspaceId}
            now={now}
            onOpenRoute={onOpenRoute}
          />
        ))}
      </List>
    </ListRow>
  );
}
