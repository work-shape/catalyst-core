import type { ToolExecutionResult } from "./tool-execution";

/** Why the executor stopped a live implementation, carried by `runtime.signal.reason`. */
export class OperationExecutionStop extends Error {
  constructor(
    readonly kind: "timeout" | "aborted",
    override readonly cause: unknown
  ) {
    super("The operation execution was stopped");
    this.name = "OperationExecutionStop";
  }
}

/** An executor deadline is not a cancellation by the person or the owning Agent Run. */
export function isOperationTimeout(signal: AbortSignal | undefined): boolean {
  return signal?.reason instanceof OperationExecutionStop && signal.reason.kind === "timeout";
}

const stopResults = new WeakMap<AbortSignal, Promise<ToolExecutionResult | undefined>>();

/**
 * A cooperative tool registers the result of its bounded wait before awaiting it. The executor
 * can retain that tool's own timeout details after recording TIMEOUT and aborting the wait.
 * Registration is scoped to the execution's signal; it adds no listener or retained history.
 */
export function registerOperationStopResult(
  signal: AbortSignal | undefined,
  result: Promise<ToolExecutionResult | undefined>
): void {
  if (signal)
    stopResults.set(
      signal,
      result.catch(() => undefined)
    );
}

/** Only the executor reads this after stopping the implementation; late success is ignored. */
export function operationStopResult(
  signal: AbortSignal
): Promise<ToolExecutionResult | undefined> | undefined {
  return stopResults.get(signal);
}
