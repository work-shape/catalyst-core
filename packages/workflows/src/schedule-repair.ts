import {
  WORKFLOW_RUN_JOB_KINDS,
  defineJobHandler,
  defineJobKind,
  type ClientInstanceId,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { WORKFLOW_DEFINITION_PAGE_SIZE, type WorkflowDefinitionSource } from "./definition-source";

import {
  WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS
} from "./limits";

/** A dead worker's page is recovered from its stored cursor after one lease. */
const SCHEDULE_REPAIR_LEASE_MS = 60_000;
/** One repair page runs at a time; the remaining pages wait on the shared executor. */
const SCHEDULE_REPAIR_SLOTS = 1;

/** One bounded repair page is replayable; its successor retains the exclusive definition id. */
const repairKind = defineJobKind({
  kind: WORKFLOW_RUN_JOB_KINDS.repairSchedules,
  payloadSchema: z.strictObject({ after: z.string().optional() }),
  maxAttempts: WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  backoff: { baseMs: WORKFLOW_STEP_JOB_BACKOFF_BASE_MS, maxMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS },
  leaseMs: SCHEDULE_REPAIR_LEASE_MS,
  concurrency: { global: SCHEDULE_REPAIR_SLOTS },
  manualRetry: false
});

/** Startup repairs one page before serving; subsequent pages survive a process restart. */
export function createScheduleRepair(options: {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  definitions: WorkflowDefinitionSource;
  planOne(workflow: string): Promise<{ workflow: string; dueAt: string } | undefined>;
}) {
  const { clientInstanceId, stores, definitions, planOne } = options;
  async function page(after?: string, signal?: AbortSignal) {
    const definitionsPage = await definitions.list({
      limit: WORKFLOW_DEFINITION_PAGE_SIZE + 1,
      ...(after === undefined ? {} : { after: [after] })
    });
    const rows = definitionsPage.slice(0, WORKFLOW_DEFINITION_PAGE_SIZE);
    const planned: { workflow: string; dueAt: string }[] = [];
    for (const { id } of rows) {
      signal?.throwIfAborted();
      const next = await planOne(id);
      if (next) planned.push(next);
    }
    return {
      planned,
      after: definitionsPage.length > rows.length ? rows.at(-1)?.id : undefined
    };
  }
  async function continueFrom(tx: PlatformStores, after: string | undefined) {
    if (after === undefined) return;
    await tx.jobs.enqueue(
      repairKind,
      { after },
      {
        clientInstanceId,
        // Concurrent startups share the same successor; a failed page can be replayed safely.
        dedupeKey: `${repairKind.kind}:${after}`
      }
    );
  }
  return {
    handler: defineJobHandler({
      kind: repairKind,
      slots: SCHEDULE_REPAIR_SLOTS,
      async run(job, control) {
        const next = await page(job.payload.after, control.signal);
        await control.transaction((tx) => continueFrom(tx, next.after));
      }
    }),
    async plan() {
      const next = await page();
      await stores.transaction((tx) => continueFrom(tx, next.after));
      return next.planned;
    }
  };
}
