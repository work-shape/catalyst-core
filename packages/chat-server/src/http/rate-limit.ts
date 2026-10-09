import { OPERATION_RATE_LIMITS, type Operation } from "@vivd-catalyst/api-contract";
import {
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type RateLimiter
} from "@vivd-catalyst/core";

export type RateLimitedCaller = { identity: AuthenticatedIdentity } | { address: string };

/**
 * Counts the call against its operation and its caller: the principal where the operation
 * authenticates one, the client address where it does not. Answers the number of seconds a
 * refused caller has to wait, and nothing for a call within the limit.
 */
export async function countOperationCall(
  limiter: RateLimiter,
  operation: Pick<Operation, "id" | "rateClass">,
  caller: RateLimitedCaller
): Promise<number | undefined> {
  const counted =
    "identity" in caller ? principalKey(caller.identity) : `address:${caller.address}`;
  const decision = await limiter.consume(
    `${operation.id}|${counted}`,
    OPERATION_RATE_LIMITS[operation.rateClass]
  );
  return decision.allowed ? undefined : Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
}

function principalKey(identity: AuthenticatedIdentity): string {
  return isAuthenticatedServicePrincipal(identity)
    ? `service:${identity.id}`
    : `user:${getSubjectUserId(identity)}`;
}

const SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Counters in this process, one fixed window per key. They start empty after a restart, and a
 * second API process would count on its own.
 */
export function createInProcessRateLimiter(options: { now?: () => number } = {}): RateLimiter {
  const now = options.now ?? Date.now;
  const windows = new Map<string, { count: number; endsAt: number }>();
  let nextSweepAt = 0;

  function sweep(time: number): void {
    if (time < nextSweepAt) {
      return;
    }
    nextSweepAt = time + SWEEP_INTERVAL_MS;
    for (const [key, window] of windows) {
      if (window.endsAt <= time) {
        windows.delete(key);
      }
    }
  }

  return {
    async consume(key, rule) {
      const time = now();
      sweep(time);
      const current = windows.get(key);
      if (!current || current.endsAt <= time) {
        windows.set(key, { count: 1, endsAt: time + rule.windowMs });
        return { allowed: true, retryAfterMs: 0 };
      }
      if (current.count >= rule.limit) {
        return { allowed: false, retryAfterMs: current.endsAt - time };
      }
      current.count += 1;
      return { allowed: true, retryAfterMs: 0 };
    }
  };
}
