import type { AgentRun, ConversationFollowUp } from "@work-shape/catalyst-api-client";
import { isLiveRunStatus } from "./conversation-controller-state";

/**
 * Where the queue of follow-up messages stands.
 * - `waiting`: a run goes; the oldest message starts as the next turn once it completes.
 * - `sending`: the run completed, or Send now was accepted, and the server is starting the
 *   next message.
 * - `paused`: the last run failed or was stopped, or the next message did not start. Nothing
 *   starts by itself until someone presses Send now.
 */
export type FollowUpQueuePhase = "waiting" | "sending" | "paused";

/** One queued message as the queue above the composer shows it. */
export interface FollowUpQueueItem {
  id: string;
  text: string;
  /** The reader wrote it: only they may edit or remove it. */
  own: boolean;
  /** Who wrote it, for a message of another member. */
  authorLabel: string | undefined;
  /** A steer the running turn reads after its current step (FU-2). */
  steering: boolean;
}

/** The server's queued message as seen by this reader. */
export function followUpQueueItem(
  followUp: ConversationFollowUp,
  currentUserId: string | undefined,
  /** The run that goes now, if one does. A steer for a run that ended waits as any message. */
  liveRunId: string | undefined
): FollowUpQueueItem {
  return {
    id: followUp.id,
    text: followUp.text,
    own: followUp.authorUserId === currentUserId,
    authorLabel: followUp.authorDisplayLabel,
    steering:
      followUp.mode === "steer" && liveRunId !== undefined && followUp.dispatchedRunId === liveRunId
  };
}

export function followUpQueuePhase(input: {
  runStatus: AgentRun["status"] | undefined;
  /**
   * Send now was accepted for the oldest message. The server starts its run a moment after it
   * answers, so the thread may still name the stopped run.
   */
  sentNow: boolean;
  /** The thread was read again after the run completed, and the next message did not start. */
  dispatchOverdue: boolean;
}): FollowUpQueuePhase {
  if (input.runStatus !== undefined && isLiveRunStatus(input.runStatus)) {
    return "waiting";
  }
  if (input.dispatchOverdue) {
    return "paused";
  }
  if (input.sentNow) {
    return "sending";
  }
  return input.runStatus === "failed" || input.runStatus === "cancelled" ? "paused" : "sending";
}

/**
 * How long the page waits before it reads the thread again while the next message should be
 * starting: one re-read per entry. No push reaches the page when the server starts it, so the
 * page asks. After the last one the queue counts as paused.
 */
const DISPATCH_REREAD_DELAYS_MS = [500, 1_500, 3_000, 6_000] as const;

/**
 * The next re-read while the queue is `sending`, keyed by the message that should start, or
 * nothing once `attempts` re-reads have not moved it.
 */
export function followUpDispatchReread(input: {
  phase: FollowUpQueuePhase | undefined;
  nextFollowUpId: string | undefined;
  attempts: number;
}): { followUpId: string; delayMs: number } | undefined {
  if (input.phase !== "sending" || input.nextFollowUpId === undefined) {
    return undefined;
  }
  const delayMs = DISPATCH_REREAD_DELAYS_MS[input.attempts];
  return delayMs === undefined ? undefined : { followUpId: input.nextFollowUpId, delayMs };
}

/** The re-reads for this message are spent and it still has not started. */
export function isFollowUpDispatchOverdue(input: {
  nextFollowUpId: string | undefined;
  rereads: { followUpId: string; attempts: number } | undefined;
}): boolean {
  return (
    input.nextFollowUpId !== undefined &&
    input.rereads?.followUpId === input.nextFollowUpId &&
    input.rereads.attempts >= DISPATCH_REREAD_DELAYS_MS.length
  );
}

/**
 * The composer's text after Edit took a queued message back. Nothing typed is lost: text that
 * already stands in the field follows the queued message, which was written first.
 */
export function composerTextAfterEdit(current: string, queued: string): string {
  return current.trim().length === 0 ? queued : `${queued}\n\n${current}`;
}
