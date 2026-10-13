import { RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Banner,
  Breadcrumb,
  Button,
  Dialog,
  InlineError,
  PageHeader,
  TextLink
} from "@vivd-catalyst/ui";
import { instanceSentence } from "../build-area/build-refusals";
import { formatMoment, formatTime } from "../control-plane/locale-format";
import { useTranslation, type TranslationKey } from "../i18n";
import { workspaceRoutePath } from "../routes";
import type { WorkspaceRoute } from "../workspace/workspace-route";
import { FailureBanner } from "./failure-banner";
import { startedByText } from "./runs-list";
import { useStartRun } from "./start-run";
import { WorkflowCanvas } from "./workflow-canvas";
import {
  useWorkflow,
  useWorkflowRun,
  useWorkflowWrites,
  workflowWriteRefusal,
  type WorkflowReadProblem,
  type WorkflowRunRead
} from "./workflow-data";
import type { WorkflowStepRunView, WorkflowStepView, WorkflowView } from "./workflow-views";
import { cancelOffered, startOffered } from "./workflow-model";
import {
  BackLink,
  LoadError,
  RunStateBadge,
  TitlePlaceholder,
  WorkflowsFrame,
  durationText,
  routeLink,
  type OpenRoute
} from "./workflows-frame";
import { useWorkflowsHost } from "./workflows-host";

/** How often the times on the page of a run that is going are counted again. */
const CLOCK_MS = 1_000;

const PROBLEM_SENTENCES: Readonly<Record<WorkflowReadProblem, TranslationKey>> = {
  missing: "workflows.run.missing",
  unavailable: "workflows.run.unavailable",
  failed: "workflows.run.failedToLoad"
};

/** The time, counted again every second while `ticking`. */
function useNow(ticking: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!ticking) {
      return undefined;
    }
    const interval = window.setInterval(() => setNow(new Date()), CLOCK_MS);
    return () => window.clearInterval(interval);
  }, [ticking]);
  return now;
}

/** One run of a Workflow on the canvas, followed while it is going, with the way to cancel it. */
export function WorkflowRunPage({ workflow, run: runId }: { workflow: string; run: string }) {
  const { t } = useTranslation();
  const host = useWorkflowsHost();
  const workspaceId = host?.workspace?.id;
  const definition = useWorkflow(workspaceId, workflow);
  const read = useWorkflowRun(runId);
  const writes = useWorkflowWrites();
  const [cancelling, setCancelling] = useState(false);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string>();
  const [stopping, setStopping] = useState(false);
  const now = useNow(read.run !== undefined && !read.run.ended);
  const again = useStartRun({ workflow, name: definition.workflow?.name, again: true });

  if (!host || workspaceId === undefined) {
    return null;
  }
  const cancel = async () => {
    setCancelBusy(true);
    setCancelError(undefined);
    try {
      await writes.cancel(runId);
      setStopping(true);
      setCancelling(false);
    } catch (error) {
      setCancelError(
        workflowWriteRefusal(error) === "refused"
          ? t("workflows.run.cancelRefused")
          : (instanceSentence(error) ?? t("workflows.run.cancelFailed"))
      );
    } finally {
      setCancelBusy(false);
    }
  };
  return (
    <>
      <WorkflowRunPageView
        workspaceId={workspaceId}
        workflowId={workflow}
        workflow={definition.workflow}
        read={read}
        now={now}
        canCancel={read.run !== undefined && cancelOffered(read.run, host.viewerId, host.rights)}
        canRunAgain={definition.workflow !== undefined && startOffered(definition.workflow)}
        // A run that ended while the cancellation was on its way is not stopping: it reads as
        // what it ended as.
        stopping={(stopping && read.run?.ended !== true) || read.run?.stopping === true}
        onCancel={() => {
          setCancelError(undefined);
          setCancelling(true);
        }}
        onRunAgain={again.open}
        onOpenRoute={host.showRoute}
      />
      {again.dialog}
      {cancelling ? (
        <CancelRunDialog
          loading={cancelBusy}
          error={cancelError}
          onConfirm={() => {
            cancel().catch(() => undefined);
          }}
          onClose={() => setCancelling(false)}
        />
      ) : null}
    </>
  );
}

