import { compileJsonSchema } from "@vivd-catalyst/connections";
import {
  AppError,
  WORKFLOW_RUN_JOB_KINDS,
  auditActorFromIdentity,
  createPlatformId,
  defineJobHandler,
  defineJobKind,
  isAuthenticatedServicePrincipal,
  isWorkflowRunEnded,
  subjectDedupeKey,
  type AuditActor,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type JobControl,
  type JsonValue,
  type OperationRunId,
  type PlatformStores,
  type RegisteredJobHandler,
  type StorePage,
  type WorkflowRun,
  type WorkflowRunError,
  type WorkflowRunView,
  type WorkflowStep,
  type WorkflowStepRun,
  type WorkflowStepRunId,
  type WorkflowStepRunRef,
  type WorkflowStepRunView
} from "@vivd-catalyst/core";
import { z } from "zod";
import {
  indexWorkflowSteps,
  workflowManifestFingerprint,
  type WorkflowStepIndex
} from "./definition";
import type { WorkflowDefinitionSource } from "./definition-source";
import { jsonBytes, jsonObjectSchema } from "./json";
import {
  WORKFLOW_RUN_LIMITS,
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
  WORKFLOW_STEP_JOB_LEASE_MS,
  WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  WORKFLOW_STEP_JOB_SLOTS,
  type WorkflowRunLimits
} from "./limits";
import {
  OperationStepFailure,
  callStepOperation,
  type WorkflowOperationCalls
} from "./operation-step";
import { itemLabelOf, resolveInput, resolveReference } from "./references";
import { workflowRunActor, workflowRunPrincipal } from "./run-identity";
import { WorkflowStepFailure } from "./step-failure";

// The engine of Workflow Runs. A run is a row, each step it reaches is a step run, and each
// step run is executed by one job of the shared executor. A step ends in the transaction
// that creates the step run after it and that step run's job, so a run is always either
// ended or has exactly the work queued that carries it on, whichever process dies when.

/** The job that executes one step run. Its payload names the step run and nothing else. */
export const workflowStepJobKind = defineJobKind({
  kind: WORKFLOW_RUN_JOB_KINDS.executeStep,
  payloadSchema: z.strictObject({ stepRunId: z.string().min(1) }),
  maxAttempts: WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  backoff: { baseMs: WORKFLOW_STEP_JOB_BACKOFF_BASE_MS, maxMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS },
  leaseMs: WORKFLOW_STEP_JOB_LEASE_MS,
  concurrency: {}
});

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
}

export interface StartWorkflowRunInput {
  workflow: string;
  input: unknown;
  /** Who starts the run. Its right opened the start; the run acts as its own principal. */
  startedBy: AuthenticatedIdentity;
  /** The Operation Run of the call that starts the run. */
  operationRunId?: OperationRunId;
  correlationId: string;
}

export interface WorkflowEngine {
  /** Starts a run of the published definition from its manual trigger. */
  start(input: StartWorkflowRunInput): Promise<WorkflowRunView>;
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
  listStepRuns(input: { runId: string; page?: StorePage }): Promise<WorkflowStepRunView[]>;
  /** What the job worker of the process serves for the engine. */
  jobHandlers: readonly RegisteredJobHandler[];
}

/** How the attempt of a step went, before anything of it is written. */
type StepEnd =
  | { kind: "done"; output: JsonValue; operationRunId?: OperationRunId }
  | { kind: "failed"; error: WorkflowRunError; operationRunId?: OperationRunId }
  /** A loop read its list. Its items are run by step runs of their own. */
  | { kind: "loop"; items: JsonValue[] };

/** Where a new step run stands in its run. */
interface StepPlace {
  key: string;
  parentStepRunId?: WorkflowStepRunId;
  iteration?: number;
  iterationLabel?: string;
}

function principalActor(run: WorkflowRun): AuditActor {
  return {
    displayLabel: run.principal.displayLabel,
    roles: [],
    principalKind: "service",
    principalId: run.principal.id,
    principalDisplayLabel: run.principal.displayLabel
  };
}

