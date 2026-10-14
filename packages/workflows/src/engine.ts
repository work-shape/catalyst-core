import {
  AppError,
  asUserId,
  auditActorFromIdentity,
  createPlatformId,
  defineJobHandler,
  isAuthenticatedServicePrincipal,
  isWorkflowRunEnded,
  subjectDedupeKey,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type JobControl,
  type JobSchedule,
  type JsonValue,
  type PlatformStores,
  type RegisteredJobHandler,
  type StorePage,
  type WorkflowCodeOutcome,
  type WorkflowLastRun,
  type WorkflowLoopOutput,
  type WorkflowRun,
  type WorkflowRunError,
  type WorkflowRunView,
  type WorkflowStep,
  type WorkflowStepRun,
  type WorkflowStepRunFilter,
  type WorkflowStepRunPlacement,
  type WorkflowStepRunRef,
  type WorkflowStepRunView
} from "@vivd-catalyst/core";
import { noWorkflowStepFiles, type WorkflowStepFiles } from "./code-step";
import {
  WORKFLOW_STEP_DATA_DAYS,
  createWorkflowDataPruning,
  type WorkflowDataPruning,
  type WorkflowDataPruningOptions
} from "./data-pruning";
import { indexWorkflowSteps, type WorkflowStepIndex } from "./definition";
import type { WorkflowDefinitionSource, WorkflowDefinitionSummary } from "./definition-source";
import { WORKFLOW_RUN_LIMITS, WORKFLOW_STEP_JOB_SLOTS, type WorkflowRunLimits } from "./limits";
import type { WorkflowOperationCalls } from "./operation-step";
import { itemLabelOf } from "./references";
import { principalActor } from "./run-identity";
import { loopConcurrencyOf, withEveryBodyStep } from "./run-view";
import { createBlockEnds } from "./run-blocks";
import {
  createRunOpening,
  type StartWorkflowRunInput,
  type TestWorkflowRunInput
} from "./run-open";
import { createStartCheck } from "./run-start";
import { createScheduleTrigger } from "./schedule-trigger";
import { workflowCodeJobKind, workflowStepJobKind } from "./step-job";
import { createScheduledStart } from "./scheduled-start";
import { createStepExecutor, type StepEnd, type WorkflowCodeRunner } from "./step-execution";

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
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  /** Where the published definition of a Workflow is read when a run is started. */
  definitions: WorkflowDefinitionSource;
  /** The call path of the instance. An operation step calls through it and nothing else. */
  operationCalls: WorkflowOperationCalls;
  /** Bounds below the release's own, for a test. */
  limits?: Partial<WorkflowRunLimits>;
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
   * Ends a run as `cancelled`. No further step starts. A call a step is making finishes and
   * is recorded on its step run. A run that has ended is answered as it is.
   */
  cancel(input: {
    runId: string;
    cancelledBy: AuthenticatedIdentity;
    correlationId: string;
  }): Promise<WorkflowRunView | undefined>;
  readRun(runId: string): Promise<WorkflowRunView | undefined>;
  listRuns(input: { workflow: string; page?: StorePage }): Promise<WorkflowRunView[]>;
  /** The step runs of a run: all of them, or those of one block, status or item of a loop. */
  listStepRuns(input: {
    runId: string;
    filter?: WorkflowStepRunFilter;
    page?: StorePage;
  }): Promise<WorkflowStepRunView[]>;
  /** The Workflows with a published definition, each with its latest run where it has one. */
  listWorkflows(): Promise<(WorkflowDefinitionSummary & { lastRun?: WorkflowLastRun })[]>;
  /**
   * Makes sure every published Workflow with a `schedule` trigger has the job of its next due
   * time. A process calls it when it starts, and whoever publishes a definition calls it then.
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

/** Where a new step run stands in its run: its path, and its place in the tree of the run. */
interface StepPlace extends WorkflowStepRunPlacement {
  key: string;
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const { clientInstanceId, stores, definitions, operationCalls } = options;
  const limits: WorkflowRunLimits = { ...WORKFLOW_RUN_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());

  const { cancelWaiting, insideEndedBlock } = createBlockEnds({ clientInstanceId, now });
  const stepFiles = options.stepFiles ?? noWorkflowStepFiles;
  const executor = createStepExecutor({
    clientInstanceId,
    stores,
    operationCalls,
    limits,
    now,
    stepFiles,
    ...(options.codeRunner ? { codeRunner: options.codeRunner } : {})
  });

