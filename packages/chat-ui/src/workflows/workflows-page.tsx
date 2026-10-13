import { Workflow } from "lucide-react";
import { useMemo } from "react";
import {
  Badge,
  Button,
  EmptyState,
  List,
  ListRow,
  Page,
  PageHeader,
  SkeletonList
} from "@vivd-catalyst/ui";
import { formatUpdated } from "../build-area/build-model";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { useWorkflowList, type WorkflowList } from "./workflow-data";
import {
  LoadError,
  RunStateBadge,
  WorkflowsFrame,
  routeLink,
  type OpenRoute
} from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

/** The Workflows of the open workspace, as far as the reader may read them. */
export function WorkflowsPage() {
  const host = useWorkflowsHost();
  const list = useWorkflowList(host?.workspace?.id);
  const rows = list.rows;
  // The ages are counted from when the list last arrived.
  const now = useMemo(() => new Date(), [rows]);
  if (!host?.workspace) {
    return null;
  }
  return (
    <WorkflowsPageView
      workspaceId={host.workspace.id}
      list={list}
      now={now}
      onOpenRoute={host.showRoute}
    />
  );
}

/** The list of Workflows as it stands for a given list. */
export function WorkflowsPageView({
  workspaceId,
  list,
  now,
  onOpenRoute
}: {
  workspaceId: string;
  list: WorkflowList;
  now: Date;
  onOpenRoute: OpenRoute;
}) {
  const { locale, t } = useTranslation();
  const rows = list.rows;
  return (
    <WorkflowsFrame label={t("workflows.title")} testId="workflows-area">
      <Page>
        <PageHeader title={t("workflows.title")} description={t("workflows.description")} />
        {list.failed ? (
          <div className="mb-4">
            <LoadError onRetry={list.retry}>{t("workflows.listFailed")}</LoadError>
          </div>
        ) : null}
        {rows === undefined ? (
          list.failed ? null : (
            <SkeletonList rows={4} />
          )
        ) : rows.length === 0 ? (
          <EmptyState icon={<Workflow aria-hidden="true" />}>
            {t("workflows.emptyReadOnly")}
          </EmptyState>
        ) : (
          <div className="grid min-w-0 grid-cols-1 gap-3">
            <List aria-label={t("workflows.title")}>
              {rows.map((workflow) => {
                const moment = workflow.lastRun?.startedAt ?? workflow.updatedAt;
                return (
                  <ListRow
                    key={workflow.id}
                    leading={
                      <Workflow aria-hidden="true" className="size-4 text-muted-foreground" />
                    }
                    title={workflow.name}
                    description={workflow.description}
                    descriptionWraps
                    // How the latest run stands, and when it began. A list that names no run
                    // says when the Workflow last changed, where it knows that.
                    chips={
                      <>
                        {workflow.refusedFor.length > 0 ? (
                          <Badge tone="warning" size="sm">
                            {t("workflows.notRunnable.badge")}
                          </Badge>
                        ) : null}
                        {workflow.lastRun === undefined ? null : (
                          <RunStateBadge status={workflow.lastRun.status} />
                        )}
                      </>
                    }
                    time={
                      moment === undefined ? undefined : (
                        <time
                          className="hidden sm:inline"
                          dateTime={moment}
                          title={formatDateTime(moment, locale)}
                        >
                          {formatUpdated(moment, now, locale)}
                        </time>
                      )
                    }
                    // A Workflow without a published revision has nothing a reader could open.
                    link={
                      workflow.published ? (
                        <a
                          {...routeLink(
                            {
                              kind: "workflow",
                              collaborationWorkspaceId: workspaceId,
                              workflow: workflow.id
                            },
                            onOpenRoute
                          )}
                        />
                      ) : undefined
                    }
                  />
                );
              })}
            </List>
            {list.hasMore ? (
              <Button
                variant="outline"
                className="justify-self-start"
                loading={list.loadingMore}
                onClick={list.loadMore}
              >
                {t("workflows.showMore")}
              </Button>
            ) : null}
          </div>
        )}
      </Page>
    </WorkflowsFrame>
  );
}
