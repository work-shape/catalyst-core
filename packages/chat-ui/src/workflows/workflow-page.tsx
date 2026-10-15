import { Banner, Breadcrumb } from "@vivd-catalyst/ui";
import { useTranslation, type TranslationKey } from "../i18n";
import { workspaceRoutePath, type WorkspaceRoute } from "../routes";
import { useStartRun } from "./start-run";
import { WorkflowCanvas } from "./workflow-canvas";
import {
  useRunsAvailable,
  useWorkflow,
  useWorkflowNames,
  type WorkflowRead,
  type WorkflowReadProblem
} from "./workflow-data";
import {
  EditRefusedBanner,
  WorkflowDraftBar,
  useEditWithAgent,
  useWorkflowDraft,
  type WorkflowDraftBarState,
  type WorkflowEdit
} from "./workflow-draft";
import { WorkflowHead } from "./workflow-head";
import { useTestRun } from "./test-run";
import { startOffered } from "./workflow-model";
import type { WorkflowStartIssue, WorkflowStepView } from "./workflow-views";
import { LoadError, WorkflowsFrame, type OpenRoute } from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

const PROBLEM_SENTENCES: Readonly<Record<WorkflowReadProblem, TranslationKey>> = {
  missing: "workflows.missing",
  unavailable: "workflows.unavailable",
  failed: "workflows.failed"
};

/** A Workflow on the way to the one that is shown: the one a step of it started from. */
export interface WorkflowTrailEntry {
  id: string;
  /** Its name, once its record arrived. */
  name: string | undefined;
  route: WorkspaceRoute;
}

/**
 * One Workflow on its canvas, with the start by hand. `opened` is the way from the Workflow
 * of the address into the ones its steps start; the last of them is the one shown, and the
 * head, the start and the runs are that Workflow's.
 */
export function WorkflowPage({ workflow, opened }: { workflow: string; opened?: string }) {
  const host = useWorkflowsHost();
  const workspaceId = host?.workspace?.id;
  const chain = (opened ?? "").split("/").filter((id) => id !== "");
  const shownId = chain.at(-1) ?? workflow;
  const before = chain.length === 0 ? [] : [workflow, ...chain.slice(0, -1)];
  const read = useWorkflow(workspaceId, shownId);
  const names = useWorkflowNames(workspaceId, before);
  const runsAvailable = useRunsAvailable();
  const start = useStartRun({
    workflow: shownId,
    name: read.workflow?.name,
    form: read.workflow?.startForm
  });
  const edit = useEditWithAgent(shownId, read.workflow);
  const draft = useWorkflowDraft(shownId, read.workflow);
  const test = useTestRun(shownId, read.workflow);

  if (!host || workspaceId === undefined) {
    return null;
  }
  const routeAt = (depth: number): WorkspaceRoute => ({
    kind: "workflow",
    collaborationWorkspaceId: workspaceId,
    workflow,
    ...(depth === 0 ? {} : { opened: chain.slice(0, depth).join("/") })
  });
  return (
    <>
      <WorkflowPageView
        workspaceId={workspaceId}
        workflowId={shownId}
        read={read}
        trail={before.map((id, depth) => ({ id, name: names[depth], route: routeAt(depth) }))}
        runsAvailable={runsAvailable}
        edit={edit}
        draft={
          draft.bar === undefined || test === undefined
            ? draft.bar
            : { ...draft.bar, onTest: test.open }
        }
        onOpenChild={(step) => {
          if (step.workflow !== undefined) {
            // An address of its own: the browser's way back leads one level up.
            host.showRoute({
              kind: "workflow",
              collaborationWorkspaceId: workspaceId,
              workflow,
              opened: [...chain, step.workflow].join("/")
            });
          }
        }}
        onOpenRoute={host.showRoute}
        onStart={start.open}
      />
      {start.dialog}
      {draft.dialog}
      {test?.dialog}
    </>
  );
}

