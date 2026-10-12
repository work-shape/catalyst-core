import { compileJsonSchema } from "@vivd-catalyst/connections";
import {
  WORKFLOW_DATASET_KEY,
  operationDenialError,
  workflowDatasetReferenceSchema,
  workflowStepIdempotencyKey,
  type ClientInstanceId,
  type JsonValue,
  type OperationRunId,
  type PlatformStores,
  type WorkflowManifest,
  type WorkflowRun,
  type WorkflowRunError,
  type WorkflowStepRun,
  type WorkflowStepRunCall,
  type WorkflowStepRunEnd,
  type WorkflowTriggerOutput
} from "@vivd-catalyst/core";
import type { WorkflowStepIndex } from "./definition";
import { holdsBrokenDatasetReference, jsonBytes } from "./json";
import {
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
  type WorkflowRunLimits
} from "./limits";
import {
  OperationStepFailure,
  callStepOperation,
  notSupportedFailure,
  type WorkflowOperationCalls
} from "./operation-step";
import { resolveInput, resolveReference } from "./references";
import { workflowRunActor } from "./run-identity";
import { WorkflowStepFailure } from "./step-failure";

// The work of one step, without anything of it written: the engine writes how it went and
// what follows it in one transaction of its own.

/** How the attempt of a step went, before anything of it is written. */
export type StepEnd =
  | { kind: "done"; output: JsonValue; operationRunId?: OperationRunId; call?: WorkflowStepRunCall }
  | {
      kind: "failed";
      error: WorkflowRunError;
      operationRunId?: OperationRunId;
      call?: WorkflowStepRunCall;
      /** The run's principal itself was refused: no loop continues past this failure. */
      ofPrincipal: boolean;
    }
  /** A loop read its list. Its items are run by step runs of their own. */
  | { kind: "loop"; items: JsonValue[] };

export interface StepExecutorOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  operationCalls: WorkflowOperationCalls;
  limits: WorkflowRunLimits;
  now(): Date;
}

/** What one attempt of a step is given: its run, the run's definition and the attempt's end. */
export interface StepAttempt {
  run: WorkflowRun;
  stepRun: WorkflowStepRun;
  definition: WorkflowManifest;
  index: WorkflowStepIndex;
  signal: AbortSignal;
}

