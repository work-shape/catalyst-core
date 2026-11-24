import {
  KNOWLEDGE_JOB_KINDS,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  knowledgeExtractJob,
  knowledgeExtractJobPayloadSchema,
  scheduledJobPayloadSchema,
  type JobId,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import { indexTargetOf } from "./index-job";
import type { KnowledgeRuntime } from "./runtime";

// `knowledge_base.recover_extracts`: an extract job that used up its attempts while the store of
// files or the document worker was down could not store its failure either, so its content
// stayed `pending` with no job left to move it: unsearchable, and counted neither indexed nor
// failed. Every few minutes this tick queues such a dead job again, as Retry on the jobs page
// would: only where its content is still `pending` and has a live document, and at most
// `RECOVERY_BATCH` a tick, so a large backlog comes back in steps the extract queue absorbs. A
// job whose content left `pending`, or whose Knowledge Base is gone, stays dead. A job that
// dies again comes back at a later tick; one whose attempts end in a stored failure leaves its
// content failed with its code, and is not looked at again.

const RECOVERY_INTERVAL_MS = 5 * 60_000;
/** Dead extract jobs read at a time. */
const RECOVERY_PAGE = 200;
/** The most dead extract jobs one tick queues again. */
const RECOVERY_BATCH = 100;

const recoverExtractsJob = defineJobKind({
  kind: KNOWLEDGE_JOB_KINDS.recoverExtracts,
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 5 * 60_000,
  concurrency: { global: 1 },
  manualRetry: false
});

/** Where the index job is served: a dead extract job found after a restart comes back at once. */
export const knowledgeExtractRecoverySchedule = defineSchedule({
  kind: recoverExtractsJob,
  every: RECOVERY_INTERVAL_MS,
  dueAtStart: true
});

export function createKnowledgeExtractRecoveryHandler(
  runtime: KnowledgeRuntime
): RegisteredJobHandler {
  const { clientInstanceId } = runtime;
  return defineJobHandler({
    kind: recoverExtractsJob,
    slots: 1,
    async run(_job, control) {
      const targets = new Map<string, Awaited<ReturnType<typeof indexTargetOf>>>();
      let afterId: JobId | undefined;
      let requeued = 0;
      for (;;) {
        const page = await runtime.stores.jobs.listDead(knowledgeExtractJob, {
          clientInstanceId,
          ...(afterId === undefined ? {} : { afterId }),
          limit: RECOVERY_PAGE
        });
        for (const job of page) {
          if (requeued >= RECOVERY_BATCH) break;
          control.signal.throwIfAborted();
          const payload = knowledgeExtractJobPayloadSchema.safeParse(job.payload);
          if (!payload.success) continue;
          const { knowledgeBaseId, contentSha256 } = payload.data;
          if (!targets.has(knowledgeBaseId))
            targets.set(knowledgeBaseId, await indexTargetOf(runtime, knowledgeBaseId));
          const found = targets.get(knowledgeBaseId);
          if (!found) continue;
          const content = await found.store.readContent(contentSha256, control.signal);
          if (content?.state !== "pending" || !content.document) continue;
          // A live job of the same content and copy supersedes it; that one moves the content.
          const retried = await runtime.stores.jobs.retry({ clientInstanceId, id: job.id });
          if (retried.outcome === "requeued") requeued += 1;
        }
        if (requeued >= RECOVERY_BATCH || page.length < RECOVERY_PAGE) break;
        afterId = page.at(-1)?.id;
      }
      if (requeued > 0)
        control.logger.info({ requeued }, "Dead extract jobs of pending contents queued again");
    }
  });
}
