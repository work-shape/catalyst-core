import { z } from "zod";
import { defineJobKind } from "./jobs";

// A transient dispatch failure gets this many attempts before its queue stays paused.
const FOLLOW_UP_DISPATCH_MAX_ATTEMPTS = 3;
// A dead dispatch worker loses its hold after this lease; every subsequent write is fenced.
const FOLLOW_UP_DISPATCH_LEASE_MS = 60_000;
// Retries wait between these bounds; the pending message remains available to Send now.
const FOLLOW_UP_DISPATCH_BACKOFF_BASE_MS = 1000;
const FOLLOW_UP_DISPATCH_BACKOFF_MAX_MS = 10_000;

/** Starts one compatible pending turn after one ended run; the conversation serializes dispatch. */
export const dispatchConversationFollowUpJob = defineJobKind({
  kind: "conversation.follow_up.dispatch",
  payloadSchema: z.object({ conversationId: z.string().min(1), afterRunId: z.string().min(1) }),
  maxAttempts: FOLLOW_UP_DISPATCH_MAX_ATTEMPTS,
  backoff: { baseMs: FOLLOW_UP_DISPATCH_BACKOFF_BASE_MS, maxMs: FOLLOW_UP_DISPATCH_BACKOFF_MAX_MS },
  leaseMs: FOLLOW_UP_DISPATCH_LEASE_MS,
  concurrency: { perKey: 1 },
  manualRetry: false
});
