import {
  AppError,
  WORKFLOW_RUN_JOB_KINDS,
  defineJobHandler,
  defineJobKind,
  isAppError,
  type ClientInstanceId,
  type PlatformStores,
  type RegisteredJobHandler,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import { z } from "zod";
import { isTimeZone, lastDueWithin, nextDueAfter, parseCron, type CronExpression } from "./cron";
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

/** The key of the job of one due time of one Workflow: that job is queued once. */
const scheduleJobKey = (workflow: string, dueAt: string) =>
  `${workflowScheduleJobKind.kind}:${workflow}:${dueAt}`;

/** Queues the job of one due time. A job for that Workflow and time is queued once. */
async function queueScheduleJob(
  tx: Pick<PlatformStores, "jobs">,
  clientInstanceId: ClientInstanceId,
  workflow: string,
  due: Date
): Promise<void> {
  const dueAt = due.toISOString();
  await tx.jobs.enqueue(
    workflowScheduleJobKind,
    { workflow, dueAt },
    {
      clientInstanceId,
      subject: workflow,
      runAfter: due,
      dedupeKey: scheduleJobKey(workflow, dueAt)
    }
  );
}

/**
 * Makes the waiting schedule job of one Workflow the one of the definition that is published
 * from now on, for whoever publishes a definition or deletes the Workflow, with `tx` bound to
 * the transaction that does it. The job of the next due time of the definition before is
 * withdrawn and the one of the definition now is queued, so a Workflow that is published is
 * scheduled without a process starting, and one that lost its schedule waits for nothing.
 *
 * A job whose time has come already is not found here and stays: it reads the published
 * definition when it fires and starts nothing the definition does not name. Answers the due
 * time that is queued now.
 */
export async function replaceScheduleJob(
  tx: Pick<PlatformStores, "jobs">,
  input: {
    clientInstanceId: ClientInstanceId;
    workflow: string;
    /** The definition that was published until now, where one was. */
    previous?: Pick<WorkflowManifest, "steps">;
    /** The definition that is published now. Left out where none is: after a delete. */
    published?: Pick<WorkflowManifest, "steps">;
    /** The time zone the cron expressions are read in: the engine's. */
    timeZone: string;
    now: Date;
  }
): Promise<Date | undefined> {
  const { clientInstanceId, workflow, timeZone, now } = input;
  const dueOf = (manifest: Pick<WorkflowManifest, "steps"> | undefined) =>
    manifest ? nextDueAfter(scheduleCrons(manifest), now, timeZone) : undefined;
  const before = dueOf(input.previous);
  const next = dueOf(input.published);
  if (before && before.getTime() !== next?.getTime()) {
    await tx.jobs.withdraw(workflowScheduleJobKind, {
      clientInstanceId,
      dedupeKey: scheduleJobKey(workflow, before.toISOString())
    });
  }
  if (next) await queueScheduleJob(tx, clientInstanceId, workflow, next);
  return next;
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
  /**
   * The same for one Workflow: called when its definition is published or taken back. It
   * answers nothing, and queues nothing, where the Workflow has no schedule; a job that was
   * queued for a schedule it no longer has ends its line when its time comes.
   */
  planOne(workflow: string): Promise<{ workflow: string; dueAt: string } | undefined>;
}

export function createScheduleTrigger(options: ScheduleTriggerOptions): ScheduleTrigger {
  const { clientInstanceId, stores, definitions, timeZone, now } = options;
  if (!isTimeZone(timeZone)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `'${timeZone}' is no time zone: the instance's time zone is an IANA name such as 'Europe/Berlin', or 'UTC'`
    );
  }

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

  const queue = (tx: Pick<PlatformStores, "jobs">, workflow: string, due: Date) =>
    queueScheduleJob(tx, clientInstanceId, workflow, due);

  const handler = defineJobHandler({
    kind: workflowScheduleJobKind,
    slots: 1,
    async run(job, control) {
      const { workflow, dueAt } = job.payload;
      const revision = await published(workflow);
      const crons = revision ? scheduleCrons(revision.manifest) : [];
      // The Workflow is gone or has no schedule any more: its line of jobs ends here.
      if (!revision || crons.length === 0) return;
      const moment = firedAt(dueAt);
      // Of the times that came due since the job was queued, the latest. A time the instance
      // was down for is not made up for one by one.
      const due = lastDueWithin(crons, new Date(dueAt), moment, timeZone);
      const prepared = due ? await options.prepare(revision) : undefined;
      // After the moment the job fired at, so never the job's own time: the job of the next
      // due time is another job than this one, and it exists when this one ends.
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
    },
    // Every attempt of this due time crashed. The schedule does not end with it: the job of
    // the next due time is queued, and this time is the one that was lost.
    async onExhausted(job, tx) {
      const { workflow, dueAt } = job.payload;
      const revision = await published(workflow);
      const crons = revision ? scheduleCrons(revision.manifest) : [];
      const next = nextDueAfter(crons, firedAt(dueAt), timeZone);
      if (next) await queue(tx, workflow, next);
    }
  });

  /**
   * The moment a job fired at. The job was claimed because the database's clock had reached
   * its time, so it is due whatever the clock of this process says: a process whose clock is
   * behind does not answer that nothing is due yet. A process that runs the job late, or
   * whose clock is ahead, fires at its own clock.
   */
  function firedAt(dueAt: string): Date {
    return new Date(Math.max(now().getTime(), Date.parse(dueAt)));
  }

  async function planOne(
    workflow: string
  ): Promise<{ workflow: string; dueAt: string } | undefined> {
    const revision = await published(workflow);
    const next = revision
      ? nextDueAfter(scheduleCrons(revision.manifest), now(), timeZone)
      : undefined;
    if (!next) return undefined;
    await queue(stores, workflow, next);
    return { workflow, dueAt: next.toISOString() };
  }

  return {
    handler,
    planOne,
    async plan() {
      const planned: { workflow: string; dueAt: string }[] = [];
      for (const { id } of await definitions.list()) {
        const next = await planOne(id);
        if (next) planned.push(next);
      }
      return planned;
    }
  };
}
