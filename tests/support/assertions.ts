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
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}

export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}

/**
 * Resolves once `condition` holds and fails when it does not within the deadline. Tests wait on
 * conditions with this, never with a fixed sleep.
 */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 15_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}
