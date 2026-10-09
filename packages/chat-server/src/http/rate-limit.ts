import { createHash } from "node:crypto";
import { rateLimitedDetailsSchema, type OperationRateClass } from "@vivd-catalyst/api-contract";
import type { RateLimitsConfig } from "@vivd-catalyst/config-schema";
import {
  AppError,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitRule
} from "@vivd-catalyst/core";
import { z } from "zod";

const MINUTE_MS = 60 * 1000;
// Protects API keys and the server credential from being guessed from one address. Over it
// the sender of refused credentials reads 429 `RATE_LIMITED`; an accepted one is not affected.
const REFUSED_CREDENTIALS_PER_ADDRESS_PER_MINUTE = 60;
// The longest mail address there is. Protects the counters from names sent only to fill
// memory: a longer name is counted under the caller's address alone, and nobody sees it.
const ACCOUNT_NAME_MAX_CHARS = 254;
// How often counters that have run out are removed, whether or not anyone calls.
const SWEEP_INTERVAL_MS = 60 * 1000;
// Protects the process's memory from a flood of invented callers. Once this many counters are
// held, a caller without one shares a single counter per rule with all other new callers and
// reads 429 `RATE_LIMITED` when that is used up; callers already counted are not affected.
const MAX_COUNTERS = 200_000;

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

/**
 * The account a sign-in or reset call names, as the counter spells it: a hash of the trimmed,
 * lower-cased mail address. Nothing for a name that cannot be a mail address, so what a
 * caller invents is counted under its address alone and is never kept.
 */
export function accountTried(body: unknown): string | undefined {
  const named = z.object({ email: z.string() }).safeParse(body);
  if (!named.success || named.data.email.length > 4 * ACCOUNT_NAME_MAX_CHARS) {
    return undefined;
  }
  const account = z
    .email()
    .max(ACCOUNT_NAME_MAX_CHARS)
    .safeParse(named.data.email.trim().toLowerCase());
  return account.success
    ? createHash("sha256").update(account.data).digest("base64url").slice(0, 22)
    : undefined;
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

/**
 * Counters in this process, one fixed window per key. They start empty after a restart, and a
 * second API process would count on its own. Counters that have run out are removed by a
 * timer, which runs only while there are counters and never keeps the process alive.
 */
export function createInProcessRateLimiter(
  options: { now?: () => number; maxKeys?: number } = {}
): RateLimiter {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? MAX_COUNTERS;
  const windows = new Map<string, { count: number; endsAt: number }>();
  // One per rule, so there are a handful. They are held beside the counters and not capped.
  const overflow = new Map<string, { count: number; endsAt: number }>();
  let sweeper: NodeJS.Timeout | undefined;

  function sweep(): void {
    const time = now();
    for (const counters of [windows, overflow]) {
      for (const [key, window] of counters) {
        if (window.endsAt <= time) {
          counters.delete(key);
        }
      }
    }
    if (windows.size === 0 && overflow.size === 0 && sweeper) {
      clearInterval(sweeper);
      sweeper = undefined;
    }
  }

  function count(
    counters: Map<string, { count: number; endsAt: number }>,
    key: string,
    rule: RateLimitRule,
    time: number
  ): RateLimitDecision {
    const current = counters.get(key);
    if (!current || current.endsAt <= time) {
      counters.set(key, { count: 1, endsAt: time + rule.windowMs });
      sweeper ??= setInterval(sweep, SWEEP_INTERVAL_MS).unref();
      return { allowed: true, retryAfterMs: 0 };
    }
    if (current.count >= rule.limit) {
      return { allowed: false, retryAfterMs: current.endsAt - time };
    }
    current.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  return {
    async consume(key, rule) {
      const time = now();
      if (!windows.has(key) && windows.size >= maxKeys) {
        sweep();
        if (windows.size >= maxKeys) {
          return count(overflow, `${rule.limit}/${rule.windowMs}`, rule, time);
        }
      }
      return count(windows, key, rule, time);
    }
  };
}
