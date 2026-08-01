import { useEffect, useRef, useState } from "react";
import { useTranslation } from "./i18n";
import type { RunActivity } from "./thread-activity";
import { useToolActivityLabel } from "./tool-activity";
import { Spinner } from "./ui/spinner";

const fallbackActivityKeys = [
  "preparing",
  "preparingAlt1",
  "preparingAlt2",
  "preparingAlt3",
  "preparingAlt4",
  "preparingAlt5",
  "preparingAlt6",
  "preparingAlt7",
  "preparingAlt8",
  "preparingAlt9"
] as const;

/**
 * Minimum time a phrase stays on screen before the next one replaces it.
 *
 * The row itself is never unmounted, so this only smooths wording during rapid
 * tool transitions. A stale word is the worst case; a missing or duplicated
 * spinner is not reachable from here.
 */
const LABEL_MIN_HOLD_MS = 600;

export function AssistantActivityStatus({
  activity,
  preparingToolName,
  variationSeed
}: {
  activity?: RunActivity;
  preparingToolName?: string;
  variationSeed?: string;
}) {
  const label = useAssistantActivityLabel({ activity, preparingToolName, variationSeed });
  const heldLabel = useHeldLabel(label, LABEL_MIN_HOLD_MS);
  const elapsedSeconds = useElapsedSeconds(variationSeed);

  return (
    <div
      className="flex max-w-3xl items-center gap-2 py-1 text-sm text-muted-foreground"
      data-testid="run-activity-status"
      role="status"
      aria-live="polite"
    >
      <Spinner size="sm" />
      <span className="text-xs tabular-nums opacity-70" data-testid="run-activity-elapsed">
        {formatElapsed(elapsedSeconds)}
      </span>
      <span className="text-xs opacity-50" aria-hidden="true">
        ·
      </span>
      <span key={heldLabel} className="animate-in fade-in duration-200">
        {heldLabel}
      </span>
    </div>
  );
}

export function useAssistantActivityLabel({
  activity,
  preparingToolName,
  variationSeed
}: {
  activity?: RunActivity;
  preparingToolName?: string;
  variationSeed?: string;
}): string {
  const { locale, t } = useTranslation();
  const runningToolName = activity?.kind === "tool" ? activity.toolName : undefined;
  const runningToolLabel = useToolLabel(runningToolName, locale);
  const preparingToolLabel = useToolLabel(preparingToolName, locale);
  const isFallback = !runningToolLabel && !preparingToolLabel && activity?.kind !== "reasoning";
  const fallbackRotation = useFallbackRotation(isFallback);

  // A running tool is observed state; `preparingToolName` is an announcement
  // that may still describe the call currently in flight. Observed state wins.
  if (runningToolLabel) {
    return t("runningTool", { tool: runningToolLabel });
  }
  if (preparingToolLabel) {
    return t("preparingTool", { tool: preparingToolLabel });
  }
  if (activity?.kind === "reasoning") {
    return t("thinkingActivity");
  }
  const index = (stableVariantIndex(variationSeed) + fallbackRotation) % fallbackActivityKeys.length;
  return t(fallbackActivityKeys[index] ?? "preparing");
}

/**
 * Advances by one each time the row re-enters the neutral fallback state, so a
 * run cycles through the phrase list instead of repeating one phrase. The first
 * entry contributes no offset — the initial phrase stays the seed-chosen one,
 * including in effect-free renders (SSR, static markup).
 */
function useFallbackRotation(isFallback: boolean): number {
  const [entryCount, setEntryCount] = useState(0);

  useEffect(() => {
    if (isFallback) {
      setEntryCount((count) => count + 1);
    }
  }, [isFallback]);

  return Math.max(0, entryCount - 1);
}

// Only configured labels are used. A raw tool name is an internal identifier
// in English ("View document page"), which reads as broken in a localized
// sentence frame and means nothing to the user — the neutral fallback is better.
function useToolLabel(
  toolName: string | undefined,
  locale: Parameters<typeof useToolActivityLabel>[1]
): string | undefined {
  return useToolActivityLabel(toolName, locale);
}

/**
 * Wall-clock seconds since the activity row appeared, i.e. since the run
 * became busy. The row stays mounted for the whole run, so mount time is the
 * run start. A change from one run id to another resets the clock; the
 * undefined→id transition (optimistic send until the server assigns the id)
 * keeps counting, because it is the same run.
 */
function useElapsedSeconds(runKey: string | undefined): number {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAtRef = useRef(Date.now());
  const lastRunKeyRef = useRef(runKey);

  useEffect(() => {
    if (runKey !== undefined && lastRunKeyRef.current !== undefined && runKey !== lastRunKeyRef.current) {
      startedAtRef.current = Date.now();
      setElapsedSeconds(0);
    }
    if (runKey !== undefined) {
      lastRunKeyRef.current = runKey;
    }
  }, [runKey]);

  useEffect(() => {
    const interval = globalThis.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => globalThis.clearInterval(interval);
  }, []);

  return elapsedSeconds;
}

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function useHeldLabel(label: string, holdMs: number): string {
  const [displayedLabel, setDisplayedLabel] = useState(label);
  const lastChangeRef = useRef(Date.now());

  useEffect(() => {
    if (label === displayedLabel) {
      return undefined;
    }

    const remaining = holdMs - (Date.now() - lastChangeRef.current);
    if (remaining <= 0) {
      lastChangeRef.current = Date.now();
      setDisplayedLabel(label);
      return undefined;
    }

    const timeout = globalThis.setTimeout(() => {
      lastChangeRef.current = Date.now();
      setDisplayedLabel(label);
    }, remaining);
    return () => globalThis.clearTimeout(timeout);
  }, [displayedLabel, holdMs, label]);

  return displayedLabel;
}

function stableVariantIndex(seed: string | undefined): number {
  if (!seed) {
    return 0;
  }
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return hash % fallbackActivityKeys.length;
}

