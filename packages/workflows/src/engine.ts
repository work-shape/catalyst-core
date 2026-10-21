import { startAgentStep } from "./agent-step";
import { createStepBeginning } from "./step-begin";
import { createRunReads } from "./run-reads";
import { createRunFinisher } from "./run-finish";
import { createContinuation } from "./continue-as-new";
import { settleNoticeStep } from "./notice-step";
import { createFailureNotices } from "./failure-notices";
import { createLoopProgress } from "./loop-progress";
import { createStepClaim } from "./step-claim";
import { createWorkflowDatasets } from "./datasets";
import { createDatasetLifetime } from "./dataset-lifetime";
import {
  AppError,
  appWorkflowRefusalError,
  asUserId,
  auditActorFromIdentity,
  defineJobHandler,
  isAuthenticatedServicePrincipal,
  isWorkflowRunEnded,
  operationTimeoutKey,
  subjectDedupeKey,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type JobSchedule,
  type LocaleCode,
  type PlatformStores,
  type Notices,
  type RegisteredJobHandler,
  type StorePage,
  type WorkflowAgentTranscript,
  type WorkflowLastRun,
  type WorkflowRun,
  type WorkflowRunError,
  type WorkflowRunKeyFilter,
  type WorkflowRunView,
  type WorkflowStepRun,
  type WorkflowStepRunFilter,
  type WorkflowStepRunRef,
  type WorkflowStepRunView
} from "@work-shape/catalyst-core";
import { childStepOutcome, createWorkflowStartSource } from "./child-runs";
import { createRunEnd } from "./run-end";
import { createRunDeadline } from "./run-deadline";
import { noWorkflowStepFiles, type WorkflowStepFiles } from "./code-step";
import {
  WORKFLOW_STEP_DATA_DAYS,
  createWorkflowDataPruning,
  type WorkflowDataPruning,
  type WorkflowDataPruningOptions
} from "./data-pruning";
import { indexWorkflowSteps, type WorkflowStepIndex } from "./definition";
import {
  workflowDefinitionRefusal,
  type WorkflowDefinitionSource,
  type WorkflowDefinitionSummary
} from "./definition-source";
import {
  WORKFLOW_RUN_LIMITS,
  WORKFLOW_UNBOUNDED_CEILINGS,
  type WorkflowLimitCeilings,
  type WorkflowRunLimits
} from "./limits";
import type { WorkflowOperationCalls } from "./operation-step";
import { createBlockEnds } from "./run-blocks";
import { principalActor } from "./run-identity";
import {
  createRunOpening,
  type StartWorkflowRunInput,
  type TestWorkflowRunInput
} from "./run-open";
import { createStartCheck } from "./run-start";
import { createScheduleTrigger } from "./schedule-trigger";
import { createScheduledStart } from "./scheduled-start";
import { createStepExecutor, type StepEnd, type WorkflowCodeRunner } from "./step-execution";
import { stepJobConcurrency, workflowCodeJobKind, workflowStepJobKind } from "./step-job";
import { workflowLimitIssues, type WorkflowLimitContext } from "./run-limits";
import { workflowContinuationIssues } from "./continuation-rules";
import { createRunWaiting } from "./run-waiting";

// The engine of Workflow Runs. A run is a row, each step it reaches is a step run, and each
// step run is executed by one job of the shared executor. A step ends in the transaction
// that creates the step run after it and that step run's job, so a run is always either
// ended or has exactly the work queued that carries it on, whichever process dies when.
//
// What a run is taken up again from is its step runs: one exists per run and path of a step,
// so a worker that starts after another died executes the step run that was open and starts
// nothing that has a step run. The run keeps the definition it started on, and nothing waits
// in a process: the wait before another attempt and the run's own deadline are stored times.

