import {
  ApiError,
  boundPreviewReport,
  type AppBridgeGuardReport,
  type PreviewReport,
  type PreviewReportBridge,
  type UnboundPreviewReport
} from "@work-shape/catalyst-api-client";

// What the interface tells the instance of one mounted preview (PREVIEW-STATUS-1): what the
// platform's guard in the Page reported, and what the interface saw itself: the frame loaded,
// the kit greeted within 5 seconds, and which calls failed, by name and code. Nothing of a
// call's input or result, and nothing the server answered in words. The report is scrubbed and
// bounded here, before it leaves the browser; the instance does so again.

/** How long the kit has to greet once the frame loaded. */
export const PREVIEW_GREETING_MS = 5_000;
/** A report is sent at most this often. */
export const PREVIEW_REPORT_INTERVAL_MS = 5_000;
/**
 * When the guard never settles, because the frame never loaded or the guard did not run, the
 * interface settles the report itself after this long.
 */
export const PREVIEW_SETTLE_FALLBACK_MS = 12_000;
/** Distinct failed calls kept apart; more are counted. A report lists ten entries at most. */
const MAX_FAILED_CALLS = 50;

/** What one preview's reporter is told. */
export interface PreviewReporter {
  frameLoaded(): void;
  greeted(): void;
  guardReport(report: AppBridgeGuardReport): void;
  callFailed(name: string, code: string): void;
  /** The preview was unmounted: nothing more is sent. */
  stop(): void;
}

interface Timers {
  now(): number;
  /** Runs `run` after `ms`; the function returned cancels it. */
  after(run: () => void, ms: number): () => void;
}

const browserTimers: Timers = {
  now: () => Date.now(),
  after: (run, ms) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  }
};

/**
 * The reporter of one mounted preview. It sends once at once, which tells the instance a
 * preview is mounted; then when the report settled, and on each change after, never more
 * often than every 5 seconds. A send that fails is not repeated: the next change sends again.
 */
export function createPreviewReporter(
  send: (report: PreviewReport) => Promise<unknown>,
  timers: Timers = browserTimers
): PreviewReporter {
  let stopped = false;
  let loaded = false;
  let greeted = false;
  let greetingLate = false;
  let settled = false;
  let guard: AppBridgeGuardReport | undefined;
  const calls = new Map<string, { name: string; code: string; count: number }>();
  let moreCalls = 0;
  let lastSentAt: number | undefined;
  let cancelQueued: (() => void) | undefined;
  let cancelGreeting: (() => void) | undefined;
  let cancelFallback: (() => void) | undefined;

  const bridge = (): PreviewReportBridge =>
    greeted ? "connected" : greetingLate ? "not_connected" : "waiting";

  const report = (): PreviewReport => {
    const unbound: UnboundPreviewReport = {
      settled,
      loaded,
      bridge: bridge(),
      ...(guard?.empty === undefined ? {} : { empty: guard.empty }),
      entries: [
        ...(guard?.entries ?? []),
        ...[...calls.values()].map((call) => ({
          kind: "call" as const,
          message: call.name,
          code: call.code,
          count: call.count
        }))
      ],
      more: (guard?.more ?? 0) + moreCalls
    };
    return boundPreviewReport(unbound);
  };

  const sendNow = () => {
    cancelQueued = undefined;
    if (stopped) return;
    // The mount is told at once and does not count: the settled report follows it as soon as
    // it is there, since a run of the agent waits a few seconds for it. Later changes then go
    // out at most every 5 seconds.
    lastSentAt = settled ? timers.now() : undefined;
    send(report()).catch((error: unknown) => {
      // The frame's address expired or is not this viewer's: nothing more is kept of it.
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) stop();
    });
  };

  /** Sends now, or as soon as the interval since the last send allows. */
  const changed = () => {
    if (stopped || !settled || cancelQueued !== undefined) return;
    const wait =
      lastSentAt === undefined
        ? 0
        : Math.max(0, lastSentAt + PREVIEW_REPORT_INTERVAL_MS - timers.now());
    cancelQueued = timers.after(sendNow, wait);
  };

  /** The frame's document loaded: the kit has 5 seconds to greet. */
  const markLoaded = () => {
    if (loaded) return;
    loaded = true;
    if (!greeted) {
      cancelGreeting = timers.after(() => {
        if (greeted) return;
        greetingLate = true;
        changed();
      }, PREVIEW_GREETING_MS);
    }
  };

  const stop = () => {
    stopped = true;
    cancelFallback?.();
    cancelGreeting?.();
    cancelQueued?.();
  };

  const settle = () => {
    if (settled) return;
    settled = true;
    changed();
  };

  cancelFallback = timers.after(settle, PREVIEW_SETTLE_FALLBACK_MS);
  sendNow();

  return {
    frameLoaded() {
      if (stopped || loaded) return;
      markLoaded();
      changed();
    },
    greeted() {
      if (stopped || greeted) return;
      greeted = true;
      changed();
    },
    guardReport(next) {
      if (stopped) return;
      guard = next;
      // A guard that reports has loaded its document.
      markLoaded();
      if (next.settled) settle();
      changed();
    },
    callFailed(name, code) {
      if (stopped) return;
      const key = JSON.stringify([name, code]);
      const known = calls.get(key);
      if (known) {
        known.count += 1;
      } else if (calls.size < MAX_FAILED_CALLS) {
        calls.set(key, { name, code, count: 1 });
      } else {
        moreCalls += 1;
      }
      changed();
    },
    stop
  };
}
