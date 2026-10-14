import { Badge, Button, List, ListRow, SkeletonList } from "@vivd-catalyst/ui";
import { formatMomentShort } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import type { WorkflowRunList } from "./workflow-data";
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

/**
 * Runs of one Workflow, newest first: when each started, who started it, how long it took and
 * how it ended. Each row opens its run. A row is two lines, at every width.
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
  const translation = useTranslation();
  const { locale, t } = translation;
  const rows = runs.rows;
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
          {rows.map((run) => {
            const duration = durationText(run, now, translation);
            return (
              <ListRow
                key={run.id}
                // The state stands beside the time, so the time is the short one and is never cut.
                title={formatMomentShort(run.createdAt, locale)}
                description={[startedByText(run, t), duration]
                  .filter((part) => part !== undefined)
                  .join(" · ")}
                descriptionWraps
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
