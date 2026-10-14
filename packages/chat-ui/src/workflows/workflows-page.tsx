import { Play, Plus, Workflow } from "lucide-react";
import { useId, useMemo, useState } from "react";
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardReachable,
  CardTarget,
  CardTitle,
  EmptyState,
  Page,
  PageHeader,
  SkeletonList
} from "@vivd-catalyst/ui";
import { formatUpdated } from "../build-area/build-model";
import { formatDateTime } from "../control-plane/locale-format";
import { useTranslation } from "../i18n";
import { RouteLink } from "../route-link";
import { useStartRun } from "./start-run";
import { useRunsAvailable, useWorkflowList, type WorkflowList } from "./workflow-data";
import { listedToReader, startOffered } from "./workflow-model";
import type { WorkflowListItem } from "./workflow-views";
import { LoadError, RunStateBadge, WorkflowsFrame, type OpenRoute } from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

/** The Workflows of the open workspace, as far as the reader may read them. */
export function WorkflowsPage() {
  const host = useWorkflowsHost();
  const list = useWorkflowList(host?.workspace?.id);
  const runsAvailable = useRunsAvailable();
  // The Workflow whose start is asked for from its card.
  const [starting, setStarting] = useState<WorkflowListItem>();
  const start = useStartRun({
    workflow: starting?.id ?? "",
    name: starting?.name,
    form: starting?.startForm
  });
  const write = host?.rights.write === true;
  const rows = useMemo(
    () => list.rows?.filter((workflow) => listedToReader(workflow, { write })),
    [list.rows, write]
  );
  // The ages are counted from when the list last arrived.
  const now = useMemo(() => new Date(), [rows]);
  if (!host?.workspace) {
    return null;
  }
  return (
    <>
      <WorkflowsPageView
        workspaceId={host.workspace.id}
        list={{ ...list, rows }}
        now={now}
        runsAvailable={runsAvailable}
        onOpenRoute={host.showRoute}
        {...(host.startNew ? { onNew: host.startNew } : {})}
        onStart={(workflow) => {
          setStarting(workflow);
          start.open();
        }}
      />
      {start.dialog}
    </>
  );
}

