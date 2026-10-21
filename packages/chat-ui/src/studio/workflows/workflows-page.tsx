import { CalendarClock, Play, Plus, ReceiptText, Workflow } from "lucide-react";
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
  Chip,
  EmptyState,
  FilterBar,
  LoadError,
  LoadMore,
  Page,
  PageHeader,
  SkeletonList
} from "@work-shape/catalyst-ui";
import { formatUpdated } from "../build-area/build-model";
import { formatDateTime } from "../../shared/locale-format";
import { useTranslation } from "../../shared/i18n";
import { BuildWithAgentEmptyState, type BuildWithAgentCopy } from "../build-with-agent-empty";
import { RouteLink } from "../route-link";
import { useStartRun } from "./start-run";
import { useRunsAvailable, useWorkflowList, type WorkflowList } from "./workflow-data";
import { doneWithFailedRuns, listedToReader, runsReadable, startOffered } from "./workflow-model";
import type { WorkflowListItem } from "./workflow-views";
import { RunStateBadge, WorkflowsFrame, type OpenRoute } from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

/** Two Workflows a business builds: one on a schedule, one that acts on what it finds. */
const WORKFLOW_BUILD: BuildWithAgentCopy = {
  text: "workflows.empty",
  action: "workflows.buildWithAgent",
  prompt: "workflows.newPrompt",
  examples: [
    {
      icon: <CalendarClock aria-hidden="true" className="size-5 text-muted-foreground" />,
      title: "workflows.exampleSummaryTitle",
      hint: "workflows.exampleSummaryHint",
      prompt: "workflows.exampleSummaryPrompt"
    },
    {
      icon: <ReceiptText aria-hidden="true" className="size-5 text-muted-foreground" />,
      title: "workflows.exampleReminderTitle",
      hint: "workflows.exampleReminderHint",
      prompt: "workflows.exampleReminderPrompt"
    }
  ]
};

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
  const rights = host?.rights;
  const rows = useMemo(
    () =>
      rights === undefined
        ? undefined
        : list.rows?.filter((workflow) => listedToReader(workflow, rights)),
    [list.rows, rights]
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
        workspaceName={host.workspace.name}
        list={{ ...list, rows }}
        now={now}
        runsAvailable={runsAvailable}
        readsRuns={(workflow) => runsReadable(host.rights, workflow)}
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
  workspaceName,
  list,
  now,
  runsAvailable,
  readsRuns = () => true,
  onOpenRoute,
  onNew,
  onStart
}: {
  workspaceId: string;
  /** The open workspace's name: the chip of a Workflow it owns. */
  workspaceName?: string;
  list: WorkflowList;
  now: Date;
  /** The instance runs Workflows: a card offers a start where the reader may make one. */
  runsAvailable: boolean;
  /** The reader may read a Workflow's runs: its card leads to them. Starting it is apart. */
  readsRuns?(workflow: WorkflowListItem): boolean;
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
  // Process Workflows first; the data Workflows, which fill Knowledge Bases and Data Stores,
  // stand behind Data flows. The choice is offered only once there is a data Workflow.
  const [kind, setKind] = useState<WorkflowListItem["kind"]>("process");
  const dataCount = rows?.filter((workflow) => workflow.kind === "data").length ?? 0;
  const offerKinds = dataCount > 0 || kind === "data";
  const shown = rows?.filter((workflow) => workflow.kind === kind);
  // A page may come back empty with more to read: the list is empty only once read to its end.
  const listedNone = rows?.length === 0 && !list.hasMore;
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
          // The empty list offers the agent itself, so the head drops New once the list has
          // answered with none. While it loads, New stands: making one never waits for the list.
          primaryAction={listedNone ? undefined : newButton}
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
        ) : listedNone ? (
          <BuildWithAgentEmptyState
            icon={<Workflow aria-hidden="true" />}
            readerText="workflows.emptyReadOnly"
            copy={WORKFLOW_BUILD}
            {...(onNew ? { onBuild: onNew } : {})}
          />
        ) : (
          <div className="grid min-w-0 gap-4">
            {offerKinds ? (
              <FilterBar
                filters={
                  // One chip: on, the list shows the data Workflows; off again, the processes.
                  <Chip
                    pressed={kind === "data"}
                    onClick={() => setKind(kind === "data" ? "process" : "data")}
                  >
                    {t("workflows.kindData")}
                  </Chip>
                }
              />
            ) : null}
            {shown === undefined || shown.length === 0 ? (
              <EmptyState layout="inline">
                {t(kind === "data" ? "workflows.kindDataEmpty" : "workflows.kindProcessEmpty")}
              </EmptyState>
            ) : (
              <ul
                aria-label={t("workflows.title")}
                className="grid grid-cols-1 gap-4 @2xl:grid-cols-2"
              >
                {shown.map((workflow) => (
                  <li key={workflow.id} className="flex min-w-0">
                    <WorkflowCard
                      workflow={workflow}
                      workspaceId={workspaceId}
                      {...(workspaceName === undefined ? {} : { workspaceName })}
                      now={now}
                      canStart={runsAvailable && startOffered(workflow)}
                      runsShown={runsAvailable && readsRuns(workflow)}
                      onOpenRoute={onOpenRoute}
                      onStart={() => onStart(workflow)}
                    />
                  </li>
                ))}
              </ul>
            )}
            {list.hasMore ? (
              <LoadMore
                loading={list.loadingMore}
                onLoad={list.loadMore}
                label={t("workflows.showMore")}
                data-workflows-more=""
              />
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
  workspaceName,
  now,
  canStart,
  runsShown,
  onOpenRoute,
  onStart
}: {
  workflow: WorkflowListItem;
  workspaceId: string;
  workspaceName?: string;
  now: Date;
  canStart: boolean;
  /** The reader may read the Workflow's runs. */
  runsShown: boolean;
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
            <CardTitle id={titleId} clamp className="min-w-0">
              {workflow.name}
            </CardTitle>
            {/* Whose it is: the open workspace's, as Studio's lists say it (WS-OWN-1b). */}
            {workflow.ownerWorkspaceId === workspaceId ? (
              <Chip size="sm">{workspaceName ?? t("workflows.ownerWorkspace")}</Chip>
            ) : null}
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
              <RunStateBadge
                status={lastRun.status}
                withFailedEntries={doneWithFailedRuns(lastRun)}
              />
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
        <CardTarget label={t("workflows.openNamed", { name: workflow.name })} title={workflow.name}>
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
        {/* A Workflow that ran has runs to look through, for who may read them. */}
        {lastRun === undefined || !runsShown ? null : (
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
