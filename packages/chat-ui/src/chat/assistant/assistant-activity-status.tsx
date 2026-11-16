import { useEffect, useRef, useState } from "react";
import { Hourglass } from "lucide-react";
import { Spinner } from "@work-shape/catalyst-ui";
import { formatElapsedSeconds } from "./thread-time";
import { useTranslation } from "../../shared/i18n";
import { useRunWaitsFor } from "../approvals/tool-decision-context";
import type { RunActivity } from "./thread-activity";
import { useToolActivityLabel } from "./tool-activity";

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

/** A subagent the run waits for, as the row names it: its description and, once known, its start. */
export interface WaitingSubagent {
  description: string;
  startedAt?: string;
}

export function AssistantActivityStatus({
  activity,
  preparingToolName,
  variationSeed,
  waitingSubagents
}: {
  activity?: RunActivity;
  preparingToolName?: string;
  variationSeed?: string;
  /** The subagents the run waits for while it does nothing itself (CR-1's implicit join). */
  waitingSubagents?: readonly WaitingSubagent[];
}) {
  const waitsForSubagents = (waitingSubagents?.length ?? 0) > 0;
  const label = useAssistantActivityLabel({
    activity,
    preparingToolName,
    variationSeed,
    waitingSubagentCount: waitingSubagents?.length
  });
  const heldLabel = useHeldLabel(label, LABEL_MIN_HOLD_MS);
  const { elapsedSeconds, now } = useElapsedSeconds(variationSeed);
  const subagentDetails = waitsForSubagents
    ? (waitingSubagents ?? [])
        .map(({ description, startedAt }) =>
          [description, startedAt ? formatElapsedSeconds((now - Date.parse(startedAt)) / 1000) : ""]
            .filter(Boolean)
            .join(" ")
        )
        .filter(Boolean)
        .join(" · ")
    : "";

  return (
    <div
      className={
        // The row is in the accent while the agent works, as the running mark in the rail
        // says. While it only waits for its subagents it is quiet: the children work, not it.
        waitsForSubagents
          ? "flex max-w-3xl items-center gap-2 py-1 text-sm text-muted-foreground"
          : "flex max-w-3xl items-center gap-2 py-1 text-sm text-primary"
      }
      data-testid="run-activity-status"
      data-waiting-for-subagents={waitsForSubagents ? "true" : undefined}
      role="status"
      aria-live="polite"
    >
      {waitsForSubagents ? (
        <Hourglass className="size-3.5 shrink-0" aria-hidden="true" />
      ) : (
        <Spinner size="sm" />
      )}
      <span className="text-xs tabular-nums" data-testid="run-activity-elapsed">
        {formatElapsedSeconds(elapsedSeconds)}
      </span>
      <span className="text-xs opacity-50" aria-hidden="true">
        ·
      </span>
      <span key={heldLabel} className="shrink-0 animate-in fade-in duration-200">
        {heldLabel}
      </span>
      {subagentDetails ? (
        <span
          className="min-w-0 truncate text-xs opacity-75"
          title={subagentDetails}
          data-testid="run-activity-subagents"
        >
          {subagentDetails}
        </span>
      ) : null}
    </div>
  );
}

export function useAssistantActivityLabel({
  activity,
  preparingToolName,
  variationSeed,
  waitingSubagentCount = 0
}: {
  activity?: RunActivity;
  preparingToolName?: string;
  variationSeed?: string;
  waitingSubagentCount?: number;
}): string {
  const { locale, t } = useTranslation();
  const waitsFor = useRunWaitsFor();
  const runningToolName = activity?.kind === "tool" ? activity.toolName : undefined;
  const runningToolLabel = useToolLabel(runningToolName, locale);
  const preparingToolLabel = useToolLabel(preparingToolName, locale);
  const isFallback =
    !waitsFor &&
    waitingSubagentCount === 0 &&
    !runningToolLabel &&
    !preparingToolLabel &&
    activity?.kind !== "reasoning";
  const fallbackRotation = useFallbackRotation(isFallback);

  // A run held for a decision does nothing until somebody decides; it says so.
  if (waitsFor) {
    return t(waitsFor === "confirm" ? "waitingForDecision" : "waitingForApproval");
  }
  // A run that waits for its subagents does nothing until they end; it says so.
  if (waitingSubagentCount > 0) {
    return waitingSubagentCount === 1
      ? t("waitingForSubagent")
      : t("waitingForSubagents", { count: waitingSubagentCount });
  }
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
  const index =
    (stableVariantIndex(variationSeed) + fallbackRotation) % fallbackActivityKeys.length;
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
function useElapsedSeconds(runKey: string | undefined): { elapsedSeconds: number; now: number } {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const startedAtRef = useRef(Date.now());
  const lastRunKeyRef = useRef(runKey);

  useEffect(() => {
    if (
      runKey !== undefined &&
      lastRunKeyRef.current !== undefined &&
      runKey !== lastRunKeyRef.current
    ) {
      startedAtRef.current = Date.now();
      setElapsedSeconds(0);
    }
    if (runKey !== undefined) {
      lastRunKeyRef.current = runKey;
    }
  }, [runKey]);

  useEffect(() => {
    const interval = globalThis.setInterval(() => {
      const tick = Date.now();
      setNow(tick);
      setElapsedSeconds(Math.floor((tick - startedAtRef.current) / 1000));
    }, 1000);
    return () => globalThis.clearInterval(interval);
  }, []);

  return { elapsedSeconds, now };
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
