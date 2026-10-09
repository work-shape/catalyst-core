import { AppError } from "@vivd-catalyst/core";
import { ModelProviderError } from "./model-provider-error";

// Protects a call from a provider's server error or dropped connection: the wait before the
// second and the third attempt. After the third attempt the call fails with the provider's error.
export const MODEL_PROVIDER_RETRY_WAITS_MS = [1_000, 4_000];
// Protects a call from a provider's per-minute rate limit, which the short waits above cannot
// outlast: all waits of one model call on a rate limit add up to at most this. Then the call
// fails and the user reads that the model is receiving too many requests.
export const MODEL_PROVIDER_RATE_LIMIT_WAIT_TOTAL_MS = 60_000;
// The first wait on a rate limit that names no pause in `Retry-After`; each later one doubles.
export const MODEL_PROVIDER_RATE_LIMIT_FIRST_WAIT_MS = 4_000;
// Each wait varies by this share in both directions, so calls that failed together do not retry together.
export const MODEL_PROVIDER_RETRY_JITTER_RATIO = 0.2;
// Protects a call from waiting on a provider that asks for a long pause in `Retry-After` on an
// error other than a rate limit. A shorter pause replaces the fixed wait; a longer one fails the
// call with the provider's error.
export const MODEL_PROVIDER_RETRY_AFTER_MAX_MS = 60_000;

/**
 * The one retry policy of a model call. It decides from the typed error and from what the caller
 * has already received; the caller's signal and deadline bound every attempt and every wait.
 */
export interface ModelRetryPolicy {
  /** Throws when the call was stopped or its deadline passed, before an attempt starts. */
  assertAttemptMayStart(): void;
  /**
   * The wait before the next attempt. Throws what the call fails with when it is not sent again:
   * the error itself, or for a rate limit an error whose message the user may read.
   */
  waitBeforeRetryMs(error: unknown, attempt: { retrySafe: boolean }): number;
  /** Waits, and throws `failure` when the call is stopped meanwhile. */
  wait(waitMs: number, failure: unknown): Promise<void>;
}

export function createModelRetryPolicy(input: {
  signal?: AbortSignal;
  deadline?: Date;
}): ModelRetryPolicy {
  const { signal, deadline } = input;
  let transientFailures = 0;
  let rateLimitFailures = 0;
  let rateLimitWaitLeftMs = MODEL_PROVIDER_RATE_LIMIT_WAIT_TOTAL_MS;

  return {
    assertAttemptMayStart() {
      if (signal?.aborted) {
        throw new AppError("CONFLICT", "The model call was stopped before the provider was called");
      }
      if (deadline && Date.now() >= deadline.getTime()) {
        throw new AppError(
          "TIMEOUT",
          "The model call's deadline passed before the provider was called"
        );
      }
    },

    waitBeforeRetryMs(error, attempt) {
      const failure = modelCallFailureFor(error);
      if (
        !attempt.retrySafe ||
        signal?.aborted ||
        !(error instanceof ModelProviderError) ||
        !error.retryable
      ) {
        throw failure;
      }
      const retryAfterMs = error.retryAfterMs;
      let waitMs: number;
      if (error.kind === "rate_limit") {
        rateLimitFailures += 1;
        // Never sooner than the provider asks, and never past what is left of the minute.
        waitMs = Math.min(
          Math.max(retryAfterMs ?? 0, rateLimitWaitMs(rateLimitFailures)),
          rateLimitWaitLeftMs
        );
        if (waitMs <= 0 || (retryAfterMs ?? 0) > rateLimitWaitLeftMs) {
          throw failure;
        }
        rateLimitWaitLeftMs -= waitMs;
      } else {
        transientFailures += 1;
        if (transientFailures > MODEL_PROVIDER_RETRY_WAITS_MS.length) {
          throw failure;
        }
        waitMs = retryAfterMs ?? retryWaitMs(transientFailures);
        if (waitMs > MODEL_PROVIDER_RETRY_AFTER_MAX_MS) {
          throw failure;
        }
      }
      if (deadline && Date.now() + waitMs >= deadline.getTime()) {
        throw failure;
      }
      return waitMs;
    },

    async wait(waitMs, failure) {
      try {
        await waitUnlessAborted(waitMs, signal);
      } catch {
        throw failure;
      }
    }
  };
}

/**
 * What a call fails with: the error itself, or for a provider's rate limit an error whose
 * message the user may read.
 */
export function modelCallFailureFor(error: unknown): unknown {
  if (!(error instanceof ModelProviderError) || error.kind !== "rate_limit") {
    return error;
  }
  const failure = new AppError(
    "RATE_LIMITED",
    "The model is receiving too many requests. Try again in a minute."
  );
  failure.cause = error;
  return failure;
}

/** Rejects when the signal aborts first. Uses the global timer so a test clock can drive it. */
function waitUnlessAborted(waitMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Model provider retry wait was cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, waitMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryWaitMs(failedAttempt: number): number {
  return withRetryJitter(MODEL_PROVIDER_RETRY_WAITS_MS[failedAttempt - 1] ?? 0);
}

function rateLimitWaitMs(failedAttempt: number): number {
  return withRetryJitter(MODEL_PROVIDER_RATE_LIMIT_FIRST_WAIT_MS * 2 ** (failedAttempt - 1));
}

function withRetryJitter(waitMs: number): number {
  return Math.round(waitMs * (1 + (Math.random() * 2 - 1) * MODEL_PROVIDER_RETRY_JITTER_RATIO));
}
