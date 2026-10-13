import {
  WORKFLOW_RUN_JOB_KINDS,
  defineJobHandler,
  defineJobKind,
  isAppError,
  type ClientInstanceId,
  type PlatformStores,
  type RegisteredJobHandler,
  type WorkflowManifest
} from "@vivd-catalyst/core";
import { z } from "zod";
import { lastDueWithin, nextDueAfter, parseCron, type CronExpression } from "./cron";
import type { WorkflowDefinitionRevision, WorkflowDefinitionSource } from "./definition-source";
import {
  WORKFLOW_STEP_JOB_BACKOFF_BASE_MS,
  WORKFLOW_STEP_JOB_BACKOFF_MAX_MS,
  WORKFLOW_STEP_JOB_MAX_ATTEMPTS
} from "./limits";

// The `schedule` trigger. Each Workflow that has one has one job that waits for its next due
// time (`run_after`). When it is due the job starts the run of that time and queues the job
// of the time after it, in one transaction, so a due time is neither lost nor started twice
// whichever worker runs it and whenever a process dies.

/**
 * The job that fires one due time of one Workflow. `dueAt` is the time it was queued for:
 * the instance may have been down since, and then the job fires late.
 */
export const workflowScheduleJobKind = defineJobKind({
  kind: WORKFLOW_RUN_JOB_KINDS.fireSchedule,
  payloadSchema: z.strictObject({ workflow: z.string().min(1), dueAt: z.string().min(1) }),
  maxAttempts: WORKFLOW_STEP_JOB_MAX_ATTEMPTS,
  backoff: { baseMs: WORKFLOW_STEP_JOB_BACKOFF_BASE_MS, maxMs: WORKFLOW_STEP_JOB_BACKOFF_MAX_MS },
  leaseMs: 60_000,
  concurrency: {}
});

/** The cron expressions of the `schedule` triggers of a definition. None where it has none. */
function scheduleCrons(manifest: Pick<WorkflowManifest, "steps">): CronExpression[] {
  const [trigger] = manifest.steps;
  if (trigger?.type !== "trigger") return [];
  return trigger.triggers.flatMap((candidate) => {
    const cron = candidate.kind === "schedule" ? parseCron(candidate.cron) : undefined;
    return cron ? [cron] : [];
  });
}

/** Why a due time started no run. `started` and `fired` are no refusal. */
type ScheduledStart =
  | { outcome: "started" }
  /** A run for this due time exists: another worker or an earlier attempt started it. */
  | { outcome: "fired" }
  | { outcome: "skipped"; reason: string };

interface ScheduleTriggerOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  definitions: WorkflowDefinitionSource;
  /** The time zone the cron expressions are read in. */
  timeZone: string;
  now(): Date;
  /**
   * Checks what a start checks before a transaction is open. Answers the reason where the
   * Workflow cannot be started now, and otherwise how to start the run inside a transaction.
   */
  prepare(published: WorkflowDefinitionRevision): Promise<
    | { refused: string }
    | {
        start(
          tx: PlatformStores,
          scheduledFor: Date,
          correlationId: string
        ): Promise<ScheduledStart>;
      }
  >;
}

interface ScheduleTrigger {
  handler: RegisteredJobHandler;
  /**
   * Makes sure every published Workflow with a schedule has the job of its next due time. It
   * queues nothing for a Workflow that has one, so it is safe to call again: when a process
   * starts, and when a definition is published. Answers what it found due next.
   */
  plan(): Promise<{ workflow: string; dueAt: string }[]>;
}

export function createScheduleTrigger(options: ScheduleTriggerOptions): ScheduleTrigger {
  const { clientInstanceId, stores, definitions, timeZone, now } = options;

  /** The published definition, or nothing where there is none that can be run. */
  async function published(workflow: string): Promise<WorkflowDefinitionRevision | undefined> {
    try {
      return await definitions.read(workflow);
    } catch (error) {
      // A definition that is refused is no definition a schedule starts.
      if (isAppError(error)) return undefined;
      throw error;
    }
  }

  /** Queues the job of one due time. A job for that Workflow and time is queued once. */
  async function queue(tx: PlatformStores, workflow: string, due: Date): Promise<void> {
    const dueAt = due.toISOString();
    await tx.jobs.enqueue(
      workflowScheduleJobKind,
      { workflow, dueAt },
      {
        clientInstanceId,
        subject: workflow,
        runAfter: due,
        dedupeKey: `${workflowScheduleJobKind.kind}:${workflow}:${dueAt}`
      }
    );
  }

  const handler = defineJobHandler({
    kind: workflowScheduleJobKind,
    slots: 1,
    async run(job, control) {
      const { workflow, dueAt } = job.payload;
      const revision = await published(workflow);
      const crons = revision ? scheduleCrons(revision.manifest) : [];
      // The Workflow is gone or has no schedule any more: its line of jobs ends here.
      if (!revision || crons.length === 0) return;
      const moment = now();
      // Of the times that came due since the job was queued, the latest. A time the instance
      // was down for is not made up for one by one.
      const due = lastDueWithin(crons, new Date(dueAt), moment, timeZone);
      const prepared = due ? await options.prepare(revision) : undefined;
      const next = nextDueAfter(crons, moment, timeZone);
      await control.transaction(async (tx) => {
        if (due && prepared) {
          const started: ScheduledStart =
            "refused" in prepared
              ? { outcome: "skipped", reason: prepared.refused }
              : await prepared.start(tx, due, job.correlationId);
          if (started.outcome === "skipped") {
            await tx.audit.appendAuditEvent({
              clientInstanceId,
              type: "workflow_run.tick_skipped",
              status: "failed",
              actor: { displayLabel: "schedule", roles: [] },
              subject: workflow,
              correlationId: job.correlationId,
              metadata: {
                workflow,
                scheduledFor: due.toISOString(),
                reason: started.reason
              }
            });
          }
        }
        if (next) await queue(tx, workflow, next);
      });
    }
  });

  return {
    handler,
    async plan() {
      const planned: { workflow: string; dueAt: string }[] = [];
      for (const { id } of await definitions.list()) {
        const revision = await published(id);
        const next = revision
          ? nextDueAfter(scheduleCrons(revision.manifest), now(), timeZone)
          : undefined;
        if (!next) continue;
        await queue(stores, id, next);
        planned.push({ workflow: id, dueAt: next.toISOString() });
      }
      return planned;
    }
  };
}