export function createWorkflowEngine(options: WorkflowEngineOptions): WorkflowEngine {
  const { clientInstanceId, stores, definitions, operationCalls } = options;
  const limits: WorkflowRunLimits = { ...WORKFLOW_RUN_LIMITS, ...options.limits };
  const now = options.now ?? (() => new Date());

  function withinStepData(value: JsonValue, what: string): void {
    if (jsonBytes(value) > limits.stepDataMaxBytes) {
      throw new WorkflowStepFailure(
        "step_data_too_large",
        `${what} is larger than ${limits.stepDataMaxBytes} bytes`
      );
    }
  }

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
    for (const open of await tx.workflowRuns.listOpenStepRuns({ clientInstanceId, id: run.id })) {
      if (open.status === "running") continue;
      await tx.workflowRuns.endStepRun({
        clientInstanceId,
        id: open.id,
        status: "cancelled",
        finishedAt
      });
      await tx.jobs.withdraw(workflowStepJobKind, {
        clientInstanceId,
        dedupeKey: subjectDedupeKey(workflowStepJobKind.kind, open.id)
      });
    }
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
        revision: run.revision,
        status: end.status,
        stepRunCount: run.stepRunCount,
        ...(end.error ? { errorCode: end.error.code } : {})
      }
    });
  }

  /** Fails a run at one step run, with the loops around that step run. */
  async function failRun(
    tx: PlatformStores,
    run: WorkflowRun,
    stepRun: WorkflowStepRun,
    error: WorkflowRunError
  ): Promise<void> {
    const finishedAt = now().toISOString();
    let around = stepRun.parentStepRunId;
    while (around !== undefined) {
      const loopRun = await tx.workflowRuns.getStepRun({ clientInstanceId, id: around });
      if (!loopRun) break;
      await tx.workflowRuns.endStepRun({
        clientInstanceId,
        id: loopRun.id,
        status: "failed",
        finishedAt,
        error: { code: "loop_step_failed", message: "A step of the loop failed" }
      });
      around = loopRun.parentStepRunId;
    }
    await finishRun(tx, run, {
      status: "failed",
      error: { code: error.code, message: error.message, stepRunId: stepRun.id }
    });
  }

  /**
   * Creates the step run of a step and the job that executes it. A run that has created as
   * many step runs as it may ends as `limit_reached` instead.
   */
  async function beginStep(
    tx: PlatformStores,
    run: WorkflowRun,
    step: WorkflowStep,
    place: StepPlace
  ): Promise<void> {
    if (run.stepRunCount >= limits.maxStepRuns) {
      await finishRun(tx, run, {
        status: "limit_reached",
        error: {
          code: "step_limit",
          message: `The run reached its limit of ${limits.maxStepRuns} steps`
        }
      });
      return;
    }
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
      parentStepRunId: loopRun.id,
      iteration,
      ...(label === undefined ? {} : { iterationLabel: label })
    };
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
      // The next step of the same sequence stands beside this one: same loop, same item.
      const prefix = stepRun.key.slice(0, stepRun.key.length - stepRun.stepId.length);
      await beginStep(tx, run, next, {
        key: `${prefix}${next.id}`,
        ...(stepRun.parentStepRunId === undefined
          ? {}
          : {
              parentStepRunId: stepRun.parentStepRunId,
              iteration: stepRun.iteration ?? 0,
              ...(stepRun.iterationLabel === undefined
                ? {}
                : { iterationLabel: stepRun.iterationLabel })
            })
      });
      return;
    }
    if (stepRun.parentStepRunId === undefined) return;
    // The last step of one item ended: the next item, or the end of the loop.
    const loopRef: WorkflowStepRunRef = { clientInstanceId, id: stepRun.parentStepRunId };
    const loopRun = await tx.workflowRuns.getStepRun(loopRef);
    const first = place.sequence.steps[0];
    if (!loopRun || !first) return;
    const iteration = (stepRun.iteration ?? 0) + 1;
    if (iteration < ((await tx.workflowRuns.countLoopItems(loopRef)) ?? 0)) {
      await beginStep(tx, run, first, await itemPlace(tx, index, loopRun, first, iteration));
      return;
    }
    const results = { ...loopRef, stepId: stepRun.stepId };
    if ((await tx.workflowRuns.measureLoopResults(results)) > limits.stepDataMaxBytes) {
      const error = {
        code: "step_data_too_large",
        message: `The results of the loop are larger than ${limits.stepDataMaxBytes} bytes`
      };
      await tx.workflowRuns.endStepRun({
        ...loopRef,
        status: "failed",
        finishedAt: now().toISOString(),
        error
      });
      await failRun(tx, run, loopRun, error);
      return;
    }
    await tx.workflowRuns.endStepRun({
      ...loopRef,
      status: "done",
      finishedAt: now().toISOString(),
      output: await tx.workflowRuns.listLoopResults(results)
    });
    await advance(tx, run, index, loopRun);
  }

  /**
   * Takes a step run up for one attempt. Answers nothing where there is nothing to execute:
   * the step run has ended, its run has ended, or the run is past its time.
   */
  async function claim(
    control: JobControl,
    ref: WorkflowStepRunRef
  ): Promise<{ run: WorkflowRun; stepRun: WorkflowStepRun } | undefined> {
    return control.transaction(async (tx) => {
      const found = await tx.workflowRuns.getStepRun(ref);
      if (!found) return undefined;
      const run = await tx.workflowRuns.lockRun({ clientInstanceId, id: found.runId });
      // Read again behind the lock: a cancel may have ended it in between.
      const stepRun = await tx.workflowRuns.getStepRun(ref);
      if (!run || !stepRun) return undefined;
      if (stepRun.status !== "queued" && stepRun.status !== "running") return undefined;
      const moment = now();
      const finishedAt = moment.toISOString();
      if (isWorkflowRunEnded(run.status)) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
        return undefined;
      }
      if (moment.getTime() >= Date.parse(run.deadlineAt)) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
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
      return { run, stepRun };
    });
  }

  /** Does the work of one step and writes nothing of it. */
  async function execute(
    run: WorkflowRun,
    stepRun: WorkflowStepRun,
    index: WorkflowStepIndex,
    signal: AbortSignal
  ): Promise<StepEnd> {
    const step = index.get(stepRun.stepId)?.step;
    const scope = { store: stores.workflowRuns, index, run, stepRun };
    try {
      switch (step?.type) {
        case "trigger": {
          const input = await stores.workflowRuns.readRunInput({ clientInstanceId, id: run.id });
          return { kind: "done", output: input ?? {} };
        }
        case "operation": {
          const input = await resolveInput(scope, step.input);
          withinStepData(input, "The input of the step");
          const actor = await workflowRunActor(stores.apiAccess, run);
          if (!actor) {
            throw new WorkflowStepFailure(
              "principal_inactive",
              "The service principal the run acts as no longer exists or is disabled"
            );
          }
          const result = await callStepOperation({
            calls: operationCalls,
            run,
            stepRun,
            operation: step.operation,
            input,
            actor,
            signal
          });
          try {
            withinStepData(result.output, "The output of the step");
          } catch (error) {
            if (!(error instanceof WorkflowStepFailure)) throw error;
            throw new OperationStepFailure(error.code, error.message, result.operationRunId);
          }
          return { kind: "done", ...result };
        }
        case "loop": {
          const items = await resolveReference(scope, step.items);
          if (!Array.isArray(items)) {
            throw new WorkflowStepFailure("loop_items_not_a_list", "A loop runs over a list");
          }
          if (items.length > limits.loopMaxItems) {
            throw new WorkflowStepFailure(
              "loop_too_long",
              `A loop runs over at most ${limits.loopMaxItems} items`
            );
          }
          withinStepData(items, "The list of the loop");
          return { kind: "loop", items };
        }
        case "output": {
          const output = await resolveInput(scope, step.input);
          withinStepData(output, "The result of the run");
          const schema = compileJsonSchema(run.definition.outputs);
          const [issue] = schema.ok ? schema.validate(output) : [];
          if (!schema.ok || issue) {
            throw new WorkflowStepFailure(
              "output_invalid",
              issue
                ? `The result does not fit the Workflow's outputs at '/${issue.path.join("/")}': ${issue.message}`
                : "The Workflow's outputs are a schema that cannot be checked"
            );
          }
          return { kind: "done", output };
        }
        default:
          throw new WorkflowStepFailure(
            "step_type_not_executed",
            `This release does not execute the step '${stepRun.stepId}'`
          );
      }
    } catch (error) {
      if (!(error instanceof WorkflowStepFailure)) throw error;
      const operationRunId =
        error instanceof OperationStepFailure ? error.operationRunId : undefined;
      return {
        kind: "failed",
        error: error.toRunError(),
        ...(operationRunId ? { operationRunId } : {})
      };
    }
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
    // A run that ended while the step worked keeps what the step did and starts nothing.
    const live = !isWorkflowRunEnded(run.status);
    const finishedAt = now().toISOString();
    if (end.kind === "failed") {
      const { kind: _kind, ...failure } = end;
      await tx.workflowRuns.endStepRun({ ...ref, status: "failed", finishedAt, ...failure });
      if (live) await failRun(tx, run, stepRun, end.error);
      return;
    }
    if (end.kind === "loop") {
      if (!live) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "cancelled", finishedAt });
        return;
      }
      const loop = index.get(stepRun.stepId)?.step;
      const inner = loop?.type === "loop" ? firstStepOf(index, loop.steps) : undefined;
      if (end.items.length === 0 || !inner) {
        await tx.workflowRuns.endStepRun({ ...ref, status: "done", finishedAt, output: [] });
        await advance(tx, run, index, stepRun);
        return;
      }
      await tx.workflowRuns.markLoopWaiting({ ...ref, items: end.items });
      await beginStep(tx, run, inner, await itemPlace(tx, index, stepRun, inner, 0));
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
      const index = indexWorkflowSteps(claimed.run.definition);
      const end = await execute(claimed.run, claimed.stepRun, index, control.signal);
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
      if (!isWorkflowRunEnded(run.status)) await failRun(tx, run, stepRun, error);
    }
  });

  return {
    jobHandlers: [stepHandler],

    async start(input) {
      const manifest = await definitions.read(input.workflow);
      if (!manifest) {
        throw new AppError("NOT_FOUND", `There is no Workflow '${input.workflow}'`);
      }
      const trigger = firstStepOf(indexWorkflowSteps(manifest), manifest.steps);
      if (trigger?.type !== "trigger" || !trigger.triggers.some(({ kind }) => kind === "manual")) {
        throw new AppError("CONFLICT", `The Workflow '${manifest.id}' is not started by hand`, {
          reason: "no_manual_trigger"
        });
      }
      const schema = compileJsonSchema(manifest.inputs);
      if (!schema.ok) {
        throw new AppError(
          "CONFLICT",
          "The Workflow's inputs are a schema that cannot be checked",
          {
            reason: "inputs_unreadable"
          }
        );
      }
      const runInput = jsonObjectSchema.safeParse(input.input ?? {});
      const issues = runInput.success ? schema.validate(runInput.data) : [];
      if (!runInput.success || issues.length > 0) {
        throw new AppError("VALIDATION_FAILED", "The input does not fit the Workflow's inputs", {
          issues: issues.map((issue) => ({ path: issue.path, message: issue.message }))
        });
      }
      if (jsonBytes(runInput.data) > limits.stepDataMaxBytes) {
        throw new AppError(
          "VALIDATION_FAILED",
          `The input of a run is at most ${limits.stepDataMaxBytes} bytes`
        );
      }
      const principal = await workflowRunPrincipal(stores.apiAccess, clientInstanceId, manifest);
      if (!principal) {
        throw new AppError(
          "CONFLICT",
          `The instance has no single active service principal named '${manifest.runAs}', which the Workflow '${manifest.id}' runs as`,
          { reason: "principal_inactive" }
        );
      }
      const { startedBy } = input;
      const createdAt = now();
      const id = createPlatformId<"WorkflowRunId">("wfr");
      await stores.transaction(async (tx) => {
        const run = await tx.workflowRuns.createRun({
          id,
          clientInstanceId,
          workflow: manifest.id,
          revision: workflowManifestFingerprint(manifest),
          mode: "live",
          trigger: "manual",
          definition: manifest,
          input: runInput.data,
          principal,
          startedBy: {
            kind: isAuthenticatedServicePrincipal(startedBy) ? "service_principal" : "user",
            id: startedBy.id,
            label: startedBy.displayLabel
          },
          ...(input.operationRunId ? { operationRunId: input.operationRunId } : {}),
          deadlineAt: new Date(createdAt.getTime() + limits.maxDurationMs).toISOString(),
          correlationId: input.correlationId,
          createdAt: createdAt.toISOString()
        });
        await beginStep(tx, run, trigger, { key: trigger.id });
        await tx.audit.appendAuditEvent({
          clientInstanceId,
          type: "workflow_run.started",
          status: "success",
          actor: auditActorFromIdentity(startedBy),
          subject: run.id,
          correlationId: run.correlationId,
          metadata: {
            workflow: run.workflow,
            revision: run.revision,
            trigger: run.trigger,
            mode: run.mode,
            principalId: run.principal.id
          }
        });
      });
      const view = await stores.workflowRuns.readRun({ clientInstanceId, id });
      if (!view) throw new AppError("INTERNAL", "The started Workflow Run cannot be read");
      return view;
    },

    async cancel(input) {
      const cancelled = await stores.transaction(async (tx) => {
        const known = await tx.workflowRuns.readRun({ clientInstanceId, id: input.runId });
        if (!known) return false;
        const run = await tx.workflowRuns.lockRun({ clientInstanceId, id: known.id });
        if (!run) return false;
        if (!(await endRun(tx, run, { status: "cancelled" }))) return true;
        await tx.audit.appendAuditEvent({
          clientInstanceId,
          type: "workflow_run.cancelled",
          status: "success",
          actor: auditActorFromIdentity(input.cancelledBy),
          subject: run.id,
          correlationId: input.correlationId,
          metadata: {
            workflow: run.workflow,
            revision: run.revision,
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

    async listStepRuns({ runId, page }) {
      const run = await stores.workflowRuns.readRun({ clientInstanceId, id: runId });
      if (!run) return [];
      return stores.workflowRuns.listStepRuns({
        clientInstanceId,
        runId: run.id,
        ...(page ? { page } : {})
      });
    }
  };
}

/** The first step of one sequence in the order it runs, which its wires may set. */
function firstStepOf(
  index: WorkflowStepIndex,
  written: readonly WorkflowStep[]
): WorkflowStep | undefined {
  const [any] = written;
  return any ? index.get(any.id)?.sequence.steps[0] : undefined;
}