  /**
   * Ends a run that has not ended, with every step run that still waits for its turn. A
   * step run that is running is left to its attempt, which records how its call went and
   * starts nothing after it. Answers whether this call ended the run.
   */
  async function endRun(
    tx: PlatformStores,
    run: WorkflowRun,
    end: {
      status: "done" | "failed" | "cancelled" | "limit_reached";
      output?: JsonValue;
      error?: WorkflowRunError;
      cancelledBy?: WorkflowRun["cancelledBy"];
    }
  ): Promise<boolean> {
    const finishedAt = now().toISOString();
    const ended = await tx.workflowRuns.endRun({
      clientInstanceId,
      id: run.id,
      finishedAt,
      ...end
    });
    if (!ended) return false;
    await cancelWaiting(tx, run);
    return true;
  }

  /** Ends a run the engine ends itself, and writes that it ended. Never a value of the run. */
  async function finishRun(
    tx: PlatformStores,
    run: WorkflowRun,
    end: Parameters<typeof endRun>[2]
  ): Promise<void> {
    if (!(await endRun(tx, run, end))) return;
    await tx.audit.appendAuditEvent({
      clientInstanceId,
      type: "workflow_run.ended",
      status: end.status === "done" ? "success" : "failed",
      actor: principalActor(run),
      subject: run.id,
      correlationId: run.correlationId,
      metadata: {
        workflow: run.workflow,
        definitionRevisionId: run.definitionRevisionId,
        status: end.status,
        stepRunCount: run.stepRunCount,
        ...(end.error ? { errorCode: end.error.code } : {})
      }
    });
  }

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

  /**
   * Creates the step run of a step and the job that executes it. A run that has created as
   * many step runs as it may ends as `limit_reached` instead, and this answers false: whoever
   * begins several steps in one transaction begins none after that.
   */
  async function beginStep(
    tx: PlatformStores,
    run: WorkflowRun,
    step: WorkflowStep,
    place: StepPlace
  ): Promise<boolean> {
    if (run.stepRunCount >= limits.maxStepRuns) {
      await finishRun(tx, run, {
        status: "limit_reached",
        error: {
          code: "step_limit",
          message: `The run reached its limit of ${limits.maxStepRuns} steps`
        }
      });
      return false;
    }
    // The run was read when its row was locked: what this transaction adds is counted here.
    run.stepRunCount += 1;
    // A step run is created between two steps, and so between two items of a loop. `claim`
    // starts none of a run that was cancelled or is past its time.
    const stepRun = await tx.workflowRuns.createStepRun({
      id: createPlatformId<"WorkflowStepRunId">("wfs"),
      clientInstanceId,
      runId: run.id,
      stepId: step.id,
      stepType: step.type,
      createdAt: now().toISOString(),
      ...place
    });
    await tx.jobs.enqueue(
      workflowStepJobKind,
      { stepRunId: stepRun.id },
      {
        clientInstanceId,
        subject: stepRun.id,
        dedupeKey: subjectDedupeKey(workflowStepJobKind.kind, stepRun.id),
        // What one run has running is counted by its id, for the slice that runs the items
        // of a loop side by side and bounds them per run.
        concurrencyKey: run.id,
        correlationId: run.correlationId
      }
    );
    return true;
  }

  /** Where the first step of one item of a loop stands, with what labels the item. */
  async function itemPlace(
    tx: PlatformStores,
    index: WorkflowStepIndex,
    loopRun: WorkflowStepRun,
    first: WorkflowStep,
    iteration: number
  ): Promise<StepPlace> {
    const loop = index.get(loopRun.stepId)?.step;
    const item =
      loop?.type === "loop" && loop.itemLabel !== undefined
        ? await tx.workflowRuns.readLoopItem({ clientInstanceId, id: loopRun.id, index: iteration })
        : undefined;
    const label =
      item && loop?.type === "loop" && loop.itemLabel !== undefined
        ? itemLabelOf(item.value, loop.itemLabel)
        : undefined;
    return {
      key: `${loopRun.key}[${iteration}].${first.id}`,
      containerStepRunId: loopRun.id,
      iteration: { index: iteration, ...(label === undefined ? {} : { label }) }
    };
  }