/** The page of a run for a given run, given step runs and a given moment. */
export function WorkflowRunPageView({
  workspaceId,
  workflowId,
  workflow,
  read,
  now,
  canCancel,
  canRunAgain,
  stopping,
  onCancel,
  onRunAgain,
  onOpenRoute
}: {
  workspaceId: string;
  workflowId: string;
  /** The Workflow of the run, as far as the reader may read it: it is what the canvas draws. */
  workflow: WorkflowView | undefined;
  read: WorkflowRunRead;
  now: Date;
  canCancel: boolean;
  /** The reader may start the Workflow, and it takes no input: an ended run can be run again. */
  canRunAgain: boolean;
  /** The reader asked to cancel the run and the instance has not ended it yet. */
  stopping: boolean;
  onCancel(): void;
  onRunAgain(): void;
  onOpenRoute: OpenRoute;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const run = read.run;
  const address = { collaborationWorkspaceId: workspaceId, workflow: workflowId };
  const title =
    run === undefined
      ? undefined
      : t("workflows.run.title", { date: formatMoment(run.createdAt, locale) });
  const duration = run === undefined ? undefined : durationText(run, now, translation);
  // Who started the run and how long it took or has been going.
  const secondary =
    run === undefined
      ? undefined
      : [startedByText(run, t), duration].filter((part) => part !== undefined).join(" · ");
  // A step that failed says why itself. Until the page holds that step, the run says it.
  const failedStepHeld = (read.stepRuns ?? []).some((stepRun) => stepRun.failure !== undefined);
  const parent = run?.parent;
  const openChild = (step: WorkflowStepView, stepRun: WorkflowStepRunView | undefined) => {
    if (step.workflow === undefined) {
      return;
    }
    // In a run the step leads to the run it started; before it started one, to its Workflow.
    onOpenRoute(
      stepRun?.childRunId === undefined
        ? { kind: "workflow", collaborationWorkspaceId: workspaceId, workflow: step.workflow }
        : {
            kind: "workflow-run",
            collaborationWorkspaceId: workspaceId,
            workflow: step.workflow,
            run: stepRun.childRunId
          }
    );
  };
  const parentRoute: WorkspaceRoute | undefined =
    parent === undefined
      ? undefined
      : {
          kind: "workflow-run",
          collaborationWorkspaceId: workspaceId,
          workflow: parent.workflowId,
          run: parent.runId
        };
  return (
    <WorkflowsFrame label={title ?? t("workflows.sectionRuns")} testId="workflow-run-page" fill>
      <div
        aria-hidden="true"
        className="h-[var(--layout-page-head-inset,var(--layout-page-inset))] shrink-0"
      />
      <PageHeader
        variant="detail"
        className="shrink-0"
        back={
          <BackLink
            route={{ kind: "workflow-runs", ...address }}
            label={t("workflows.backToRuns")}
            onOpenRoute={onOpenRoute}
          >
            {t("workflows.sectionRuns")}
          </BackLink>
        }
        title={title ?? <TitlePlaceholder>{t("workflows.sectionRuns")}</TitlePlaceholder>}
        state={run ? <RunStateBadge status={run.status} stopping={stopping} /> : undefined}
        description={
          run ? (
            <>
              {workflow ? (
                <>
                  <TextLink {...routeLink({ kind: "workflow", ...address }, onOpenRoute)}>
                    {workflow.name}
                  </TextLink>
                  <span aria-hidden="true"> · </span>
                </>
              ) : null}
              {secondary}
            </>
          ) : undefined
        }
        descriptionPlacement="inline"
        descriptionTooltip={[workflow?.name, secondary]
          .filter((part) => part !== undefined && part !== "")
          .join(" · ")}
        primaryAction={
          run === undefined ? undefined : !run.ended ? (
            canCancel && !stopping ? (
              <Button variant="outline" onClick={onCancel}>
                {t("workflows.run.cancel")}
              </Button>
            ) : undefined
          ) : canRunAgain ? (
            // What happened is the page's subject, so the next action is no primary button.
            <Button variant="outline" onClick={onRunAgain}>
              <RotateCw aria-hidden="true" />
              {t("workflows.run.again")}
            </Button>
          ) : undefined
        }
      />
      {parentRoute === undefined || run === undefined ? null : (
        <div className="shrink-0 border-b px-(--layout-gutter) py-2">
          <Breadcrumb
            label={t("workflows.canvas.way")}
            items={[
              {
                id: "parent",
                label: t("workflows.run.parent"),
                href: workspaceRoutePath(parentRoute),
                onSelect: () => onOpenRoute(parentRoute)
              },
              { id: run.id, label: workflow?.name ?? t("workflows.run.thisRun") }
            ]}
          />
        </div>
      )}
      {read.problem === "failed" ? (
        <div className="p-(--layout-gutter)">
          <LoadError onRetry={read.retry}>{t(PROBLEM_SENTENCES.failed)}</LoadError>
        </div>
      ) : read.problem ? (
        <p className="p-(--layout-gutter) text-body text-muted-foreground">
          {t(PROBLEM_SENTENCES[read.problem])}
        </p>
      ) : (
        <>
          {run === undefined ? null : (
            <RunNotices
              run={run}
              silentFor={
                read.silentSince === undefined
                  ? undefined
                  : Math.max(0, Math.round((now.getTime() - read.silentSince) / 1000))
              }
              showFailure={
                run.failure !== undefined && (run.status === "limit_reached" || !failedStepHeld)
              }
              // The canvas draws the published definition. A run keeps the revision it started
              // on, so where the two differ the page says that the steps are not the run's own.
              earlierRevision={
                run.revisionId !== undefined &&
                workflow?.revisionId !== undefined &&
                run.revisionId !== workflow.revisionId
              }
              stopping={stopping}
              stepRunsCut={read.stepRunsCut}
            />
          )}
          <div className="relative min-h-0 flex-1">
            <WorkflowCanvas
              workflow={run === undefined ? undefined : workflow}
              run={run === undefined ? undefined : { run, stepRuns: read.stepRuns, now }}
              onOpenChild={openChild}
            />
          </div>
        </>
      )}
    </WorkflowsFrame>
  );
}

/**
 * What a run says above its canvas: that the page lost the instance, that the run waits, that
 * it was cancelled, and why it ended where no step says so. Nothing where there is nothing.
 */
function RunNotices({
  run,
  silentFor,
  showFailure,
  earlierRevision,
  stopping,
  stepRunsCut
}: {
  run: NonNullable<WorkflowRunRead["run"]>;
  silentFor: number | undefined;
  showFailure: boolean;
  earlierRevision: boolean;
  /** Someone asked to cancel the run, and it has not ended yet. */
  stopping: boolean;
  /** The run has more step runs than the page reads. */
  stepRunsCut: boolean;
}) {
  const { locale, t } = useTranslation();
  const line =
    stopping && !run.ended
      ? // A call that is going is not broken off: the run ends when it has.
        t("workflows.run.stoppingLine")
      : run.status === "queued"
        ? t("workflows.run.queuedLine")
        : run.status === "waiting"
          ? // C6: who is asked and since when is not in the contract yet.
            t("workflows.run.waitingLine")
          : run.status === "cancelled" && run.finishedAt !== undefined
            ? t("workflows.run.cancelledLine", { time: formatTime(run.finishedAt, locale) })
            : undefined;
  if (
    silentFor === undefined &&
    line === undefined &&
    !earlierRevision &&
    !stepRunsCut &&
    !(showFailure && run.failure)
  ) {
    return null;
  }
  return (
    <div
      data-run-notices=""
      className="grid shrink-0 grid-cols-1 gap-2 border-b px-(--layout-gutter) py-2"
    >
      {silentFor === undefined ? null : (
        <Banner tone="warning" layout="line">
          {t("workflows.run.stale", { seconds: silentFor })}
        </Banner>
      )}
      {line === undefined ? null : (
        <p data-run-line="" className="text-body text-muted-foreground">
          {line}
        </p>
      )}
      {earlierRevision ? (
        <Banner tone="info" layout="line" data-run-revision="">
          {t("workflows.run.earlierRevision")}
        </Banner>
      ) : null}
      {stepRunsCut ? (
        <Banner tone="info" layout="line" data-run-cut="">
          {t("workflows.run.stepRunsCut")}
        </Banner>
      ) : null}
      {showFailure && run.failure ? <FailureBanner failure={run.failure} /> : null}
    </div>
  );
}

/** Asks once before a run is cancelled, and says what cancelling leaves as it is. */
export function CancelRunDialog({
  loading,
  error,
  onConfirm,
  onClose
}: {
  loading: boolean;
  error: string | undefined;
  onConfirm(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      open
      size="sm"
      title={t("workflows.run.cancelTitle")}
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" disabled={loading} onClick={onClose}>
            {t("workflows.run.cancelKeep")}
          </Button>
          <Button variant="danger" loading={loading} onClick={onConfirm}>
            {t("workflows.run.cancel")}
          </Button>
        </>
      }
    >
      <p className="text-body text-muted-foreground">{t("workflows.run.cancelBody")}</p>
      {error ? <InlineError className="mt-3">{error}</InlineError> : null}
    </Dialog>
  );
}