export interface WorkflowEngineOptions {
  /** The validated release setting: jobs of the step kind served by one process. */
  stepSlots: number;
  datasetObjects?: import("@work-shape/catalyst-core").ObjectStorage;
  datasetLimits?: import("@work-shape/catalyst-core").WorkflowDatasetLimits;
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  /** Where the published definition of a Workflow is read when a run is started. */
  definitions: WorkflowDefinitionSource;
  /** Bound to the transaction that settles the step: Inbox and mail queue commit together. */
  notices?: (stores: PlatformStores) => Notices;
  /** The language of the notices the engine writes itself. English when left out. */
  locale?: LocaleCode;
  /** The call path of the instance. An operation step calls through it and nothing else. */
  operationCalls: WorkflowOperationCalls;
  /** Defaults below the release's own, for a test. A Workflow's `limits` set its own. */
  limits?: Partial<WorkflowRunLimits>;
  /**
   * The ceilings of release config: the most a Workflow's `limits` may set. A run never runs
   * above them. No ceiling beyond what a Workflow asks when left out.
   */
  ceilings?: WorkflowLimitCeilings;
  now?: () => Date;
  /** The time zone the cron expressions of `schedule` triggers are read in. UTC when left out. */
  timeZone?: string;
  /** Where the script of a code step is read. Without it no Workflow has a script. */
  stepFiles?: WorkflowStepFiles;
  /**
   * Set where the instance runs a command worker with a sandbox: the scripts of code steps
   * are run there. Without it a code step fails at once instead of waiting for nobody.
   */
  codeRunner?: WorkflowCodeRunner;
  /** For how many days after its end a run keeps its values. The release's default when left out. */
  stepDataDays?: number;
  /** Batch sizes of the job that removes run data, below the release's own, for a test. */
  pruneBatch?: WorkflowDataPruningOptions["batch"];
}

export type { StartWorkflowRunInput, TestWorkflowRunInput } from "./run-open";

export interface WorkflowEngine {
  /** Starts a run of the published definition from its manual trigger. */
  start(input: StartWorkflowRunInput): Promise<WorkflowRunView>;
  /**
   * Starts a test run of a draft in mode `test`, whatever its triggers. Its steps act as the
   * person who starts it, bounded by the Workflow's principal: a reading step reads live and
   * a changing step is simulated unless "Run live once" covers it.
   */
  test(input: TestWorkflowRunInput): Promise<WorkflowRunView>;
  /**
   * Cancels the live member of a Lauf, addressed by any member's id. No further step starts.
   * A call in flight finishes and is recorded on its step run. An ended Lauf answers its
   * final member as it is.
   */
  cancel(input: {
    runId: string;
    cancelledBy: AuthenticatedIdentity;
    correlationId: string;
  }): Promise<WorkflowRunView | undefined>;
  readRun(runId: string): Promise<WorkflowRunView | undefined>;
  /** The runs of a Workflow, newest first: all of them, or those of one key or key prefix. */
  listRuns(input: {
    workflow: string;
    key?: WorkflowRunKeyFilter;
    page?: StorePage;
  }): Promise<WorkflowRunView[]>;
  /** The step runs of a run: all of them, or those of one block, status or item of a loop. */
  listStepRuns(input: {
    runId: string;
    includeAgentData?: boolean;
    filter?: WorkflowStepRunFilter;
    page?: StorePage;
  }): Promise<WorkflowStepRunView[]>;
  /** The bounded transcript of one agent step run of the run; nothing for any other. */
  readStepTranscript(input: {
    runId: string;
    stepRunId: string;
  }): Promise<WorkflowAgentTranscript | undefined>;
  /** The Workflows with a published definition, each with its latest run where it has one. */
  listWorkflows(
    page?: StorePage
  ): Promise<(WorkflowDefinitionSummary & { lastRun?: WorkflowLastRun })[]>;
  /**
   * Repairs the first page at startup and persists the remaining pages as repair jobs.
   * Answers the due times queued in the first page; later pages run on the shared executor.
   */
  planSchedules(): Promise<{ workflow: string; dueAt: string }[]>;
  /**
   * The same for one Workflow: whoever publishes its definition, or takes it back, calls this.
   * It answers the due time it queued, or nothing where the Workflow has no schedule.
   */
  planSchedule(workflow: string): Promise<{ workflow: string; dueAt: string } | undefined>;
  /** What the job worker of the process serves for the engine. */
  jobHandlers: readonly RegisteredJobHandler[];
  /** What the job worker runs again and again: the job that removes old run data, daily. */
  jobSchedules: readonly JobSchedule[];
  /** Removes the values of the runs that are due, as the daily job does. */
  pruneRunData: WorkflowDataPruning["prune"];
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const { clientInstanceId, stores, definitions, operationCalls } = options;
  const limits: WorkflowRunLimits = { ...WORKFLOW_RUN_LIMITS, ...options.limits };
  const limitContext: WorkflowLimitContext = {
    defaults: limits,
    ceilings: options.ceilings ?? WORKFLOW_UNBOUNDED_CEILINGS,
    stepSlots: options.stepSlots
  };
  const now = options.now ?? (() => new Date());
  const waiting = createRunWaiting({ clientInstanceId, now });

