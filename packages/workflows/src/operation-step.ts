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
  type WorkflowStepRun,
  type WorkflowStepRunCall
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

/** What a step run keeps of the call it made beside its outcome. */
interface OperationStepTrace {
  operationRunId?: OperationRunId;
  /** What the operation does and the name of what it belongs to, once it is resolved. */
  call?: WorkflowStepRunCall;
}

export interface OperationStepResult extends OperationStepTrace {
  output: JsonValue;
}

/** A step failure that names the Operation Run it came from and what was called. */
export class OperationStepFailure extends WorkflowStepFailure {
  readonly trace: OperationStepTrace;

  constructor(code: string, message: string, trace: OperationStepTrace = {}) {
    super(code, message);
    this.name = "OperationStepFailure";
    this.trace = trace;
  }
}

const traceOf = (
  call: WorkflowStepRunCall,
  operationRunId: OperationRunId | undefined
): OperationStepTrace => ({ call, ...(operationRunId ? { operationRunId } : {}) });

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
  // What the call touches is read as the call path reads it: from the input the operation's
  // own schema accepts. An input it refuses names nothing, and the call below says why.
  const accepted = definition.inputSchema.safeParse(input.input);
  const touched = accepted.success ? definition.resource(accepted.data) : undefined;
  const source = touched?.name ?? touched?.id;
  const made: WorkflowStepRunCall = {
    effect: definition.effect,
    ...(source === undefined ? {} : { source })
  };
  const { approvals: _notHeld, ...deps } = calls.deps;
  let outcome;
  try {
    outcome = await runOperation(call, deps, { signal: input.signal });
  } catch (error) {
    throw refusalOf(error, operation, made) ?? error;
  }
  const { result } = outcome;
  const trace = traceOf(made, outcome.unrecorded ? undefined : result.runId);
  switch (result.status) {
    case "done": {
      const output = jsonValueSchema.safeParse(result.output ?? null);
      if (!output.success) {
        throw new OperationStepFailure(
          "output_not_json",
          `The operation '${operation}' answered a value that is not JSON`,
          trace
        );
      }
      return { output: output.data, ...trace };
    }
    case "denied": {
      const refusal = operationDenialError(result.reason);
      throw new OperationStepFailure(refusal.code, refusal.message, trace);
    }
    case "failed":
      // The sentence of the error can quote the outside system. The Operation Run keeps it.
      throw new OperationStepFailure(
        result.error.code,
        `The operation '${operation}' failed`,
        trace
      );
    case "expired":
    case "pending_approval":
    case "pending_confirmation":
      throw new OperationStepFailure(
        "operation_would_wait",
        `The operation '${operation}' waits for a decision, which a Workflow Run cannot do`,
        trace
      );
  }
}

/**
 * The step failure of an error the call path threw before a run answered, where another
 * attempt would be refused the same way. Any other error is left to the next attempt.
 */
function refusalOf(
  error: unknown,
  operation: string,
  call: WorkflowStepRunCall
): OperationStepFailure | undefined {
  if (!isAppError(error)) return undefined;
  if (error.code === "OPERATION_IN_PROGRESS") {
    // The first call with this key still runs: the next attempt asks again. Only a first
    // call that was interrupted never answers, and nobody knows what it changed.
    return interruptedSchema.safeParse(error.details).success
      ? new OperationStepFailure(
          "operation_interrupted",
          `The call of '${operation}' was interrupted and its outcome is not known`,
          { call }
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
      `The input of the step does not fit the operation '${operation}'`,
      { call }
    );
  }
  return error instanceof AppError && error.statusCode === 403
    ? new OperationStepFailure(error.code, error.message, { call })
    : undefined;
}
