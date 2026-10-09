import { rateLimitedDetailsSchema, type OperationRateClass } from "@vivd-catalyst/api-contract";
import type { RateLimitsConfig } from "@vivd-catalyst/config-schema";
import {
  AppError,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type RateLimiter,
  type RateLimitRule
} from "@vivd-catalyst/core";
import { z } from "zod";

const MINUTE_MS = 60 * 1000;
// Protects API keys and the server credential from being guessed from one address. Over it
// the sender of refused credentials reads 429 `RATE_LIMITED`; an accepted one is not affected.
const REFUSED_CREDENTIALS_PER_ADDRESS_PER_MINUTE = 60;

/**
 * Who a call is counted under: the principal where the operation authenticates one, the one
 * server credential where it was accepted, the client address where nothing is known of the
 * caller, that address together with the account being tried, and the address again, on its
 * own counter, for a credential that was refused.
 */
export type RateLimitedCaller =
  | { identity: AuthenticatedIdentity }
  | { serverCredential: true }
  | { address: string; account?: string }
  | { refusedAddress: string };

function perMinute(limit: number): RateLimitRule {
  return { limit, windowMs: MINUTE_MS };
}

/** The rule a call is counted against, from the instance's `rateLimits`. */
function rateLimitRule(
  limits: RateLimitsConfig,
  rateClass: OperationRateClass,
  caller: RateLimitedCaller
): RateLimitRule {
  if ("refusedAddress" in caller) {
    return perMinute(REFUSED_CREDENTIALS_PER_ADDRESS_PER_MINUTE);
  }
  if (rateClass === "read") {
    return perMinute(limits.readPerMinute);
  }
  if (rateClass === "write") {
    return perMinute(limits.writePerMinute);
  }
  // An account is tried by the person signed in to it, or named in the call. Only the
  // address alone has the high cap.
  return "address" in caller && caller.account === undefined
    ? perMinute(limits.signInPerAddressPerMinute)
    : perMinute(limits.signInPerAccountPerMinute);
}

/** The counter a call falls under, within its operation or its group of routes. */
function rateLimitKey(counted: string, caller: RateLimitedCaller): string {
  return `${counted}|${callerKey(caller)}`;
}

function callerKey(caller: RateLimitedCaller): string {
  if ("identity" in caller) {
    return isAuthenticatedServicePrincipal(caller.identity)
      ? `service:${caller.identity.id}`
      : `user:${getSubjectUserId(caller.identity)}`;
  }
  if ("serverCredential" in caller) {
    return "credential:server";
  }
  if ("refusedAddress" in caller) {
    return `refused:address:${caller.refusedAddress}`;
  }
  return caller.account === undefined
    ? `address:${caller.address}`
    : `address:${caller.address}|account:${caller.account}`;
}

/** The account a sign-in or reset call names, as the counter spells it. */
export function accountTried(body: unknown): string | undefined {
  const email = z.object({ email: z.string().min(1) }).safeParse(body);
  return email.success ? email.data.email.trim().toLowerCase() : undefined;
}

/**
 * Counts one call. Over the limit it answers 429 `RATE_LIMITED` with the seconds to wait, in
 * the error's details and in the `Retry-After` header. Counts nothing where the instance has
 * limiting turned off.
 */
export async function requireWithinLimit(
  options: { rateLimiter: RateLimiter; config: { rateLimits: RateLimitsConfig } },
  counted: { id: string; rateClass: OperationRateClass },
  caller: RateLimitedCaller,
  reply: { header(name: string, value: number): unknown }
): Promise<void> {
  const limits = options.config.rateLimits;
  if (!limits.enabled) {
    return;
  }
  const decision = await options.rateLimiter.consume(
    rateLimitKey(counted.id, caller),
    rateLimitRule(limits, counted.rateClass, caller)
  );
  if (decision.allowed) {
    return;
  }
  const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
  reply.header("retry-after", retryAfterSeconds);
  throw new AppError(
    "RATE_LIMITED",
    "Too many requests. Try again later.",
    rateLimitedDetailsSchema.parse({ retryAfterSeconds })
  );
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