  const datasets =
    options.datasetObjects && options.datasetLimits
      ? createWorkflowDatasets({
          clientInstanceId,
          stores,
          objects: options.datasetObjects,
          limits: options.datasetLimits
        })
      : undefined;
  const datasetLifetime = createDatasetLifetime({
    clientInstanceId,
    stores,
    objects: options.datasetObjects,
    stepDataDays: options.stepDataDays ?? WORKFLOW_STEP_DATA_DAYS,
    now
  });
  const { cancelWaiting, insideEndedBlock } = createBlockEnds({ clientInstanceId, now });
  const stepFiles = options.stepFiles ?? noWorkflowStepFiles;
  const executor = createStepExecutor({
    clientInstanceId,
    stores,
    operationCalls,
    definitions,
    limits: limitContext,
    now,
    stepFiles,
    ...(datasets ? { datasets } : {}),
    ...(options.codeRunner ? { codeRunner: options.codeRunner } : {})
  });

  const endRun = createRunEnd({
    clientInstanceId,
    now,
    cancelWaiting,
    datasetEnd: datasetLifetime.end
  });

  const finishRun = createRunFinisher({
    clientInstanceId,
    endRun,
    fillLoop: (...args) => fillLoop(...args)
  });

  /**
   * What a step run that failed does to its run. A loop around it that continues past a failed
   * item goes on with its next item, and the run with it. Any other loop fails with its item,
   * and so does what is around that loop, up to the run. A refusal of the run's principal is
   * no failure of an item: no loop continues past it, and the run fails with its reason.
   */
  async function failStep(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    stepRun: WorkflowStepRun,
    error: WorkflowRunError,
    /** The run's principal itself was refused, so the next item would be refused as well. */
    systemic = false
  ): Promise<void> {
    let failed = stepRun;
    while (failed.containerStepRunId !== undefined) {
      const loopRun = await tx.workflowRuns.getStepRun({
        clientInstanceId,
        id: failed.containerStepRunId
      });
      if (!loopRun) break;
      const loop = index.get(loopRun.stepId)?.step;
      if (!systemic && loop?.type === "loop" && loop.onItemFailure === "continue") {
        await fillLoop(tx, run, index, loopRun);
        return;
      }
      await tx.workflowRuns.endStepRun({
        clientInstanceId,
        id: loopRun.id,
        status: "failed",
        finishedAt: now().toISOString(),
        error: { code: "loop_step_failed", message: "A step of the loop failed" }
      });
      // The loop stopped: its items that wait never start. Those with a call in flight end
      // and are recorded, and `settle` starts nothing after them.
      await cancelWaiting(tx, run, loopRun);
      failed = loopRun;
    }
    await finishRun(tx, run, {
      status: "failed",
      error: { ...error, stepRunId: stepRun.id }
    });
  }

  const beginStep = createStepBeginning({
    clientInstanceId,
    now,
    finishRun,
    advance,
    continueRun: (...args) => continueRun(...args)
  });

  const continueRun = createContinuation({
    clientInstanceId,
    datasets,
    definitions,
    now,
    prepare: (...args) => prepareStart(...args),
    open: (...args) => openRun(...args),
    finish: finishRun,
    retireData: (tx, run) => datasetLifetime.end(tx, { ...run, status: "continued" }, undefined)
  });

