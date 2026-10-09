import { vi } from "vitest";

const realSetTimeout = globalThis.setTimeout;

/**
 * A fake clock for a test that also talks to real Postgres. It fakes `Date` and timeouts and
 * leaves `setImmediate`, through which the driver writes its queries, real. The driver still
 * opens each connection through a zero-delay timeout, so while this clock is installed every
 * promise that may reach the database is awaited through `settleOnFakeClock` or
 * `advanceFakeClockUntilSettled`. A test that needs only a fixed time fakes `Date` alone.
 */
export function useFakeClockBesidePostgres(now?: Date): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], ...(now ? { now } : {}) });
}

/**
 * Advances the fake clock by `stepMs` at a time until the work settles and returns its result.
 * Work that sleeps between database calls registers each sleep only after a real round trip, so
 * one advance over the whole span would pass before the later sleeps exist. Fails after
 * `maxSteps`, so work that never settles is reported here and not as a test timeout.
 */
export async function advanceFakeClockUntilSettled<Result>(
  work: Promise<Result>,
  stepMs: number,
  maxSteps = 400
): Promise<Result> {
  let settled = false;
  const watched = work.finally(() => {
    settled = true;
  });
  // The caller's `await` receives the rejection; this branch only keeps it from being unhandled.
  watched.catch(() => {});
  for (let step = 0; step < maxSteps && !settled; step += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
    await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
  }
  if (!settled)
    throw new Error(
      `Work did not settle within ${maxSteps} steps of ${stepMs} ms on the fake clock`
    );
  return watched;
}

/**
 * Lets work that only needs the driver's own timeouts settle, moving the clock one millisecond
 * at a time. The fake clock gives a zero-delay timeout registered while it advances a delay of
 * one millisecond, so advancing by zero would never open a connection.
 */
export function settleOnFakeClock<Result>(work: Promise<Result>): Promise<Result> {
  return advanceFakeClockUntilSettled(work, 1);
}