/** The page of a Workflow for a given record and a given reader. */
export function WorkflowPageView({
  workspaceId,
  workflowId,
  read,
  trail = [],
  runsAvailable,
  edit,
  draft,
  onOpenChild,
  onOpenRoute,
  onStart
}: {
  workspaceId: string;
  /** The Workflow that is shown. */
  workflowId: string;
  read: Pick<WorkflowRead, "workflow" | "problem" | "retry">;
  /** The Workflows the reader came through, outermost first. Empty on a Workflow's own page. */
  trail?: readonly WorkflowTrailEntry[];
  /** The instance runs Workflows: there is a start and a list of runs. */
  runsAvailable: boolean;
  /** "Edit with the agent", for a reader who may write the Workflow. */
  edit?: WorkflowEdit;
  /** The bar of the draft, where the draft is not the published revision. */
  draft?: WorkflowDraftBarState;
  onOpenChild(step: WorkflowStepView): void;
  onOpenRoute: OpenRoute;
  onStart(): void;
}) {
  const { t } = useTranslation();
  const workflow = read.workflow;
  const canStart = runsAvailable && workflow !== undefined && startOffered(workflow);
  // A start the instance would refuse stands switched off, beside the reasons below.
  const startOff =
    runsAvailable &&
    workflow !== undefined &&
    workflow.refusedFor.length > 0 &&
    startOffered({ ...workflow, refusedFor: [] });
  const shown = read;
  return (
    <WorkflowsFrame label={workflow?.name ?? t("workflows.title")} testId="workflow-page" fill>
      <WorkflowHead
        workspaceId={workspaceId}
        workflowId={workflowId}
        workflow={workflow}
        tab="workflow"
        runsAvailable={runsAvailable}
        canStart={canStart}
        startOff={startOff}
        edit={edit}
        onStart={onStart}
        onOpenRoute={onOpenRoute}
      />
      {edit === undefined ? null : <EditRefusedBanner edit={edit} />}
      {draft === undefined ? null : <WorkflowDraftBar {...draft} />}
      {trail.length === 0 ? null : (
        <div className="shrink-0 border-b px-(--layout-gutter) py-2">
          <Breadcrumb
            label={t("workflows.canvas.way")}
            items={[
              ...trail.map((entry, depth) => ({
                id: `${String(depth)}:${entry.id}`,
                label: entry.name ?? t("workflows.title"),
                href: workspaceRoutePath(entry.route),
                onSelect: () => onOpenRoute(entry.route)
              })),
              { id: `shown:${workflowId}`, label: workflow?.name ?? t("workflows.title") }
            ]}
          />
        </div>
      )}
      {workflow === undefined || workflow.refusedFor.length === 0 ? null : (
        <div className="shrink-0 border-b px-(--layout-gutter) py-2">
          <NotRunnableBanner issues={workflow.refusedFor} />
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {shown.problem === "failed" ? (
          <div className="p-(--layout-gutter)">
            <LoadError onRetry={shown.retry}>{t(PROBLEM_SENTENCES.failed)}</LoadError>
          </div>
        ) : shown.problem ? (
          <p className="p-(--layout-gutter) text-body text-muted-foreground">
            {t(PROBLEM_SENTENCES[shown.problem])}
          </p>
        ) : (
          <WorkflowCanvas
            // Another Workflow is another graph: it opens fitted, with no step chosen.
            key={workflowId}
            workflow={shown.workflow}
            onOpenChild={onOpenChild}
          />
        )}
      </div>
    </WorkflowsFrame>
  );
}

/**
 * Says why this Workflow cannot start now. Account reasons use the reader's language and
 * the account's display label; other issues keep the instance's diagnostic sentence.
 */
function NotRunnableBanner({ issues }: { issues: readonly WorkflowStartIssue[] }) {
  const { t } = useTranslation();
  // What the engine does not run yet is no fault of the Workflow: the head line says which.
  const notBuilt = issues.every((issue) => issue.code === "not_supported_yet");
  return (
    <Banner tone="warning" layout="inline" data-not-runnable="">
      <p>{t(notBuilt ? "workflows.notRunnable.title" : "workflows.notRunnable.refused")}</p>
      <ul className="list-disc pl-5">
        {issues.map((issue, position) => (
          <li key={`${String(position)}:${issue.code}`}>
            {issue.code === "principal_inactive"
              ? issue.principalDisplayLabel === undefined
                ? t("workflows.notRunnable.accountUnavailable")
                : t("workflows.notRunnable.accountDisabled", { name: issue.principalDisplayLabel })
              : issue.message}
          </li>
        ))}
      </ul>
    </Banner>
  );
}