  const fillLoop = createLoopProgress({
    continueRun,
    clientInstanceId,
    now,
    datasets,
    beginStep,
    advance,
    completeDatasets,
    async failLoop(tx, run, loop, error) {
      await tx.workflowRuns.endStepRun({
        clientInstanceId,
        id: loop.id,
        status: "failed",
        finishedAt: now().toISOString(),
        error
      });
      await finishRun(tx, run, { status: "failed", error: { ...error, stepRunId: loop.id } });
    }
  });

  async function completeDatasets(tx: PlatformStores, run: WorkflowRun, stepRun: WorkflowStepRun) {
    for (const row of await tx.workflowRunDatasets.completeStep({
      clientInstanceId,
      stepRunId: stepRun.id
    })) {
      await tx.audit.appendAuditEvent({
        clientInstanceId,
        type: "workflow_run.dataset_created",
        status: "success",
        actor: principalActor(run),
        subject: row.id,
        correlationId: run.correlationId,
        metadata: {
          runId: run.id,
          stepRunId: stepRun.id,
          datasetId: row.id,
          rowCount: row.rowCount,
          bytes: row.bytes
        }
      });
    }
  }

  /** Starts what follows a step run that ended as `done`. */
  async function advance(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    stepRun: WorkflowStepRun
  ): Promise<void> {
    const place = index.get(stepRun.stepId);
    if (!place) return;
    const next = place.sequence.steps[place.position + 1];
    if (next) {
      // The next step of the same list stands beside this one: same block, same item.
      const prefix = stepRun.key.slice(0, stepRun.key.length - stepRun.stepId.length);
      const { containerStepRunId, branch, iteration } = stepRun;
      await beginStep(
        tx,
        run,
        next,
        {
          key: `${prefix}${next.id}`,
          ...(containerStepRunId === undefined ? {} : { containerStepRunId }),
          ...(branch === undefined ? {} : { branch }),
          ...(iteration === undefined ? {} : { iteration })
        },
        index
      );
      return;
    }
    if (stepRun.containerStepRunId === undefined) return;
    // The last step of one item ended: the next items, or the end of the loop.
    const loopRun = await tx.workflowRuns.getStepRun({
      clientInstanceId,
      id: stepRun.containerStepRunId
    });
    if (!loopRun) return;
    await fillLoop(tx, run, index, loopRun);
  }

  const claim = createStepClaim({ clientInstanceId, stores, now, waiting, executor, finishRun });

