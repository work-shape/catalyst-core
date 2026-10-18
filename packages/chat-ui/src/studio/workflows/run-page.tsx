import { Bot, RotateCw } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Badge,
  Banner,
  Breadcrumb,
  Button,
  Dialog,
  InlineError,
  PageHeader,
  PageLead,
  TextLink
} from "@work-shape/catalyst-ui";
import { instanceSentence } from "../build-area/build-refusals";
import { formatMoment, formatTime } from "../../shared/locale-format";
import { useTranslation, type TranslationKey } from "../../shared/i18n";
import { workspaceRoutePath } from "../../shared/routes";
import type { WorkspaceRoute } from "../../shared/workspace-route";
import { FailureBanner } from "./failure-banner";
import { fixWithAgentPrompt } from "./fix-with-agent";
import { runKeyText, startedByText } from "./runs-list";
import { useStartRun } from "./start-run";
import { useRunLiveOnce, useTestRun, type LiveOnceControl } from "./test-run";
import { WorkflowCanvas, type WorkflowCanvasFocus } from "./workflow-canvas";
import { EditRefusedBanner, useEditWithAgent, type WorkflowEdit } from "./workflow-draft";
import {
  useWorkflow,
  useWorkflowRun,
  useWorkflowWrites,
  workflowWriteRefusal,
  type WorkflowReadProblem,
  type WorkflowRunRead
} from "./workflow-data";
import type { WorkflowStepRunView, WorkflowStepView, WorkflowView } from "./workflow-views";
import {
  cancelOffered,
  failedEntriesOf,
  runFailed,
  startOffered,
  type EntryTally,
  type FailedEntries
} from "./workflow-model";
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
  const again = useStartRun({
    workflow,
    name: definition.workflow?.name,
    form: definition.workflow?.startForm,
    again: true
  });
  const testAgain = useTestRun(workflow, definition.workflow);
  const liveOnce = useRunLiveOnce(workflow, definition.workflow, read.run?.ended === true);
  const edit = useEditWithAgent(workflow, definition.workflow);
  const test = read.run?.test === true;

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
        // A test run is run again as a test of the draft, a run of what is published as a run.
        canRunAgain={
          test
            ? testAgain !== undefined
            : definition.workflow !== undefined && startOffered(definition.workflow)
        }
        // A run that ended while the cancellation was on its way is not stopping: it reads as
        // what it ended as.
        stopping={(stopping && read.run?.ended !== true) || read.run?.stopping === true}
        onCancel={() => {
          setCancelError(undefined);
          setCancelling(true);
        }}
        onRunAgain={test && testAgain !== undefined ? testAgain.open : again.open}
        onOpenRoute={host.showRoute}
        {...(edit === undefined ? {} : { edit })}
        {...(test && liveOnce !== undefined ? { liveOnce } : {})}
      />
      {again.dialog}
      {testAgain?.dialog}
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
  onOpenRoute,
  edit,
  liveOnce
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
  /**
   * For a reader who may write the Workflow: a failed run's "Fix with the agent", which opens
   * the conversation about the Workflow beside its page.
   */
  edit?: WorkflowEdit;
  /** On a test run, for a reader who may write the Workflow: "Run live once" per step. */
  liveOnce?: (
    step: WorkflowStepView,
    stepRun: WorkflowStepRunView | undefined
  ) => LiveOnceControl | undefined;
}) {
  const translation = useTranslation();
  const { locale, t } = translation;
  const run = read.run;
  // "Show failed …" opens the loop's entries in the canvas's panel, filtered to the failed.
  const [focus, setFocus] = useState<WorkflowCanvasFocus>();
  const failedEntries =
    run === undefined
      ? undefined
      : failedEntriesOf(
          run,
          [...(read.stepRuns ?? []), ...(read.entryLoops ?? [])],
          workflow?.steps
        );
  const address = { collaborationWorkspaceId: workspaceId, workflow: workflowId };
  const title =
    run === undefined
      ? undefined
      : t(run.test ? "workflows.run.testTitle" : "workflows.run.title", {
          date: formatMoment(run.createdAt, locale)
        });
  const duration = run === undefined ? undefined : durationText(run, now, translation);
  // Who started the run and how long it took or has been going.
  const secondary =
    run === undefined
      ? undefined
      : [runKeyText(run, t), startedByText(run, t), duration]
          .filter((part) => part !== undefined)
          .join(" · ");
  // A step that failed says why itself. Until the page holds that step, the run says it.
  const failedStepHeld = (read.stepRuns ?? []).some((stepRun) => stepRun.failure !== undefined);
  const parent = run?.parent;
  // A failed run is fixed in the Workflow: that is the next step, and running it again is not.
  const fix = run?.ended === true && runFailed(run) ? edit : undefined;
  const runAgainLabel = run?.test === true ? "workflows.run.testAgain" : "workflows.run.again";
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
        state={
          run === undefined ? undefined : (
            <>
              {run.test ? (
                <Badge tone="info" size="sm" data-test-run="">
                  {t("workflows.run.testBadge")}
                </Badge>
              ) : null}
              {/* A done run's state waits for its step runs: they say whether entries failed. */}
              {run.status === "done" &&
              read.stepRuns === undefined &&
              failedEntries === undefined ? null : (
                <RunStateBadge
                  status={run.status}
                  stopping={stopping}
                  withFailedEntries={failedEntries !== undefined}
                />
              )}
            </>
          )
        }
        secondaryActions={
          fix !== undefined && canRunAgain
            ? [
                {
                  label: t(runAgainLabel),
                  icon: <RotateCw aria-hidden="true" />,
                  onSelect: onRunAgain
                }
              ]
            : undefined
        }
        primaryAction={
          run === undefined ? undefined : !run.ended ? (
            canCancel && !stopping ? (
              <Button variant="outline" onClick={onCancel}>
                {t("workflows.run.cancel")}
              </Button>
            ) : undefined
          ) : fix !== undefined ? (
            <Button
              loading={fix.busy}
              // The failed step and its reason go into the composer: they wait for the step runs.
              disabled={read.stepRuns === undefined}
              onClick={() =>
                fix.startWith(
                  fixWithAgentPrompt(run, read.stepRuns ?? [], workflow?.steps, translation)
                )
              }
            >
              <Bot aria-hidden="true" />
              {t("workflows.fix.withAgent")}
            </Button>
          ) : canRunAgain ? (
            // What happened is the page's subject, so the next action is no primary button.
            <Button variant="outline" onClick={onRunAgain}>
              <RotateCw aria-hidden="true" />
              {t(runAgainLabel)}
            </Button>
          ) : undefined
        }
      />
      {/* Whose run it is and how it went is the first line of the page, not a part of its head. */}
      {run === undefined ? null : (
        <PageLead className="shrink-0 pb-3">
          {workflow ? (
            <>
              <TextLink {...routeLink({ kind: "workflow", ...address }, onOpenRoute)}>
                {workflow.name}
              </TextLink>
              <span aria-hidden="true"> · </span>
            </>
          ) : null}
          {secondary}
        </PageLead>
      )}
      {edit === undefined ? null : <EditRefusedBanner edit={edit} />}
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
      ) : read.stepsFailed ? (
        <div className="p-(--layout-gutter)">
          <LoadError onRetry={read.retry}>{t("workflows.run.stepsFailedToLoad")}</LoadError>
        </div>
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
              // A test run is of a draft, which the canvas draws for whoever may test it.
              earlierRevision={
                !run.test &&
                run.revisionId !== undefined &&
                workflow?.revisionId !== undefined &&
                run.revisionId !== workflow.revisionId
              }
              stopping={stopping}
              stepRunsCut={read.stepRunsCut}
              failedEntries={failedEntries}
              onShowFailed={(stepId) => setFocus({ stepId })}
            />
          )}
          <div className="relative min-h-0 flex-1">
            <WorkflowCanvas
              workflow={run === undefined ? undefined : workflow}
              run={
                run === undefined
                  ? undefined
                  : {
                      run,
                      stepRuns: read.stepRuns,
                      now,
                      ...(liveOnce === undefined ? {} : { liveOnce })
                    }
              }
              onOpenChild={openChild}
              {...(focus === undefined ? {} : { focus })}
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
  stepRunsCut,
  failedEntries,
  onShowFailed
}: {
  run: NonNullable<WorkflowRunRead["run"]>;
  silentFor: number | undefined;
  showFailure: boolean;
  earlierRevision: boolean;
  /** Someone asked to cancel the run, and it has not ended yet. */
  stopping: boolean;
  /** The run has more step runs than the page reads. */
  stepRunsCut: boolean;
  /** Entries of the run's loops that failed while the run ended `done`. */
  failedEntries: FailedEntries | undefined;
  /** Opens the failed entries of the loop with the given step id. */
  onShowFailed(stepId: string): void;
}) {
  const { locale, t } = useTranslation();
  const failedLoop = failedEntries?.opens?.loopStepId;
  const testLine =
    run.test && run.startedBy !== undefined
      ? t("workflows.run.testLine", { person: run.startedBy.name })
      : undefined;
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
    testLine === undefined &&
    !earlierRevision &&
    !stepRunsCut &&
    failedEntries === undefined &&
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
      {testLine === undefined ? null : (
        <Banner tone="info" layout="line" data-run-test="">
          {testLine}
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
      {failedEntries === undefined ? null : (
        <FailedEntriesBanner
          failedEntries={failedEntries}
          onShow={failedLoop === undefined ? undefined : () => onShowFailed(failedLoop)}
        />
      )}
    </div>
  );
}

/**
 * A run that ended `done` although entries of its loops failed: how many of how many, and the
 * one way to them, which works at every zoom of the canvas. Before the page holds its loops, or
 * where only runs further down have failures, it says how many, without a total and without a
 * way the page could not keep.
 */
function FailedEntriesBanner({
  failedEntries: { childRuns, entries, items, descendantRuns, opens },
  onShow
}: {
  failedEntries: FailedEntries;
  /** Opens the loop the failed entries are in. None where the page holds no such loop. */
  onShow: (() => void) | undefined;
}) {
  const { locale, t } = useTranslation();
  const counts = ({ failed, total }: EntryTally) => ({
    count: failed.toLocaleString(locale),
    total: total.toLocaleString(locale)
  });
  const sentences = [
    childRuns === undefined
      ? undefined
      : t(
          childRuns.failed === 1
            ? "workflows.run.failedChildRunsOne"
            : "workflows.run.failedChildRunsMany",
          counts(childRuns)
        ),
    entries === undefined
      ? undefined
      : t(
          entries.failed === 1
            ? "workflows.run.failedEntriesOne"
            : "workflows.run.failedEntriesMany",
          counts(entries)
        ),
    items === undefined
      ? undefined
      : t(items === 1 ? "workflows.run.failedItemsOne" : "workflows.run.failedItemsMany", {
          count: items.toLocaleString(locale)
        }),
    descendantRuns === undefined
      ? undefined
      : t(
          descendantRuns === 1
            ? "workflows.run.failedDescendantRunsOne"
            : "workflows.run.failedDescendantRunsMany",
          { count: descendantRuns.toLocaleString(locale) }
        )
  ].filter((sentence) => sentence !== undefined);
  return (
    <Banner
      tone="warning"
      layout="inline"
      data-run-failed-entries=""
      action={
        onShow === undefined ? undefined : (
          <Button size="sm" variant="outline" onClick={onShow}>
            {t(
              opens?.childRuns === true
                ? "workflows.run.showFailedChildRuns"
                : "workflows.run.showFailedEntries"
            )}
          </Button>
        )
      }
    >
      {sentences.join(" ")}
    </Banner>
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
