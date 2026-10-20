import {
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  type JobSchedule,
  type RegisteredJobHandler,
  type UserId
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { removeFeedback } from "./feedback-review-kind";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Comments one pass removes, and passes per daily tick. A larger backlog goes the next day. */
const PRUNE_BATCH_SIZE = 500;
const PRUNE_BATCHES_PER_TICK = 20;

/** Removes the comments older than `retention.feedbackDays`, with their Inbox items. */
const pruneFeedbackJob = defineJobKind({
  kind: "feedback.prune",
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 10 * 60 * 1000,
  concurrency: { global: 1 },
  manualRetry: false
});

type FeedbackJobOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "config" | "modules" | "auditRecorder"
>;

/**
 * Feedback keeps its own retention, 365 days unless release config says otherwise, whatever
 * became of the conversation. Where the module is off nothing is removed: switching it on
 * again finds the comments as they were, and the retention takes them from there.
 */
export function createFeedbackJobs(
  options: FeedbackJobOptions,
  now: () => Date = () => new Date()
): { handlers: RegisteredJobHandler[]; schedules: JobSchedule[] } {
  if (!options.modules.isEnabled("feedback")) return { handlers: [], schedules: [] };
  return {
    handlers: [
      defineJobHandler({
        kind: pruneFeedbackJob,
        slots: 1,
        async run(job, control) {
          const count = await pruneFeedback(options, now(), () => control.signal.aborted);
          if (count === 0) return;
          await options.auditRecorder.record({
            type: "feedback.pruned",
            status: "success",
            correlationId: job.correlationId,
            metadata: { count, retentionDays: options.config.retention.feedbackDays }
          });
        }
      })
    ],
    schedules: [defineSchedule({ kind: pruneFeedbackJob, every: DAY_MS })]
  };
}

/** Removes what the retention has made due. Answers how many comments it removed. */
async function pruneFeedback(
  options: Pick<FeedbackJobOptions, "clientInstanceId" | "stores" | "config">,
  at: Date,
  aborted: () => boolean = () => false
): Promise<number> {
  const before = new Date(at.getTime() - options.config.retention.feedbackDays * DAY_MS);
  let count = 0;
  for (let batch = 0; batch < PRUNE_BATCHES_PER_TICK && !aborted(); batch++) {
    const due = await options.stores.feedback.listExpiredFeedback({
      clientInstanceId: options.clientInstanceId,
      before,
      limit: PRUNE_BATCH_SIZE
    });
    count += await removeFeedback(options, due, {
      status: "superseded",
      reason: "retention"
    });
    if (due.length < PRUNE_BATCH_SIZE) break;
  }
  return count;
}

/**
 * Removes every comment a person wrote, with its Inbox item, when their account is deleted.
 * Safe to repeat.
 */
export async function removeFeedbackOfAuthor(
  options: Pick<FeedbackJobOptions, "clientInstanceId" | "stores">,
  userId: UserId
): Promise<number> {
  let count = 0;
  for (;;) {
    const written = await options.stores.feedback.listFeedbackOfAuthor({
      clientInstanceId: options.clientInstanceId,
      authorUserId: userId,
      limit: PRUNE_BATCH_SIZE
    });
    count += await removeFeedback(options, written, {
      status: "superseded",
      reason: "account_deleted"
    });
    if (written.length < PRUNE_BATCH_SIZE) return count;
  }
}
