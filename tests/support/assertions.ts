import { vi } from "vitest";
import { z } from "zod";
export function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null)
    throw new Error("Required test fixture value is missing");
  return value;
}
export function jsonObject(value: unknown): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value);
}
export function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
} {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve: required(resolve), reject: required(reject) };
}
/**
 * A point where `parties` calls meet. `arrive()` resolves for all of them together, once the
 * last one has arrived, so none of them goes on before every other one is there. A test of
 * calls "at the same time" puts it between a call's read and its write: without it the calls
 * overlap only when the machine happens to schedule them so.
 */
export function barrier(parties: number): { arrive(): Promise<void> } {
  const all = deferred<void>();
  let arrived = 0;
  return {
    arrive() {
      arrived += 1;
      if (arrived === parties) all.resolve();
      return all.promise;
    }
  };
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}

/**
 * How long a wait on a condition may last before it fails. It is a bound on a hang, not a
 * pause: a wait ends as soon as its condition holds. What is waited for is work of the
 * database, a server in this process or a child process, and on a machine that runs several
 * suites at once such work has taken more than the second that Vitest gives a wait by default.
 */
export const CONDITION_WAIT_MS = 15_000;

/**
 * Resolves once `condition` holds and fails when it does not within the deadline. Tests wait on
 * conditions with this, never with a fixed sleep.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = CONDITION_WAIT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Resolves with what `assertion` returns once it no longer throws, and fails with its last
 * failure when it still throws at the deadline. For an expectation that comes true a moment
 * after the call that causes it.
 */
export function eventually<Result>(assertion: () => Result | Promise<Result>): Promise<Result> {
  return vi.waitFor(assertion, { timeout: CONDITION_WAIT_MS, interval: 20 });
}