  /**
   * Carries a loop on after it read its list and after each item that ended: starts the next
   * items in the order of the list while fewer than the loop's `concurrency` are going, and
   * ends the loop when none is going and none is left. It runs behind the lock of the run, so
   * two items that end at the same moment start two different next items. The loop's output
   * is its counts as they then stand, the failed items it continued past among them, and
   * never a result of an item.
   */
  async function fillLoop(
    tx: PlatformStores,
    run: WorkflowRun,
    index: WorkflowStepIndex,
    loopRun: WorkflowStepRun
  ): Promise<void> {
    const loopRef: WorkflowStepRunRef = { clientInstanceId, id: loopRun.id };
    const loop = index.get(loopRun.stepId)?.step;
    const first = loop?.type === "loop" ? loop.steps[0] : undefined;
    // A definition nothing checked may name more than a loop may run at once.
    const width = loop?.type === "loop" ? loopConcurrencyOf(loop) : 1;
    const total = (await tx.workflowRuns.countLoopItems(loopRef)) ?? 0;
    let started = await tx.workflowRuns.countLoopItemsStarted(loopRef);
    let going = (await tx.workflowRuns.readLoopCounts(loopRef))?.running ?? 0;
    while (first && started < total && going < width) {
      const place = await itemPlace(tx, index, loopRun, first, started);
      // The run ended at its limit of step runs: no further item starts.
      if (!(await beginStep(tx, run, first, place))) return;
      started += 1;
      going += 1;
    }
    if (going > 0) return;
    const counts = await tx.workflowRuns.readLoopCounts(loopRef);
    const output: WorkflowLoopOutput = {
      total: counts?.total ?? 0,
      done: counts?.done ?? 0,
      failed: counts?.failed ?? 0
    };
    await tx.workflowRuns.endStepRun({
      ...loopRef,
      status: "done",
      finishedAt: now().toISOString(),
      output: { ...output }
    });
    await advance(tx, run, index, loopRun);
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
      await beginStep(tx, run, next, {
        key: `${prefix}${next.id}`,
        ...(containerStepRunId === undefined ? {} : { containerStepRunId }),
        ...(branch === undefined ? {} : { branch }),
        ...(iteration === undefined ? {} : { iteration })
      });
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

  /**
   * Takes a step run up for one attempt. Answers nothing where there is nothing to execute:
   * the step run has ended, its run has ended, or the run is past its time.
   */
  async function claim(
    control: JobControl,
    ref: WorkflowStepRunRef
  ): Promise<
    { run: WorkflowRun; stepRun: WorkflowStepRun; afterCode?: WorkflowCodeOutcome } | undefined
  > {
    return control.transaction(async (tx) => {
      const found = await tx.workflowRuns.getStepRun(ref);
      if (!found) return undefined;
      const run = await tx.workflowRuns.lockRun({ clientInstanceId, id: found.runId });
      // Read again behind the lock: a cancel may have ended it in between.
      const stepRun = await tx.workflowRuns.getStepRun(ref);
      if (!run || !stepRun) return undefined;
      // A code step waits while the command worker runs its script, and is taken up again
      // when the script has ended. Nothing else that waits is executed by a step job.
      const afterCode =
        stepRun.status === "waiting" && stepRun.stepType === "code"
          ? await tx.workflowRuns.readCodeOutcome(ref)
          : undefined;
      if (stepRun.status !== "queued" && stepRun.status !== "running" && !afterCode) {
        return undefined;
      }
      const moment = now();
      const finishedAt = moment.toISOString();
      const ended = isWorkflowRunEnded(run.status);
      if (ended || moment.getTime() >= Date.parse(run.deadlineAt)) {
        // The step does not run: its run was cancelled or ended, or is past its time. An
        // attempt nobody ended may have made its call before its worker was gone, and then
        // the step run says what the call did and not that nothing happened.
        const known =
          stepRun.status === "running"
            ? await executor.knownCallEnd(tx, run, stepRun, finishedAt)
            : undefined;
        await tx.workflowRuns.endStepRun({
          ...ref,
          ...(known ?? { status: "cancelled", finishedAt })
        });
        if (ended) return undefined;
        await finishRun(tx, run, {
          status: "limit_reached",
          error: {
            code: "duration_limit",
            message: `The run did not end within ${limits.maxDurationMs} milliseconds`,
            stepRunId: stepRun.id
          }
        });
        return undefined;
      }
      await tx.workflowRuns.markRunRunning({ clientInstanceId, id: run.id, startedAt: finishedAt });
      await tx.workflowRuns.markStepRunRunning({
        ...ref,
        attempt: control.attempt,
        startedAt: finishedAt
      });
      // The first step of a run starts it: the trigger step hands that moment on.
      return {
        run: { ...run, startedAt: run.startedAt ?? finishedAt },
        stepRun,
        ...(afterCode ? { afterCode } : {})
      };
    });
  }

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
        ...(last === undefined ? {} : { lastStepId: last })
      });
      await fillLoop(tx, run, index, stepRun);
      return;
    }
    const { kind: _kind, ...done } = end;
    await tx.workflowRuns.endStepRun({ ...ref, status: "done", finishedAt, ...done });
    if (!live) return;
    if (stepRun.stepType === "output") {
      await finishRun(tx, run, { status: "done", output: end.output });
      return;
    }
    await advance(tx, run, index, stepRun);
  }

  const stepHandler = defineJobHandler({
    kind: workflowStepJobKind,
    slots: WORKFLOW_STEP_JOB_SLOTS,
    async run(job, control) {
      const ref: WorkflowStepRunRef = { clientInstanceId, id: job.payload.stepRunId };
      const claimed = await claim(control, ref);
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
        ? executor.finishCode(attempt, claimed.afterCode)
        : await executor.execute(attempt);
      // A worker that stops, or that lost its lease, ends no step: what its cut attempt
      // answered is no outcome of the step. The step run stays as it is and the next attempt
      // takes it up, which reads again or is answered what a changing call answered.
      if (control.signal.aborted) {
        throw control.signal.reason instanceof Error
          ? control.signal.reason
          : new Error("The attempt was stopped");
      }
      await control.transaction((tx) => settle(tx, ref, index, end));
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

  const prepareStart = createStartCheck({ clientInstanceId, stores, operationCalls, limits });

  const { openRun, startByHand } = createRunOpening({
    clientInstanceId,
    stores,
    limits,
    now,
    stepFiles,
    prepareStart,
    beginTrigger: (tx, run, trigger) => beginStep(tx, run, trigger, { key: trigger.id })
  });

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
    now
  });

  return {
    jobHandlers: [stepHandler, schedule.handler, pruning.handler],
    jobSchedules: [pruning.schedule],
    pruneRunData: pruning.prune,
    planSchedules: schedule.plan,
    planSchedule: schedule.planOne,

    async start(input) {
      const published = await definitions.read(input.workflow);
      if (!published) {
        throw new AppError("NOT_FOUND", `There is no Workflow '${input.workflow}'`);
      }
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
    test: ({ draft, ...input }) => startByHand(draft, input, "test"),

    async cancel(input) {
      const cancelled = await stores.transaction(async (tx) => {
        const known = await tx.workflowRuns.readRun({ clientInstanceId, id: input.runId });
        if (!known) return false;
        const run = await tx.workflowRuns.lockRun({ clientInstanceId, id: known.id });
        if (!run) return false;
        const { cancelledBy } = input;
        const ended = await endRun(tx, run, {
          status: "cancelled",
          // The contract names a person here. A service principal that cancels is in the audit.
          ...(isAuthenticatedServicePrincipal(cancelledBy)
            ? {}
            : { cancelledBy: asUserId(cancelledBy.id) })
        });
        if (!ended) return true;
        await tx.audit.appendAuditEvent({
          clientInstanceId,
          type: "workflow_run.cancelled",
          status: "success",
          actor: auditActorFromIdentity(input.cancelledBy),
          subject: run.id,
          correlationId: input.correlationId,
          metadata: {
            workflow: run.workflow,
            definitionRevisionId: run.definitionRevisionId,
            stepRunCount: run.stepRunCount
          }
        });
        return true;
      });
      if (!cancelled) return undefined;
      return stores.workflowRuns.readRun({ clientInstanceId, id: input.runId });
    },

    readRun: (runId) => stores.workflowRuns.readRun({ clientInstanceId, id: runId }),

    listRuns: ({ workflow, page }) =>
      stores.workflowRuns.listRuns({ clientInstanceId, workflow, ...(page ? { page } : {}) }),

    async listStepRuns({ runId, filter, page }) {
      const run = await stores.workflowRuns.readRun({ clientInstanceId, id: runId });
      if (!run) return [];
      const stepRuns = await stores.workflowRuns.listStepRuns({
        clientInstanceId,
        runId: run.id,
        ...(filter ? { filter } : {}),
        ...(page ? { page } : {})
      });
      if (!stepRuns.some((stepRun) => stepRun.bodyCounts)) return stepRuns;
      const definition = await stores.workflowRuns.readRunDefinition({
        clientInstanceId,
        id: run.id
      });
      return definition ? withEveryBodyStep(stepRuns, definition) : stepRuns;
    },

    async listWorkflows() {
      const summaries = await definitions.list();
      const last = await stores.workflowRuns.listLastRuns({
        clientInstanceId,
        workflows: summaries.map((summary) => summary.id)
      });
      return summaries.map((summary) => {
        const lastRun = last.get(summary.id);
        return { ...summary, ...(lastRun ? { lastRun } : {}) };
      });
    }
  };
}
