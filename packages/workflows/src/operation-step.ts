import {
  AppError,
  isAppError,
  operationDenialError,
  workflowStepIdempotencyKey,
  type AuthenticatedIdentity,
  type JsonObject,
  type JsonValue,
  type OperationCall,
  type OperationRegistry,
  type OperationRunId,
  type WorkflowRun,
  type WorkflowStepRun
} from "@vivd-catalyst/core";
import { runOperation, type RunOperationDeps } from "@vivd-catalyst/tool-execution";
import { z } from "zod";
import { jsonValueSchema } from "./json";
import { WorkflowStepFailure } from "./step-failure";

// The call an operation step makes. It takes the one call path, so it is checked, recorded
// and answered like every other call of the operation: the right is the run's principal's,
// the policy is asked for the origin `workflow`, and the call leaves an Operation Run.

/** The call path of the instance, as the engine uses it. */
export interface WorkflowOperationCalls {
  registry: OperationRegistry;
  deps: RunOperationDeps;
}

export interface OperationStepResult {
  output: JsonValue;
  operationRunId?: OperationRunId;
}

/** A step failure that names the Operation Run it came from. */
export class OperationStepFailure extends WorkflowStepFailure {
  readonly operationRunId: OperationRunId | undefined;

  constructor(code: string, message: string, operationRunId?: OperationRunId) {
    super(code, message);
    this.name = "OperationStepFailure";
    this.operationRunId = operationRunId;
  }
}

const interruptedSchema = z.object({ interrupted: z.literal(true) });

/**
 * Calls the operation of one step run as the run's principal. A changing call carries the
 * key of the step run, so an attempt that runs the step again changes nothing twice: it is
 * answered with what the first call answered.
 *
 * A call that the policy would hold for an approval is refused instead of filed. Nothing in
 * this release takes a run up again when somebody decides, so a held call would never run.
 */
export async function callStepOperation(input: {
  calls: WorkflowOperationCalls;
  run: WorkflowRun;
  stepRun: WorkflowStepRun;
  operation: string;
  input: JsonObject;
  actor: AuthenticatedIdentity;
  signal: AbortSignal;
}): Promise<OperationStepResult> {
  const { calls, run, stepRun, operation } = input;
  const definition = await calls.registry.resolve(operation);
  if (!definition) {
    throw new OperationStepFailure(
      "operation_not_found",
      `The operation '${operation}' does not exist on this instance`
    );
  }
  const call: OperationCall = {
    operation,
    effect: definition.effect,
    input: input.input,
    actor: input.actor,
    origin: { kind: "workflow", workflowRunId: run.id, stepRunId: stepRun.id },
    correlationId: run.correlationId,
    ...(definition.effect === "changing"
      ? { idempotencyKey: workflowStepIdempotencyKey(stepRun.id) }
      : {})
  };
  const { approvals: _notHeld, ...deps } = calls.deps;
  let outcome;
  try {
    outcome = await runOperation(call, deps, { signal: input.signal });
  } catch (error) {
    throw refusalOf(error, operation) ?? error;
  }
  const { result } = outcome;
  const operationRunId = outcome.unrecorded ? undefined : result.runId;
  switch (result.status) {
    case "done": {
      const output = jsonValueSchema.safeParse(result.output ?? null);
      if (!output.success) {
        throw new OperationStepFailure(
          "output_not_json",
          `The operation '${operation}' answered a value that is not JSON`,
          operationRunId
        );
      }
      return { output: output.data, ...(operationRunId ? { operationRunId } : {}) };
    }
    case "denied": {
      const refusal = operationDenialError(result.reason);
      throw new OperationStepFailure(refusal.code, refusal.message, operationRunId);
    }
    case "failed":
      // The sentence of the error can quote the outside system. The Operation Run keeps it.
      throw new OperationStepFailure(
        result.error.code,
        `The operation '${operation}' failed`,
        operationRunId
      );
    case "expired":
    case "pending_approval":
    case "pending_confirmation":
      throw new OperationStepFailure(
        "operation_would_wait",
        `The operation '${operation}' waits for a decision, which a Workflow Run cannot do`,
        operationRunId
      );
  }
}

/**
 * The step failure of an error the call path threw before a run answered, where another
 * attempt would be refused the same way. Any other error is left to the next attempt.
 */
function refusalOf(error: unknown, operation: string): OperationStepFailure | undefined {
  if (!isAppError(error)) return undefined;
  if (error.code === "OPERATION_IN_PROGRESS") {
    // The first call with this key still runs: the next attempt asks again. Only a first
    // call that was interrupted never answers, and nobody knows what it changed.
    return interruptedSchema.safeParse(error.details).success
      ? new OperationStepFailure(
          "operation_interrupted",
          `The call of '${operation}' was interrupted and its outcome is not known`
        )
      : undefined;
  }
  if (error.code === "NOT_FOUND") {
    return new OperationStepFailure(
      "operation_not_found",
      `The operation '${operation}' does not exist on this instance`
    );
  }
  if (error.code === "VALIDATION_FAILED") {
    return new OperationStepFailure(
      "operation_input_invalid",
      `The input of the step does not fit the operation '${operation}'`
    );
  }
  return error instanceof AppError && error.statusCode === 403
    ? new OperationStepFailure(error.code, error.message)
    : undefined;
}
