import { AppError } from "@work-shape/catalyst-core";
import { ModelProviderError } from "./model-provider-error";

/** What bounds one call in time: the caller's stop and the call's deadline. */
export interface ModelCallLimit {
  /** Aborts on the caller's stop and at the deadline. An adapter stops with it. */
  signal: AbortSignal | undefined;
  /** Whether the deadline has passed. */
  expired(): boolean;
  /** Settles as `pending` does, or rejects at the deadline when `pending` is still open then. */
  bound<T>(pending: Promise<T>): Promise<T>;
  release(): void;
}

export function deadlinePassed(): AppError {
  return new AppError("TIMEOUT", "The model call did not finish before its deadline");
}

// The longest delay a timer takes. A deadline further away is checked again when it fires.
const TIMER_MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * Stops a call at its deadline. The adapter is told through the signal, and a completion is
 * given up at the deadline even when the adapter does not listen, so a provider that never
 * answers cannot hold its caller. A stream is told through the signal alone.
 */
export function limitModelCall(
  signal: AbortSignal | undefined,
  deadline: Date | undefined
): ModelCallLimit {
  if (!deadline) {
    return { signal, expired: () => false, bound: (pending) => pending, release: () => undefined };
  }
  const timedOut = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    const leftMs = deadline.getTime() - Date.now();
    if (leftMs <= 0) {
      timedOut.abort();
      return;
    }
    timer = setTimeout(arm, Math.min(leftMs, TIMER_MAX_DELAY_MS));
  };
  arm();
  const atDeadline = new Promise<never>((_resolve, reject) => {
    timedOut.signal.addEventListener("abort", () => reject(deadlinePassed()), { once: true });
  });
  // Nothing may be waiting when the deadline passes; the rejection then has no reader.
  atDeadline.catch(() => undefined);
  return {
    signal: signal ? AbortSignal.any([signal, timedOut.signal]) : timedOut.signal,
    expired: () => timedOut.signal.aborted,
    bound: (pending) => Promise.race([pending, atDeadline]),
    release: () => clearTimeout(timer)
  };
}

/**
 * What a stopped call throws: the adapter's own abort where it threw one, else the reason the
 * caller stopped with, as an abort.
 */
export function stopOf(signal: AbortSignal, thrown: unknown): unknown {
  if (!(thrown instanceof ModelProviderError)) {
    return thrown;
  }
  const reason: unknown = signal.reason;
  if (reason instanceof Error) {
    return reason;
  }
  return new DOMException(
    typeof reason === "string" ? reason : "The model call was stopped",
    "AbortError"
  );
}
