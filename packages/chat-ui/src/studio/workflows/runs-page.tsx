import { useDeferredValue, useMemo, useState } from "react";
import { Input, LoadError } from "@work-shape/catalyst-ui";
import { useTranslation } from "../../shared/i18n";
import { RunsList } from "./runs-list";
import { useStartRun } from "./start-run";
import {
  useRunsAvailable,
  useWorkflow,
  useWorkflowRuns,
  type WorkflowReadProblem,
  type WorkflowRunList
} from "./workflow-data";
import { WorkflowHead } from "./workflow-head";
import { runsReadable, startOffered } from "./workflow-model";
import type { WorkflowView } from "./workflow-views";
import { WorkflowsFrame, type OpenRoute } from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

/** How many runs one read of the list asks for. */
const RUNS_PAGE_SIZE = 25;

/** Every run of one Workflow, newest first: the tab "Runs" of the Workflow. */
export function WorkflowRunsPage({ workflow }: { workflow: string }) {
  const host = useWorkflowsHost();
  const workspaceId = host?.workspace?.id;
  const read = useWorkflow(workspaceId, workflow);
  const [keyFilter, setKeyFilter] = useState("");
  // The list is asked again once typing pauses, not on every key.
  const keyPrefix = useDeferredValue(keyFilter.trim());
  // The runs are asked for once the Workflow says its reader may read them: a reader who may
  // only write, publish or start it is told so, not refused by the list.
  const readsRuns = host !== undefined && runsReadable(host.rights, read.workflow);
  const runs = useWorkflowRuns(
    workflow,
    RUNS_PAGE_SIZE,
    keyPrefix === "" ? undefined : keyPrefix,
    read.workflow !== undefined && readsRuns
  );
  const runsAvailable = useRunsAvailable();
  const start = useStartRun({
    workflow,
    name: read.workflow?.name,
    form: read.workflow?.startForm
  });
  const rows = runs.rows;
  // The durations of runs that are going are counted from when the list last arrived.
  const now = useMemo(() => new Date(), [rows]);
  if (!host || workspaceId === undefined) {
    return null;
  }
  return (
    <>
      <WorkflowRunsPageView
        workspaceId={workspaceId}
        workflowId={workflow}
        workflow={read.workflow}
        definition={
          read.problem === undefined ? undefined : { problem: read.problem, retry: read.retry }
        }
        readsRuns={read.workflow === undefined || readsRuns}
        runs={runs}
        runsAvailable={runsAvailable}
        keyFilter={{ value: keyFilter, onChange: setKeyFilter }}
        now={now}
        onStart={start.open}
        onOpenRoute={host.showRoute}
      />
      {start.dialog}
    </>
  );
}

/** The page of a Workflow's runs for a given list. */
export function WorkflowRunsPageView({
  workspaceId,
  workflowId,
  workflow,
  definition,
  readsRuns = true,
  runs,
  runsAvailable,
  keyFilter,
  now,
  onStart,
  onOpenRoute
}: {
  workspaceId: string;
  workflowId: string;
  /** The Workflow, once its record arrived. */
  workflow: WorkflowView | undefined;
  /** Why the Workflow's record did not arrive: the page says so in place of the runs. */
  definition?: { problem: WorkflowReadProblem; retry(): void };
  /** The reader may read the Workflow's runs. Starting it is apart. */
  readsRuns?: boolean;
  runs: WorkflowRunList;
  /** The instance runs Workflows. Without that there is nothing to list. */
  runsAvailable: boolean;
  /**
   * The start of the run keys the list shows. The field is offered once a run has a key or a
   * filter is set: a Workflow started without keys has nothing to filter by.
   */
  keyFilter?: { value: string; onChange(value: string): void };
  now: Date;
  onStart(): void;
  onOpenRoute: OpenRoute;
}) {
  const { t } = useTranslation();
  const canStart = runsAvailable && workflow !== undefined && startOffered(workflow);
  // The runs are listed while the instance runs Workflows and this reader may read them.
  const listed = runsAvailable && definition === undefined && readsRuns;
  const filtering = keyFilter !== undefined && keyFilter.value.trim() !== "";
  const offerKeyFilter =
    keyFilter !== undefined &&
    (filtering || (runs.rows ?? []).some((run) => run.runKey !== undefined));
  const title =
    workflow === undefined
      ? t("workflows.sectionRuns")
      : t("workflows.runs.title", { name: workflow.name });
  return (
    <WorkflowsFrame label={title} testId="workflow-runs-page" fill>
      <WorkflowHead
        workspaceId={workspaceId}
        workflowId={workflowId}
        workflow={workflow}
        tab="runs"
        runsShown={runsAvailable && readsRuns}
        canStart={canStart}
        onStart={onStart}
        onOpenRoute={onOpenRoute}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-(--layout-gutter) pt-5 pb-(--layout-page-end)">
        {listed && offerKeyFilter ? (
          <Input
            type="search"
            size="sm"
            className="mb-3 max-w-sm"
            aria-label={t("workflows.runs.keyFilter")}
            placeholder={t("workflows.runs.keyFilterPlaceholder")}
            value={keyFilter.value}
            onChange={(event) => keyFilter.onChange(event.target.value)}
          />
        ) : null}
        {!runsAvailable ? (
          <p className="text-body text-muted-foreground">{t("workflows.runsUnavailable")}</p>
        ) : definition?.problem === "failed" ? (
          <LoadError onRetry={definition.retry}>{t("workflows.failed")}</LoadError>
        ) : definition !== undefined ? (
          <p className="text-body text-muted-foreground">
            {t(definition.problem === "missing" ? "workflows.missing" : "workflows.unavailable")}
          </p>
        ) : !readsRuns ? (
          <p className="text-body text-muted-foreground">{t("workflows.runs.unreadable")}</p>
        ) : (
          <RunsList
            workspaceId={workspaceId}
            runs={runs}
            empty={
              filtering
                ? t("workflows.runs.noKeyMatch", { prefix: keyFilter.value.trim() })
                : t(canStart ? "workflows.noRuns" : "workflows.noRunsPlain")
            }
            loadingRows={6}
            now={now}
            onOpenRoute={onOpenRoute}
          />
        )}
      </div>
    </WorkflowsFrame>
  );
}
