import {
  type JsonValue,
  type OperationDefinition,
  type OperationRun,
  type WorkflowRunError
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { jsonValueSchema } from "./json";

// The wait of an `operation` step for an operation with `completion: async` (EW-ASYNC): its
// timeout, and how the step ends from the Operation Run it waited for.

/** How long a step waits for such an operation unless its `timeout` says otherwise. */
const WORKFLOW_OPERATION_WAIT_DEFAULT_MS = 6 * 60 * 60 * 1_000;

/** The longest `timeout` a step may name: the twelve hours a run may take. */
const WORKFLOW_OPERATION_WAIT_MAX_MS = 12 * 60 * 60 * 1_000;

/** The code of a step whose wait ended at its `timeout` while the operation goes on. */
const WORKFLOW_OPERATION_STILL_RUNNING = "operation_still_running";

const UNIT_MS = { m: 60 * 1_000, h: 60 * 60 * 1_000 } as const;
const TIMEOUT = /^([1-9][0-9]{0,3})(m|h)$/u;

/** A `timeout` in minutes or hours, such as `30m` or `6h`, of at most twelve hours. */
export const workflowOperationTimeoutSchema = z
  .string()
  .regex(TIMEOUT, "A timeout is a number of minutes or hours, such as '30m' or '6h'")
  .refine((text) => timeoutMsOf(text) <= WORKFLOW_OPERATION_WAIT_MAX_MS, {
    message: "A timeout is at most 12h, the time a run may take"
  });

function timeoutMsOf(text: string): number {
  const match = TIMEOUT.exec(text);
  const unit = match?.[2] === "h" ? UNIT_MS.h : UNIT_MS.m;
  return Number(match?.[1] ?? Number.NaN) * unit;
}

/**
 * How long a step waits: its `timeout`, six hours unless set, and never longer than the run
 * may take. A `timeout` this engine cannot read waits the default: a save refuses one.
 */
export function operationWaitMs(timeout: string | undefined, maxDurationMs: number): number {
  const asked = timeout === undefined ? Number.NaN : timeoutMsOf(timeout);
  return Math.min(
    Number.isFinite(asked) ? asked : WORKFLOW_OPERATION_WAIT_DEFAULT_MS,
    maxDurationMs
  );
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
  definition: Pick<OperationDefinition, "outputSchema"> | undefined
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
