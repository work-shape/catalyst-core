import { forgetWhenSessionEnds } from "../../shared/shell-session";

/** The runs of this tab that ended a moment ago, so their messages show as just completed. */
const recentlyActiveAssistantRunIds = new Set<string>();
forgetWhenSessionEnds(() => recentlyActiveAssistantRunIds.clear());

export function rememberRecentlyActiveAssistantRunId(runId: string): void {
  recentlyActiveAssistantRunIds.delete(runId);
  recentlyActiveAssistantRunIds.add(runId);
  if (recentlyActiveAssistantRunIds.size <= 20) {
    return;
  }
  const oldestRunId = recentlyActiveAssistantRunIds.values().next().value;
  if (typeof oldestRunId === "string") {
    recentlyActiveAssistantRunIds.delete(oldestRunId);
  }
}

export function isRecentlyActiveAssistantRunId(runId: string | undefined): boolean {
  return Boolean(runId && recentlyActiveAssistantRunIds.has(runId));
}

export function acknowledgeRecentlyActiveAssistantRunId(runId: string | undefined): void {
  if (runId) {
    recentlyActiveAssistantRunIds.delete(runId);
  }
}