  /** Writes how the attempt of a step went and, in the same transaction, what follows it. */
  async function settle(
    tx: PlatformStores,
    ref: WorkflowStepRunRef,
    index: WorkflowStepIndex,
    end: StepEnd
  ): Promise<void> {
    const found = await tx.workflowRuns.getStepRun(ref);
    if (!found) return;
    const run = await tx.workflowRuns.lockRun({ clientInstanceId, id: found.runId });
    const stepRun = await tx.workflowRuns.getStepRun(ref);
    if (!run || stepRun?.status !== "running") return;
    // A run that ended while the step worked keeps what the step did and starts nothing, and
    // so does a loop around the step that stopped while the step worked.
    const live = !isWorkflowRunEnded(run.status) && !(await insideEndedBlock(tx, stepRun));
    const finishedAt = now().toISOString();
    if (end.kind === "failed") {
      const { kind: _kind, systemic, ...failure } = end;
      await tx.workflowRuns.endStepRun({ ...ref, status: "failed", finishedAt, ...failure });
      if (live) await failStep(tx, run, index, stepRun, end.error, systemic);
      return;
    }
    if (end.kind === "notice") {
      if (!live) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
        return;
      }
      const error = await settleNoticeStep({
        tx,
        ref,
        run,
        notice: end.notice,
        notices: options.notices,
        finishedAt
      });
      if (error)
        await settle(tx, ref, index, {
          kind: "failed",
          error,
          systemic: error.code === "principal_inactive"
        });
      else await advance(tx, run, index, stepRun);
      return;
    }
    if (end.kind === "agent") {
      if (!live) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
        return;
      }
      await startAgentStep(
        tx,
        run,
        stepRun,
        end,
        index.get(stepRun.stepId)?.step.name ?? stepRun.stepId,
        new Date(
          now().getTime() + (options.stepDataDays ?? WORKFLOW_STEP_DATA_DAYS) * 86400000
        ).toISOString()
      );
      return;
    }
    if (end.kind === "child") {
      if (!live) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
        return;
      }
      // A fast child can finish before this attempt commits its wait. Read behind the
      // parent lock so its wake can never be consumed before there is a wait to resume.
      const known = await childStepOutcome(tx, run, stepRun);
      if (known) {
        await settle(tx, ref, index, {
          ...known,
          ...(end.operationRunId ? { operationRunId: end.operationRunId } : {}),
          ...(end.call ? { call: end.call } : {})
        });
        return;
      }
      await tx.workflowRuns.markChildWaiting({
        ...ref,
        ...(end.operationRunId ? { operationRunId: end.operationRunId } : {}),
        ...(end.call ? { call: end.call } : {})
      });
      return;
    }
    if (end.kind === "operation_wait") {
      if (!live) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
        return;
      }
      const waits = await tx.workflowRuns.waitForOperation({
        ...ref,
        operationRunId: end.operationRunId,
        ...(end.call ? { call: end.call } : {})
      });
      if (!waits) {
        // The work ended before the step began to wait: the step is answered from it.
        const waited = await tx.operationRuns.get({ clientInstanceId, id: end.operationRunId });
        await settle(
          tx,
          ref,
          index,
          waited
            ? await executor.finishOperation(waited, false)
            : {
                kind: "failed",
                error: {
                  code: "operation_not_found",
                  message: "The call the step waited for is not recorded"
                },
                systemic: false
              }
        );
        return;
      }
      // The step holds no job while it waits: the end of the Operation Run queues one, and
      // this one ends the wait at the step's timeout.
      const since = Date.parse(stepRun.startedAt ?? finishedAt);
      await tx.jobs.enqueue(
        workflowStepJobKind,
        { stepRunId: stepRun.id },
        {
          clientInstanceId,
          subject: stepRun.id,
          dedupeKey: operationTimeoutKey(stepRun.id),
          runAfter: new Date(since + end.timeoutMs),
          ...stepJobConcurrency(run),
          correlationId: run.correlationId
        }
      );
      return;
    }
    if (end.kind === "code") {
      if (!live) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
        return;
      }
      // The step run waits with its script and its input, and the command worker has the
      // job of running them: both in this transaction, so neither is there without the other.
      await tx.workflowRuns.stageCodeStep({ ...ref, staged: end.staged });
      await tx.jobs.enqueue(
        workflowCodeJobKind,
        { stepRunId: stepRun.id },
        {
          clientInstanceId,
          subject: stepRun.id,
          dedupeKey: subjectDedupeKey(workflowCodeJobKind.kind, stepRun.id),
          concurrencyKey: run.id,
          correlationId: run.correlationId
        }
      );
      return;
    }
    if (end.kind === "loop") {
      if (!live) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
        return;
      }
      // From here the step runs of its items carry the loop on. A loop without an item ends.
      const loop = index.get(stepRun.stepId)?.step;
      const last = loop?.type === "loop" ? loop.steps.at(-1)?.id : undefined;
      await tx.workflowRuns.markLoopWaiting({
        ...ref,
        items: end.items,
        ...(loop?.type === "loop" && loop.steps[0] ? { firstStepId: loop.steps[0].id } : {}),
        ...(end.total === undefined ? {} : { total: end.total }),
        ...(last === undefined ? {} : { lastStepId: last })
      });
      await fillLoop(tx, run, index, stepRun);
      return;
    }
    const { kind: _kind, ...done } = end;
    await tx.workflowRuns.endStepRun({ ...ref, status: "done", finishedAt, ...done });
    if (live) await completeDatasets(tx, run, stepRun);
    if (!live) return;
    if (stepRun.stepType === "output") {
      await finishRun(tx, run, { status: "done", output: end.output });
      return;
    }
    await advance(tx, run, index, stepRun);
  }

  const stepHandler = defineJobHandler({
    kind: workflowStepJobKind,
    slots: options.stepSlots,
    async run(job, control) {
      const ref: WorkflowStepRunRef = { clientInstanceId, id: job.payload.stepRunId };
      const claimed = await claim(control, ref, job.dedupeKey === operationTimeoutKey(ref.id));
      if (!claimed) return;
      const definition = await stores.workflowRuns.readRunDefinition({
        clientInstanceId,
        id: claimed.run.id
      });
      if (!definition) return;
      const index = indexWorkflowSteps(definition);
      const attempt = {
        ...claimed,
        // The step run was read before this attempt was written on it.
        stepRun: { ...claimed.stepRun, attempt: control.attempt },
        definition,
        index,
        signal: control.signal
      };
      // A code step whose script has ended is finished from what the script left; every
      // other step, and a code step before its script ran, is executed.
      const end = claimed.afterCode
        ? await executor.finishCode(attempt, claimed.afterCode)
        : claimed.afterOperation
          ? await executor.finishOperation(
              claimed.afterOperation.waited,
              claimed.afterOperation.timedOut
            )
          : await executor.execute(attempt);
      // A worker that stops, or that lost its lease, ends no step: what its cut attempt
      // answered is no outcome of the step. The step run stays as it is and the next attempt
      // takes it up, which reads again or is answered what a changing call answered.
      if (control.signal.aborted) {
        throw control.signal.reason instanceof Error
          ? control.signal.reason
          : new Error("The attempt was stopped");
      }
      await control.transaction(async (tx) => {
        // The runs above are locked before this one, as `claim` does: what the step's end
        // does to whether its run waits reaches them too.
        const chain = await waiting.lockChain(tx, claimed.run.id);
        await settle(tx, ref, index, end);
        if (chain) await waiting.noteWaiting(tx, chain);
        // The step stopped waiting: its timeout has nothing left to end.
        if (claimed.afterOperation) {
          await tx.jobs.withdraw(workflowStepJobKind, {
            clientInstanceId,
            dedupeKey: operationTimeoutKey(ref.id)
          });
        }
      });
    },
    // Every attempt of the step crashed. The run does not go on from a step nobody ended.
    async onExhausted(job, tx) {
      const ref: WorkflowStepRunRef = { clientInstanceId, id: job.payload.stepRunId };
      const found = await tx.workflowRuns.getStepRun(ref);
      if (!found) return;
      const run = await tx.workflowRuns.lockRun({ clientInstanceId, id: found.runId });
      const stepRun = await tx.workflowRuns.getStepRun(ref);
      if (!run || !stepRun) return;
      if (stepRun.status !== "queued" && stepRun.status !== "running") return;
      const error = {
        code: "step_crashed",
        message: `The step did not end in ${job.maxAttempts} attempts`
      };
      await tx.workflowRuns.endStepRun({
        ...ref,
        status: "failed",
        finishedAt: now().toISOString(),
        error
      });
      if (isWorkflowRunEnded(run.status)) return;
      const definition = await tx.workflowRuns.readRunDefinition({ clientInstanceId, id: run.id });
      await failStep(tx, run, indexWorkflowSteps(definition ?? { steps: [] }), stepRun, error);
    }
  });

  const prepareStart = createStartCheck({
    clientInstanceId,
    stores,
    operationCalls,
    limits,
    definitions
  });

  const { openRun, startByHand } = createRunOpening({
    clientInstanceId,
    stores,
    authorizer: operationCalls.deps.authorizer,
    limits: limitContext,
    now,
    stepFiles,
    prepareStart,
    beginTrigger: (tx, run, trigger) => beginStep(tx, run, trigger, { key: trigger.id })
  });

  operationCalls.registry.addSource(
    createWorkflowStartSource({
      clientInstanceId,
      stores,
      definitions,
      now,
      prepare: prepareStart,
      open: openRun,
      start: async (input, mode) => {
        const published = await definitions.read(input.workflow);
        if (!published) throw new AppError("NOT_FOUND", "There is no such Workflow");
        const [trigger] = published.manifest.steps;
        if (trigger?.type !== "trigger" || !trigger.triggers.some((t) => t.kind === "manual")) {
          throw new AppError("CONFLICT", "The Workflow is not started by hand", {
            reason: "no_manual_trigger"
          });
        }
        return startByHand(published, input, mode);
      }
    })
  );

  const deadlineHandler = createRunDeadline({ clientInstanceId, now, finishRun });

  const schedule = createScheduleTrigger({
    clientInstanceId,
    stores,
    definitions,
    timeZone: options.timeZone ?? "UTC",
    now,
    prepare: createScheduledStart({ clientInstanceId, prepareStart, openRun })
  });

  const pruning = createWorkflowDataPruning({
    clientInstanceId,
    stores,
    stepDataDays: options.stepDataDays ?? WORKFLOW_STEP_DATA_DAYS,
    ...(options.pruneBatch ? { batch: options.pruneBatch } : {}),
    pruneDatasets: datasetLifetime.prune,
    now
  });

  return {
    jobHandlers: [
      ...datasetLifetime.handlers,
      createFailureNotices(options),
      stepHandler,
      deadlineHandler,
      schedule.handler,
      schedule.repairHandler,
      pruning.handler
    ],
    jobSchedules: [pruning.schedule],
    pruneRunData: pruning.prune,
    planSchedules: schedule.plan,
    planSchedule: schedule.planOne,

    async start(input) {
      const published = await definitions.read(input.workflow);
      // A live App whose Workflow was unpublished since names it with the reason (DP-0).
      if (!published) throw appWorkflowRefusalError("workflow_unavailable", input.workflow);
      const [trigger] = published.manifest.steps;
      if (trigger?.type !== "trigger" || !trigger.triggers.some(({ kind }) => kind === "manual")) {
        throw new AppError(
          "CONFLICT",
          `The Workflow '${published.manifest.id}' is not started by hand`,
          { reason: "no_manual_trigger" }
        );
      }
      return startByHand(published, input, "live");
    },

    // A test run starts from the trigger whatever its kinds: only a person starts one.
    async test({ draft, ...input }) {
      const issues = [
        ...(await workflowContinuationIssues(draft.manifest, operationCalls.registry)),
        ...workflowLimitIssues(draft.manifest, limitContext)
      ];
      if (issues.length > 0) throw workflowDefinitionRefusal(draft.manifest.id, issues);
      return startByHand(draft, input, "test");
    },

    async cancel(input) {
      const cancelled = await stores.transaction(async (tx) => {
        const known = await tx.workflowRuns.readRun({ clientInstanceId, id: input.runId });
        if (!known) return false;
        // Use the same lock order as claims and continuation settlement. A cancel queued
        // during handoff holds the Lauf root before any successor can claim its trigger.
        const chain = await waiting.lockChain(tx, known.id);
        if (!chain) return false;
        let run = chain.run;
        while (run.continuation?.successorRunId) {
          const successor = await tx.workflowRuns.lockRun({
            clientInstanceId,
            id: run.continuation.successorRunId
          });
          if (!successor) return false;
          run = successor;
        }
        const { cancelledBy } = input;
        const audit = {
          actor: auditActorFromIdentity(cancelledBy),
          correlationId: input.correlationId
        };
        const ended = await endRun(
          tx,
          run,
          {
            status: "cancelled",
            // The contract names a person here. A service principal that cancels is in the audit.
            ...(isAuthenticatedServicePrincipal(cancelledBy)
              ? {}
              : { cancelledBy: asUserId(cancelledBy.id) })
          },
          audit
        );
        if (!ended) return run.id;
        await tx.audit.appendAuditEvent({
          clientInstanceId,
          type: "workflow_run.cancelled",
          status: "success",
          ...audit,
          subject: run.id,
          metadata: {
            workflow: run.workflow,
            definitionRevisionId: run.definitionRevisionId,
            stepRunCount: run.stepRunCount
          }
        });
        return run.id;
      });
      if (!cancelled) return undefined;
      return stores.workflowRuns.readRunView({ clientInstanceId, id: cancelled });
    },

    ...createRunReads({ clientInstanceId, stores, definitions, stepSlots: options.stepSlots })
  };
}
