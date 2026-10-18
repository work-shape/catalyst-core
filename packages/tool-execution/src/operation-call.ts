import {
  AppError,
  type OperationDefinition,
  type OperationExecutionContext,
  type OperationRunDecisionReason
} from "@work-shape/catalyst-core";

/** The decision of a call that ran on its own caller's word. */
export type DirectDecision =
  | { mode: "direct"; reason?: OperationRunDecisionReason }
  | { mode: "approved"; reason: "approved_by_caller" };

/** Thrown by admission when the operation must not be dispatched. */
export class OperationNotBegunError extends Error {
  constructor() {
    super("The operation was not called");
    this.name = "OperationNotBegunError";
  }
}

/** A deadline or caller stop, distinguished from an implementation's own error. */
export class OperationCallStoppedError extends Error {
  constructor(
    readonly kind: "timeout" | "aborted",
    readonly reason: unknown
  ) {
    super("The operation call was stopped");
    this.name = "OperationCallStoppedError";
  }
}

/**
 * Bounds the live call, before any result recording. A late answer therefore cannot write
 * success after a timeout. The executor records the stop before aborting the implementation.
 */
export function startOperationCall(
  definition: OperationDefinition,
  input: unknown,
  execution: OperationExecutionContext,
  now: Date,
  startedAt?: string
) {
  const { signal, deadline } = execution.runtime;
  const stop = new AbortController();
  const until = Math.min(
    Date.parse(startedAt ?? now.toISOString()) + definition.timeoutMs,
    deadline?.getTime() ?? Infinity
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cut: (cause: "timeout" | "aborted") => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    cut = (cause) =>
      reject(
        new OperationCallStoppedError(
          cause,
          cause === "aborted"
            ? signal?.reason
            : new AppError(
                "TIMEOUT",
                `'${definition.name}' did not end within its ${definition.timeoutMs / 1000} seconds`,
                undefined,
                { exposeMessage: true }
              )
        )
      );
  });
  const onAbort = () => cut("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  // A paged read spans many calls and deferred leases; its paging owner bounds the total
  // duration and each page. A worker stop must still leave its checkpoint resumable.
  if (!execution.runtime.readPages)
    timer = setTimeout(() => cut("timeout"), Math.max(0, until - now.getTime()));
  let answer: Promise<unknown>;
  try {
    if (signal?.aborted) throw new OperationCallStoppedError("aborted", signal.reason);
    answer = Promise.resolve(
      definition.execute(input, {
        ...execution,
        runtime: {
          ...execution.runtime,
          signal: stop.signal,
          ...(execution.runtime.readPages ? {} : { deadline: new Date(until) })
        }
      })
    );
  } catch (error) {
    answer = Promise.reject(error);
  }
  const raced = Promise.race([answer, stopped]);
  // The started event may still be recording when an immediate failure arrives.
  raced.catch(() => undefined);
  return {
    answer: raced,
    wait: <Result>(work: Promise<Result>) => Promise.race([work, stopped]),
    abort: (reason: unknown) => stop.abort(reason),
    close: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