/** The list of Workflows as it stands for a given list. */
export function WorkflowsPageView({
  workspaceId,
  list,
  now,
  runsAvailable,
  onOpenRoute,
  onNew,
  onStart
}: {
  workspaceId: string;
  list: WorkflowList;
  now: Date;
  /** The instance runs Workflows: a card offers a start where the reader may make one. */
  runsAvailable: boolean;
  onOpenRoute: OpenRoute;
  /**
   * "New workflow": the dock opens with a conversation whose first save creates the Workflow,
   * this text in its composer. Absent where nobody here builds one with an agent.
   */
  onNew?(prompt: string): void;
  onStart(workflow: WorkflowListItem): void;
}) {
  const { t } = useTranslation();
  const rows = list.rows;
  const newButton = onNew ? (
    <Button onClick={() => onNew(t("workflows.newPrompt"))}>
      <Plus aria-hidden="true" />
      {t("workflows.new")}
    </Button>
  ) : undefined;
  return (
    <WorkflowsFrame label={t("workflows.title")} testId="workflows-area">
      <Page>
        <PageHeader
          title={t("workflows.title")}
          description={t("workflows.description")}
          primaryAction={newButton}
        />
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
          <EmptyState icon={<Workflow aria-hidden="true" />} action={newButton}>
            {t(newButton ? "workflows.empty" : "workflows.emptyReadOnly")}
          </EmptyState>
        ) : (
          <div className="grid min-w-0 gap-4">
            <ul
              aria-label={t("workflows.title")}
              className="grid grid-cols-1 gap-4 @2xl:grid-cols-2"
            >
              {rows.map((workflow) => (
                <li key={workflow.id} className="flex min-w-0">
                  <WorkflowCard
                    workflow={workflow}
                    workspaceId={workspaceId}
                    now={now}
                    canStart={runsAvailable && startOffered(workflow)}
                    onOpenRoute={onOpenRoute}
                    onStart={() => onStart(workflow)}
                  />
                </li>
              ))}
            </ul>
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

/**
 * Whether the card warns that the Workflow cannot be started. One that has no start by hand
 * runs on its schedule or for another Workflow: that is how it is built, not a fault, so a
 * refusal for that alone is no warning here. Its page says it where a start is offered.
 */
function cannotStart(workflow: WorkflowListItem): boolean {
  return workflow.refusedFor.some((issue) => issue.code !== "no_manual_trigger");
}

/**
 * One Workflow, as the Agents and Apps pages show theirs: what it is called and what it does,
 * how its latest run ended and when, and the ways into it. The state of the run stands beside
 * the words "Last run", so it is not read as the state of the Workflow. The whole card of a
 * published Workflow opens it.
 */
function WorkflowCard({
  workflow,
  workspaceId,
  now,
  canStart,
  onOpenRoute,
  onStart
}: {
  workflow: WorkflowListItem;
  workspaceId: string;
  now: Date;
  canStart: boolean;
  onOpenRoute: OpenRoute;
  onStart(): void;
}) {
  const { locale, t } = useTranslation();
  const titleId = useId();
  const { lastRun } = workflow;
  const address = { collaborationWorkspaceId: workspaceId, workflow: workflow.id };
  return (
    <Card padding="md" className="flex w-full min-w-0 flex-col">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <Avatar kind="workflow" name={workflow.name} />
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <CardTitle id={titleId} className="min-w-0 break-words">
              {workflow.name}
            </CardTitle>
            {workflow.published ? null : (
              <Badge tone="neutral" size="sm">
                {t("workflows.draft.unpublished")}
              </Badge>
            )}
            {cannotStart(workflow) ? (
              <Badge tone="warning" size="sm">
                {t("workflows.notRunnable.badge")}
              </Badge>
            ) : null}
          </div>
        </div>
        {workflow.description ? (
          <p className="text-body text-muted-foreground">{workflow.description}</p>
        ) : null}
      </CardHeader>
      <CardContent>
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
          {lastRun === undefined ? (
            t("workflows.noRunsPlain")
          ) : (
            <>
              <span>{t("workflows.lastRun")}</span>
              <RunStateBadge status={lastRun.status} />
              {/* The full date stays reachable as a tooltip above the card's target. */}
              {lastRun.startedAt === undefined ? null : (
                <CardReachable>
                  <time
                    dateTime={lastRun.startedAt}
                    title={formatDateTime(lastRun.startedAt, locale)}
                  >
                    {formatUpdated(lastRun.startedAt, now, locale)}
                  </time>
                </CardReachable>
              )}
            </>
          )}
        </p>
      </CardContent>
      {/* A draft opens on its page, where it is published; it has nothing to start yet. */}
      <CardFooter>
        <CardTarget label={t("workflows.openNamed", { name: workflow.name })}>
          <RouteLink
            route={{ kind: "workflow", ...address }}
            variant="primary"
            onOpen={onOpenRoute}
          >
            {t("workflows.open")}
          </RouteLink>
        </CardTarget>
        {canStart ? (
          <Button variant="outline" aria-describedby={titleId} onClick={onStart}>
            <Play aria-hidden="true" />
            {t("workflows.startNow")}
          </Button>
        ) : null}
        {/* A Workflow that ran has runs to look through. */}
        {lastRun === undefined ? null : (
          <div className="ml-auto flex items-center gap-1">
            <RouteLink
              route={{ kind: "workflow-runs", ...address }}
              variant="link"
              describedBy={titleId}
              onOpen={onOpenRoute}
            >
              {t("workflows.sectionRuns")}
            </RouteLink>
          </div>
        )}
      </CardFooter>
    </Card>
  );
}
