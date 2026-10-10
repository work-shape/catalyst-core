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

/**
 * A scheduled kind: one tick at a time across the instance, one attempt, ten minutes of lease.
 * A failed tick is not retried by hand: the next tick already waits under its key.
 */
function defineScheduledKind(kind: string, leaseMs = 10 * MINUTE_MS): JobKind<ScheduledJobPayload> {
  return defineJobKind({
    kind,
    payloadSchema: scheduledJobPayloadSchema,
    maxAttempts: 1,
    backoff: { baseMs: 0, maxMs: 0 },
    leaseMs,
    concurrency: { global: 1 },
    manualRetry: false
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

/**
 * A deletion that waits for stored data to be removed is tried again after one minute, then
 * after twice the wait each time up to six hours: fifty attempts are about ten days. After
 * the last one the job is dead and the subject stays closed.
 */
export const DELETION_MAX_ATTEMPTS = 50;
export const DELETION_BACKOFF_BASE_MS = MINUTE_MS;
const DELETION_BACKOFF_MAX_MS = 6 * HOUR_MS;

const deletionKind = {
  maxAttempts: DELETION_MAX_ATTEMPTS,
  backoff: { baseMs: DELETION_BACKOFF_BASE_MS, maxMs: DELETION_BACKOFF_MAX_MS },
  leaseMs: 10 * MINUTE_MS,
  concurrency: { global: 4, perKey: 1 }
} as const;

/**
 * Finishes the deletion of a user whose deletion was requested. Enqueued in the transaction
 * that marks the user, with the user as subject, dedupe and concurrency key.
 */
export const deleteAccountJob = defineJobKind({
  kind: "account.delete",
  payloadSchema: z.object({
    userId: z.string().min(1),
    requestedBy: z.enum(["self", "admin"]),
    /** The person who asked, for the audit events of the deletion. */
    actorUserId: z.string().min(1)
  }),
  ...deletionKind
});

/**
 * Finishes the deletion of a Shared Workspace whose deletion was requested. Enqueued in the
 * transaction that marks the workspace, with the workspace as subject, dedupe and concurrency
 * key.
 */
export const deleteWorkspaceJob = defineJobKind({
  kind: "workspace.delete",
  payloadSchema: z.object({
    collaborationWorkspaceId: z.string().min(1),
    /** The person who asked, for the audit events of the deletion. */
    actorUserId: z.string().min(1)
  }),
  ...deletionKind
});

export const expireConversationsJob = defineScheduledKind("conversation.expire");
export const cleanUpExecutionWorkspacesJob = defineScheduledKind("execution_workspace.cleanup");
/**
 * Transition release only: the tick of the run recovery that the previous release scheduled.
 * Runs are ended with their job now, so the kind has no schedule and its handler does nothing:
 * it ends the tick that is still queued at the upgrade. It goes in the contract step.
 */
export const retiredRecoverAgentRunsJob = defineScheduledKind("agent_run.recover", 2 * MINUTE_MS);
export const pruneAuditEventsJob = defineScheduledKind("audit.prune");
export const pruneJobsJob = defineScheduledKind("platform_jobs.prune");
/**
 * Transition release only: gives a job to every preview row and every attachment that waits
 * for work and has none. Such a row was queued before the upgrade, written by an API of the
 * previous release, or left behind by a worker of it. It goes with the lease columns of those
 * rows in the contract step.
 */
export const adoptLegacyJobsJob = defineScheduledKind("platform_jobs.adopt_legacy", 2 * MINUTE_MS);

/**
 * Transition release only: fills, on usage events written before they had the columns, the
 * purpose, the region and binding, and the user and workspace. It goes with the agent name of
 * calls the product makes for itself in the contract step.
 */
export const backfillUsageAttributionJob = defineScheduledKind("usage.backfill_attribution");
/** Releases what calls reserved that were admitted and never ended. */
export const recoverAbandonedModelCallsJob = defineScheduledKind("usage.recover_abandoned_calls");
/** Corrects the usage counters and the daily sums from the usage events. */
export const reconcileUsageJob = defineScheduledKind("usage.reconcile");

/** Asks every provider of the instance whether it answers. */
export const checkInfrastructureJob = defineScheduledKind("infrastructure.check", 2 * MINUTE_MS);

/**
 * Asks the command sandbox. Only the workspace command worker serves it: that process alone
 * reaches the sandbox, and it writes what it found where the API reads the other outcomes.
 */
export const checkSandboxJob = defineScheduledKind("infrastructure.check_sandbox", 2 * MINUTE_MS);

/**
 * How often the instance checks its providers by itself. A run is one cheap call per configured
 * provider, all at once, each ended after `PROVIDER_CHECK_TIMEOUT_MS`: 288 runs a day.
 */
export const INFRASTRUCTURE_CHECK_INTERVAL_MS = 5 * MINUTE_MS;

export const expireConversationsSchedule = defineSchedule({
  kind: expireConversationsJob,
  every: HOUR_MS
});
export const pruneAuditEventsSchedule = defineSchedule({
  kind: pruneAuditEventsJob,
  every: DAY_MS
});
export const pruneJobsSchedule = defineSchedule({ kind: pruneJobsJob, every: DAY_MS });
export const adoptLegacyJobsSchedule = defineSchedule({
  kind: adoptLegacyJobsJob,
  every: MINUTE_MS,
  // Work that was in flight at the upgrade gets its job as soon as the new API is up.
  dueAtStart: true
});
export const backfillUsageAttributionSchedule = defineSchedule({
  kind: backfillUsageAttributionJob,
  // A tick that finds the last pass recorded as unchanged reads one row and ends. A pass that
  // a killed process left goes on at the next tick.
  every: 10 * MINUTE_MS,
  // Older usage events show no region until the first pass after the upgrade is through.
  dueAtStart: true
});
export const recoverAbandonedModelCallsSchedule = defineSchedule({
  kind: recoverAbandonedModelCallsJob,
  every: 10 * MINUTE_MS,
  dueAtStart: true
});
export const reconcileUsageSchedule = defineSchedule({
  kind: reconcileUsageJob,
  every: DAY_MS,
  // The Usage page shows no sums of the days before the upgrade until the first run is through.
  dueAtStart: true
});
export const checkInfrastructureSchedule = defineSchedule({
  kind: checkInfrastructureJob,
  every: INFRASTRUCTURE_CHECK_INTERVAL_MS,
  // The Infrastructure page shows no health until the first run after a start is through.
  dueAtStart: true
});
export const checkSandboxSchedule = defineSchedule({
  kind: checkSandboxJob,
  every: INFRASTRUCTURE_CHECK_INTERVAL_MS,
  dueAtStart: true
});
