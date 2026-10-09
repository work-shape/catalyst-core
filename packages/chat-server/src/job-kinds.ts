import {
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  type JobKind,
  type ScheduledJobPayload
} from "@vivd-catalyst/core";
import { z } from "zod";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** A scheduled kind: one tick at a time across the instance, one attempt, ten minutes of lease. */
function defineScheduledKind(kind: string, leaseMs = 10 * MINUTE_MS): JobKind<ScheduledJobPayload> {
  return defineJobKind({
    kind,
    payloadSchema: scheduledJobPayloadSchema,
    maxAttempts: 1,
    backoff: { baseMs: 0, maxMs: 0 },
    leaseMs,
    concurrency: { global: 1 }
  });
}

/**
 * Titles a conversation from its first user message. Enqueued in the transaction that writes
 * that message, with the conversation as dedupe and concurrency key.
 */
export const generateConversationTitleJob = defineJobKind({
  kind: "conversation.generate_title",
  payloadSchema: z.object({
    conversationId: z.string().min(1),
    /** The user whose message it was. */
    userId: z.string().min(1)
  }),
  maxAttempts: 2,
  backoff: { baseMs: 30 * 1000, maxMs: 30 * 1000 },
  leaseMs: 2 * MINUTE_MS,
  concurrency: { global: 4, perKey: 1 }
});

export const expireConversationsJob = defineScheduledKind("conversation.expire");
export const cleanUpExecutionWorkspacesJob = defineScheduledKind("execution_workspace.cleanup");
export const recoverAgentRunsJob = defineScheduledKind("agent_run.recover", 2 * MINUTE_MS);
export const pruneAuditEventsJob = defineScheduledKind("audit.prune");
export const pruneJobsJob = defineScheduledKind("platform_jobs.prune");

export const expireConversationsSchedule = defineSchedule({
  kind: expireConversationsJob,
  every: HOUR_MS
});
export const recoverAgentRunsSchedule = defineSchedule({
  kind: recoverAgentRunsJob,
  every: MINUTE_MS,
  // A conversation whose run the last process lost refuses messages until this ran.
  dueAtStart: true
});
export const pruneAuditEventsSchedule = defineSchedule({
  kind: pruneAuditEventsJob,
  every: DAY_MS
});
export const pruneJobsSchedule = defineSchedule({ kind: pruneJobsJob, every: DAY_MS });
