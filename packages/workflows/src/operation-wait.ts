import { batchResultError } from "./batch-result";
import {
  workflowDurationMs,
  workflowDurationSchema,
  type JsonValue,
  type OperationDefinition,
  type OperationRun,
  type WorkflowRunError
} from "@work-shape/catalyst-core";
import { jsonValueSchema } from "./json";

// The wait of an `operation` step for an operation with `completion: async` (EW-ASYNC): its
// timeout, and how the step ends from the Operation Run it waited for.

/** How long a step waits for such an operation unless its `timeout` says otherwise. */
const WORKFLOW_OPERATION_WAIT_DEFAULT_MS = 6 * 60 * 60 * 1_000;

/** The code of a step whose wait ended at its `timeout` while the operation goes on. */
const WORKFLOW_OPERATION_STILL_RUNNING = "operation_still_running";

/**
 * A `timeout` in minutes, hours or days, such as `30m`, `6h` or `3d`. The wait counts toward
 * no limit of the run (EW-LIM), so it is not bounded by the run's duration.
 */
export const workflowOperationTimeoutSchema = workflowDurationSchema;

/**
 * How long a step waits: its `timeout`, six hours unless set. A `timeout` this engine cannot
 * read waits the default: a save refuses one.
 */
export function operationWaitMs(timeout: string | undefined): number {
  const asked = timeout === undefined ? Number.NaN : workflowDurationMs(timeout);
  return Number.isFinite(asked) ? asked : WORKFLOW_OPERATION_WAIT_DEFAULT_MS;
}

/** The step's end as far as the Operation Run it waits for tells it. */
export type OperationWaitOutcome =
  { kind: "done"; output: JsonValue } | { kind: "failed"; error: WorkflowRunError };

/**
 * How a step that waited ends from its Operation Run, once that run has ended: with the
 * operation's result where it fits the operation's output schema, and failed with the run's
 * code otherwise. Nothing while the run goes on.
 */
export async function operationWaitOutcome(
  call: OperationRun,
  definition: Pick<OperationDefinition, "outputSchema" | "batch"> | undefined
): Promise<OperationWaitOutcome | undefined> {
  const operation = call.operation;
  switch (call.status) {
    case "done": {
      const output = jsonValueSchema.safeParse(call.output?.value);
      if (!call.output || !output.success) {
        return failed(
          "operation_output_not_retained",
          `The operation '${operation}' ended and its result was not kept`
        );
      }
      const fits = definition
        ? await definition.outputSchema.safeParseAsync(output.data).catch(() => undefined)
        : undefined;
      if (!fits?.success) {
        return failed(
          "output_invalid",
          `The result of '${operation}' does not fit the operation's output schema`
        );
      }
      const batchError = definition?.batch ? batchResultError(output.data) : undefined;
      if (batchError) return failed(batchError.code, batchError.message);
      return { kind: "done", output: output.data };
    }
    case "failed":
      return failed(call.error?.code ?? "operation_failed", `The operation '${operation}' failed`);
    case "denied":
    case "expired":
      return failed(
        call.error?.code ?? `operation_${call.status}`,
        `The operation '${operation}' ended as ${call.status}`
      );
    default:
      return undefined;
  }
}

/**
 * The failure of a step whose wait reached its `timeout`. The operation goes on, and the
 * sentence its owner gives says so on the run page.
 */
export function stillRunningError(
  operation: string,
  definition: Pick<OperationDefinition, "completion"> | undefined
): WorkflowRunError {
  return {
    code: WORKFLOW_OPERATION_STILL_RUNNING,
    message:
      definition?.completion?.stillRunning ??
      `The operation '${operation}' is still running and goes on without the run`
  };
}

const failed = (code: string, message: string): OperationWaitOutcome => ({
  kind: "failed",
  error: { code, message }
});
