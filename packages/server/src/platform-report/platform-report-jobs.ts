import {
  PLATFORM_REPORT_RETENTION_DAYS,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  type JobSchedule,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Reports one pass removes, and passes per daily tick. A larger backlog goes the next day. */
const PRUNE_BATCH_SIZE = 500;
const PRUNE_BATCHES_PER_TICK = 20;

/** Removes the records of platform problem reports older than 90 days (PLATFORM-REPORT). */
const prunePlatformReportsJob = defineJobKind({
  kind: "platform_report.prune",
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 10 * 60 * 1000,
  concurrency: { global: 1 },
  manualRetry: false
});

export function createPlatformReportJobs(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores">,
  now: () => Date = () => new Date()
): { handlers: RegisteredJobHandler[]; schedules: JobSchedule[] } {
  return {
    handlers: [
      defineJobHandler({
        kind: prunePlatformReportsJob,
        slots: 1,
        async run(_job, control) {
          await prunePlatformReports(options, now(), () => control.signal.aborted);
        }
      })
    ],
    schedules: [defineSchedule({ kind: prunePlatformReportsJob, every: DAY_MS })]
  };
}

/** Removes what the retention has made due. Answers how many reports it removed. */
async function prunePlatformReports(
  options: Pick<ChatServerOptions, "clientInstanceId" | "stores">,
  at: Date,
  aborted: () => boolean = () => false
): Promise<number> {
  const before = new Date(at.getTime() - PLATFORM_REPORT_RETENTION_DAYS * DAY_MS);
  let count = 0;
  for (let batch = 0; batch < PRUNE_BATCHES_PER_TICK && !aborted(); batch++) {
    const removed = await options.stores.platformReports.deletePlatformReportsBefore({
      clientInstanceId: options.clientInstanceId,
      before,
      limit: PRUNE_BATCH_SIZE
    });
    count += removed;
    if (removed < PRUNE_BATCH_SIZE) break;
  }
  return count;
}
