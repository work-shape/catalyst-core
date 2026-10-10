import {
  AppError,
  isAppError,
  subjectDedupeKey,
  type AuditActor,
  type CollaborationWorkspaceId,
  type JobKind,
  type JsonObject,
  type PlatformStores,
  type UserId
} from "@vivd-catalyst/core";
import { retryPendingConversationCleanup, type PendingCleanupScope } from "./conversation-cleanup";
import { DELETION_BACKOFF_BASE_MS } from "./job-kinds";
import type { ChatServerOptions } from "./types";

/**
 * How the request for a deletion ended. `deleted`: nothing was left to wait for and the rows
 * are gone. `deferred`: the subject is closed and its job removes the rest.
 */
export type DeletionOutcome<Result> =
  { status: "deleted"; result: Result } | { status: "deferred" };

/** Runs the last step of a deletion: in the request's own transaction, or fenced by a job. */
export type DeletionTransaction = <Result>(
  fn: (stores: PlatformStores) => Promise<Result>
) => Promise<Result>;

// Conversations one pass of a deletion retries the cleanup of. A pass goes on to the next batch
// only while every cleanup of the last one completed.
const PENDING_CLEANUP_BATCH_SIZE = 100;
// The most pending Conversations a deletion counts, for its refusal and its stalled event.
const STALLED_PENDING_COUNT_LIMIT = 1000;
const RUN_CANCELLED_BY_DELETION = "The account or workspace of this run is being deleted";

/**
 * Accepts a deletion. In one transaction the subject is marked, which closes it, and its job
 * is enqueued: from that commit on the deletion finishes without anyone asking again. The
 * request then tries once itself, so a deletion with nothing to wait for is done when it
 * answers. Whatever that try leaves, the job takes up after the first backoff.
 *
 * A request for a subject that is already marked changes nothing and enqueues nothing while
 * its job lives. When that job is dead, it enqueues a new one, due at once.
 */
export async function acceptDeletion<Payload extends JsonObject, Result>(
  options: ChatServerOptions,
  input: {
    job: JobKind<Payload>;
    payload: Payload;
    subjectId: string;
    correlationId: string;
    /** Marks the subject and records the request. Resolves false when it was marked before. */
    mark(stores: PlatformStores): Promise<boolean>;
    /** One pass of the deletion. Resolves undefined when the subject was gone already. */
    complete(): Promise<Result | undefined>;
  }
): Promise<DeletionOutcome<Result>> {
  const marked = await options.stores.transaction(async (stores) => {
    const newlyMarked = await input.mark(stores);
    await stores.jobs.enqueue(input.job, input.payload, {
      clientInstanceId: options.clientInstanceId,
      subject: input.subjectId,
      dedupeKey: deletionDedupeKey(input.job, input.subjectId),
      concurrencyKey: input.subjectId,
      correlationId: input.correlationId,
      // The request tries first. A repeated request tries nothing, so its job is due at once.
      ...(newlyMarked ? { runAfter: new Date(Date.now() + DELETION_BACKOFF_BASE_MS) } : {})
    });
    return newlyMarked;
  });
  if (!marked) return { status: "deferred" };
  try {
    const result = await input.complete();
    if (result !== undefined) return { status: "deleted", result };
  } catch (error) {
    // Class and code only: the message of a database error can carry values of the statement.
    options.logger.warn(
      {
        errorClass: error instanceof Error ? error.name : typeof error,
        ...(isAppError(error) ? { errorCode: error.code } : {}),
        kind: input.job.kind,
        subject: input.subjectId
      },
      "Deletion continues as a job"
    );
  }
  return { status: "deferred" };
}

export function deletionDedupeKey(job: JobKind, subjectId: string): string {
  return subjectDedupeKey(job.kind, subjectId);
}

/**
 * Retries the cleanup of Conversations that are deleted and still hold data, a workspace's or
 * those a user created, so a deletion does not wait for the retention job to do it.
 */
export async function retryPendingCleanup(
  options: ChatServerOptions,
  scope: PendingCleanupScope
): Promise<void> {
  for (;;) {
    const pass = await retryPendingConversationCleanup(options, {
      ...scope,
      limit: PENDING_CLEANUP_BATCH_SIZE,
      deletedAt: new Date().toISOString()
    });
    if (pass.cleanupPendingCount > 0 || pass.completedCount < PENDING_CLEANUP_BATCH_SIZE) return;
  }
}

/** How many Conversations in the scope still hold data, counted up to a limit. */
export async function countPendingCleanup(
  stores: PlatformStores,
  options: Pick<ChatServerOptions, "clientInstanceId">,
  scope: PendingCleanupScope
): Promise<number> {
  const pending = await stores.files.listConversationsPendingObjectCleanup({
    clientInstanceId: options.clientInstanceId,
    ...scope,
    limit: STALLED_PENDING_COUNT_LIMIT
  });
  return pending.length;
}

/** The runs of a subject in deletion: those its user started, or those in its workspace. */
export type RunsOfSubject =
  { ownerUserId: UserId } | { collaborationWorkspaceId: CollaborationWorkspaceId };

/**
 * Asks every run of the subject that has not ended to stop. A queued run ends at once; a
 * running one ends when its worker reads the request.
 */
export async function cancelRunsInProgress(
  options: ChatServerOptions,
  subject: RunsOfSubject
): Promise<void> {
  const runs = await options.stores.agentRuns.listAgentRunsInProgress({
    clientInstanceId: options.clientInstanceId,
    ...subject
  });
  for (const run of runs) {
    if (run.status === "cancelling") continue;
    try {
      await options.stores.agentRuns.requestAgentRunCancellation({
        clientInstanceId: options.clientInstanceId,
        runId: run.id,
        requestedAt: new Date().toISOString(),
        reason: RUN_CANCELLED_BY_DELETION
      });
    } catch (error) {
      // A run that ended meanwhile needs no request.
      if (!isAppError(error) || (error.code !== "CONFLICT" && error.code !== "NOT_FOUND")) {
        throw error;
      }
    }
  }
}

/** Throws while a run of the subject has not ended. The next pass of the deletion asks again. */
export async function requireRunsEnded(
  options: ChatServerOptions,
  subject: RunsOfSubject
): Promise<void> {
  const runs = await options.stores.agentRuns.listAgentRunsInProgress({
    clientInstanceId: options.clientInstanceId,
    ...subject
  });
  if (runs.length > 0) {
    throw new AppError("CONFLICT", "Agent runs of the deleted subject are still ending", {
      activeRunCount: runs.length
    });
  }
}

/**
 * The actor of a deletion as its job records it: the person who asked, read again by id,
 * because a job carries references only. A person who is gone by then is named by id alone.
 */
export async function deletionActor(
  options: ChatServerOptions,
  actorUserId: UserId
): Promise<AuditActor> {
  const users = await options.stores.users.listUsers({
    clientInstanceId: options.clientInstanceId
  });
  const user = users.find((candidate) => candidate.id === actorUserId);
  return {
    userId: actorUserId,
    displayLabel: user?.displayLabel ?? "Deleted user",
    roles: user?.roles ?? [],
    principalKind: "user",
    principalId: actorUserId,
    subjectUserId: actorUserId
  };
}