export function createStepExecutor(options: StepExecutorOptions) {
  const { clientInstanceId, stores, operationCalls, limits, now } = options;

  function withinStepData(value: JsonValue, what: string): void {
    if (jsonBytes(value) > limits.stepDataMaxBytes) {
      throw new WorkflowStepFailure(
        "step_data_too_large",
        `${what} is larger than ${limits.stepDataMaxBytes} bytes`
      );
    }
    if (holdsBrokenDatasetReference(value)) {
      throw new WorkflowStepFailure(
        "dataset_reference_invalid",
        `${what} holds '${WORKFLOW_DATASET_KEY}' on a value that is no reference to a dataset`
      );
    }
  }

  /** Does the work of one step and writes nothing of it but the id of its Operation Run. */
  async function execute(attempt: StepAttempt): Promise<StepEnd> {
    const { run, stepRun, index, signal } = attempt;
    const step = index.get(stepRun.stepId)?.step;
    const scope = { store: stores.workflowRuns, index, run, stepRun };
    try {
      switch (step?.type) {
        case "trigger": {
          // A definition another release stored may name a trigger no engine fires yet.
          const other = step.triggers.find((trigger) => trigger.kind !== "manual");
          if (other) throw notSupportedFailure(`the trigger '${other.kind}'`);
          const input = await stores.workflowRuns.readRunInput({ clientInstanceId, id: run.id });
          const output: WorkflowTriggerOutput = {
            input: input ?? {},
            startedAt: run.startedAt ?? run.createdAt,
            trigger: run.trigger,
            // Only a tick of a schedule has a scheduled time, and no run is started by one yet.
            scheduledFor: null
          };
          return { kind: "done", output: { ...output } };
        }
        case "operation": {
          for (const field of ["dataset", "paginate"] as const) {
            if (step[field] !== undefined) throw notSupportedFailure(`'${field}' on a step`);
          }
          const input = await resolveInput(scope, step.input);
          withinStepData(input, "The input of the step");
          const actor = await workflowRunActor(stores.apiAccess, run);
          if (!actor) {
            throw new WorkflowStepFailure(
              "principal_inactive",
              "The service principal the run acts as no longer exists or is disabled",
              { ofPrincipal: true }
            );
          }
          const result = await callStepOperation({
            calls: operationCalls,
            run,
            stepRun,
            operation: step.operation,
            input,
            actor,
            signal,
            wait: {
              waitMs: limits.operationOutcomeWaitMs,
              // The backoff of the step's job, and at least four looks within the wait.
              pollMs: Math.min(
                WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
                Math.ceil(limits.operationOutcomeWaitMs / 4)
              ),
              maxPollMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
              now
            },
            noteOperationRun: (operationRunId) =>
              stores.workflowRuns.noteStepRunOperation({
                clientInstanceId,
                id: stepRun.id,
                operationRunId
              })
          });
          const { output, ...trace } = result;
          try {
            withinStepData(output, "The output of the step");
          } catch (error) {
            if (!(error instanceof WorkflowStepFailure)) throw error;
            throw new OperationStepFailure(error.code, error.message, trace);
          }
          return { kind: "done", ...result };
        }
        case "loop": {
          if (step.collect !== undefined) throw notSupportedFailure("'collect' on a loop");
          if ((step.concurrency ?? 1) !== 1) {
            throw notSupportedFailure("a loop with 'concurrency' above 1");
          }
          const items = await resolveReference(scope, step.items);
          if (workflowDatasetReferenceSchema.safeParse(items).success) {
            throw notSupportedFailure("a loop over a dataset");
          }
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
          const schema = compileJsonSchema(attempt.definition.outputs);
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
          // A reserved block, a step type of a later release, or a step the run's definition
          // does not hold: the step fails with the contract's refusal, and so does its run.
          throw notSupportedFailure(
            `the step '${stepRun.stepId}' of the type '${stepRun.stepType}'`
          );
      }
    } catch (error) {
      if (!(error instanceof WorkflowStepFailure)) throw error;
      return {
        kind: "failed",
        error: error.toRunError(),
        ofPrincipal: error.ofPrincipal,
        ...(error instanceof OperationStepFailure ? error.trace : {})
      };
    }
  }

  /**
   * What is known of the call of an operation step whose attempt nobody ended, read from the
   * Operation Run under the step run's key. A cancel or a limit ended the run while the
   * step's worker was gone; the step run then says what its call did and not that nothing
   * happened. Answers nothing where no call was recorded.
   */
  async function knownCallEnd(
    tx: PlatformStores,
    run: WorkflowRun,
    stepRun: WorkflowStepRun,
    finishedAt: string
  ): Promise<WorkflowStepRunEnd | undefined> {
    if (stepRun.stepType !== "operation") return undefined;
    const first = await tx.operationRuns.findByIdempotencyKey({
      clientInstanceId,
      actor: { kind: "service_principal", id: run.principal.id },
      idempotencyKey: workflowStepIdempotencyKey(stepRun.id)
    });
    if (!first) return undefined;
    const kept = { finishedAt, operationRunId: first.id, call: { effect: first.effect } };
    switch (first.status) {
      case "done":
        return { ...kept, status: "done", ...(first.output ? { output: first.output.value } : {}) };
      case "denied": {
        const refusal = first.denial ? operationDenialError(first.denial) : undefined;
        return {
          ...kept,
          status: "failed",
          error: {
            code: refusal?.code ?? "FORBIDDEN",
            message: refusal?.message ?? `The call of '${first.operation}' was refused`
          }
        };
      }
      case "failed":
        return {
          ...kept,
          status: "failed",
          error: {
            code: first.error?.code ?? "operation_failed",
            message: `The operation '${first.operation}' failed`
          }
        };
      default:
        // Still without an outcome: the step run names the call, and its end is not known.
        return { ...kept, status: "cancelled" };
    }
  }

  return { execute, knownCallEnd };
}
