import { z } from "zod";
import type { AgentRunError } from "./agent-runtime";
import { asAgentRunId, type AgentRunId, type ClientInstanceId } from "./ids";
import { defineJobBurial, defineJobHandler, type RegisteredJobHandler } from "./job-handlers";
import type { PlatformStores } from "./platform-store";
import {
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  subjectDedupeKey,
  type EnqueueJobOptions,
  type JobId,
  type JobSchedule
} from "./jobs";

// The lease of a running Agent Run and of the copy on its row. A worker that was killed is
// noticed after this long. Until then the person sees the reply stand still and the
// conversation refuses the next message.
export const AGENT_RUN_LEASE_MS = 90 * 1000;
// How often the lease is renewed: five heartbeats may fail before the lease runs out. Each
// running run costs two row updates per heartbeat, one on its job and one on its row.
export const AGENT_RUN_HEARTBEAT_MS = 15 * 1000;
// How often a running run looks for a cancellation request on its row. A click on Stop reaches
// the worker within this time plus one database read.
export const AGENT_RUN_CANCELLATION_CHECK_INTERVAL_MS = 1000;
// How often runs in progress without a job are given one. A run that an API of the previous
// release accepted waits at most this long when no worker of that release is left to take it.
export const AGENT_RUN_ADOPTION_INTERVAL_MS = 15 * 1000;
// Runs one tick of the adoption gives a job. The next tick takes the rest.
export const AGENT_RUN_ADOPTION_BATCH_SIZE = 500;
const AGENT_RUN_ADOPTION_LEASE_MS = 2 * 60 * 1000;
// The longest a run may wait for a worker to take it. A run that is still queued after this
// long is failed, so its conversation takes the next message and the person is told. It must
// stay above the longest wait a healthy instance produces: the runs queued ahead, divided by
// the slots of all worker processes, times the length of a run. Raise it together with the
// backlog an instance is meant to carry, or add slots.
export const AGENT_RUN_MAX_QUEUED_MS = 10 * 60 * 1000;
// Queued runs one tick fails as waited too long. The next tick takes the rest.
const AGENT_RUN_QUEUED_TOO_LONG_BATCH_SIZE = 500;

/**
 * Executes one row of `agent_runs`. The row stays the record the interface reads; the job is
 * the only claim on it. Enqueued by the run store in the transaction that accepts the run and
 * served by the Agent Run worker.
 *
 * One attempt: a run that ran half has called models and tools, so it is reported failed to
 * the person, who sends the message again, and is never executed a second time. No retry by
 * hand either: the job of a run that has ended finds its row ended and does nothing.
 */
export const executeAgentRunJob = defineJobKind({
  kind: "agent_run.execute",
  payloadSchema: z.object({ runId: z.string().min(1) }),
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: AGENT_RUN_LEASE_MS,
  heartbeatMs: AGENT_RUN_HEARTBEAT_MS,
  // One run per conversation is kept by the unique index on `agent_runs`. How many run at once
  // is the sum of the slots of the worker processes.
  concurrency: {},
  manualRetry: false
});

/** How the job of a run is enqueued: one live job per run. */
export function agentRunJobOptions(run: {
  clientInstanceId: ClientInstanceId;
  id: AgentRunId;
  correlationId?: string;
}): EnqueueJobOptions {
  return {
    clientInstanceId: run.clientInstanceId,
    subject: run.id,
    dedupeKey: subjectDedupeKey(executeAgentRunJob.kind, run.id),
    ...(run.correlationId ? { correlationId: run.correlationId } : {})
  };
}

/**
 * The upkeep of the runs, served by every process that runs a job worker, the API included,
 * so that it goes on while no Agent Run worker is up.
 *
 * It gives a job to every run in progress that has none and that nobody holds. In the
 * transition release such a run was accepted by an API of the previous release, or a worker
 * of that release held it and is gone. After the transition the only such run is one whose
 * job was buried without its `onExhausted`; the job it gets here finds the run started and
 * fails it. A run that a worker of the previous release holds under a live lease gets no job:
 * that worker ends it, or its lease runs out and the run is adopted then.
 *
 * It also fails every run that is still queued after `AGENT_RUN_MAX_QUEUED_MS`.
 */
export const adoptAgentRunsJob = defineJobKind({
  kind: "agent_run.adopt",
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: AGENT_RUN_ADOPTION_LEASE_MS,
  concurrency: { global: 1 },
  // The next tick is the retry of a failed one.
  manualRetry: false
});

export const adoptAgentRunsSchedule = defineSchedule({
  kind: adoptAgentRunsJob,
  every: AGENT_RUN_ADOPTION_INTERVAL_MS,
  // Runs in flight at the upgrade get their job as soon as the new worker is up.
  dueAtStart: true
});

/**
 * What a run is failed with when its worker is gone: the process was killed, or it lost its
 * lease. The category is the one the interface already shows as an interrupted reply, so an
 * API of the previous release reads it too.
 */
export const AGENT_RUN_WORKER_LOST_ERROR: AgentRunError = {
  code: "AGENT_RUN_WORKER_LOST",
  message: "The worker of this agent run was lost before the run ended",
  category: "runtime_interrupted"
};

/**
 * What a run is failed with when no worker took it within `AGENT_RUN_MAX_QUEUED_MS`: none is
 * up, or the backlog is longer than the workers can take in that time. The interface tells
 * the code apart from an interrupted reply; the category is one an API of the previous
 * release reads too.
 */
export const AGENT_RUN_NOT_STARTED_ERROR: AgentRunError = {
  code: "AGENT_RUN_NOT_STARTED",
  message: "No worker took this agent run in time",
  category: "runtime_interrupted"
};

/** What a run is failed with when its worker was stopped and the run did not end in time. */
export const AGENT_RUN_INTERRUPTED_ERROR: AgentRunError = {
  code: "AGENT_RUN_RUNTIME_INTERRUPTED",
  message: "Agent run worker stopped before completion",
  category: "runtime_interrupted"
};

/**
 * Ends the run of a job whose worker is gone, with its audit event. A queued run, an ended
 * run and a run that someone else holds under a live lease are left as they are.
 */
export async function failAgentRunOfLostJob(
  stores: PlatformStores,
  input: { clientInstanceId: ClientInstanceId; runId: AgentRunId; jobId: JobId }
): Promise<void> {
  const failed = await stores.agentRuns.failLostAgentRun({
    ...input,
    error: AGENT_RUN_WORKER_LOST_ERROR
  });
  if (failed) await recordRecovery(stores, failed, AGENT_RUN_WORKER_LOST_ERROR);
}

async function recordRecovery(
  stores: PlatformStores,
  run: { id: AgentRunId; clientInstanceId: ClientInstanceId; correlationId: string } & {
    conversationId: string;
  },
  error: AgentRunError
): Promise<void> {
  await stores.audit.appendAuditEvent({
    clientInstanceId: run.clientInstanceId,
    type: "agent_run.recovered",
    status: "failed",
    subject: run.id,
    correlationId: run.correlationId,
    metadata: {
      conversationId: run.conversationId,
      errorCategory: error.category,
      errorCode: error.code
    }
  });
}

export interface AgentRunUpkeepOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  /** Called for every run the upkeep ended, so a process that serves the API wakes its observers. */
  onObservation?(runId: AgentRunId): void;
}

/**
 * What a process that does not execute runs serves of them: the upkeep tick, and the burial
 * of `agent_run.execute` jobs whose worker is gone. With it a killed worker's run is failed
 * after its lease time by whichever process is up.
 */
export function createAgentRunUpkeepJobs(options: AgentRunUpkeepOptions): {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
} {
  return {
    handlers: [
      defineJobBurial({
        kind: executeAgentRunJob,
        onExhausted: (job, txStores) =>
          failAgentRunOfLostJob(txStores, {
            clientInstanceId: options.clientInstanceId,
            runId: asAgentRunId(job.payload.runId),
            jobId: job.id
          })
      }),
      agentRunUpkeepHandler(options)
    ],
    schedules: [adoptAgentRunsSchedule]
  };
}

/** The handler of the upkeep tick. A process that executes runs registers it beside them. */
export function agentRunUpkeepHandler(options: AgentRunUpkeepOptions): RegisteredJobHandler {
  const { clientInstanceId, stores } = options;
  return defineJobHandler({
    kind: adoptAgentRunsJob,
    slots: 1,
    async run(_job, control) {
      // An enqueue under a live dedupe key inserts nothing, so a tick may run twice.
      const runs = await stores.agentRuns.listAgentRunsWithoutJob({
        clientInstanceId,
        jobKind: executeAgentRunJob.kind,
        limit: AGENT_RUN_ADOPTION_BATCH_SIZE
      });
      for (const run of runs) {
        await stores.jobs.enqueue(
          executeAgentRunJob,
          { runId: run.id },
          agentRunJobOptions({ clientInstanceId, ...run })
        );
      }
      if (runs.length > 0) control.logger.info({ runs: runs.length }, "Adopted agent runs");

      // Each run changes only while it is still queued, so a tick that was taken over fails
      // nothing twice. The job of a run failed here finds it ended and does nothing.
      const waitedTooLong = await stores.transaction(async (txStores) => {
        const failed = await txStores.agentRuns.failAgentRunsQueuedTooLong({
          clientInstanceId,
          queuedMs: AGENT_RUN_MAX_QUEUED_MS,
          error: AGENT_RUN_NOT_STARTED_ERROR,
          limit: AGENT_RUN_QUEUED_TOO_LONG_BATCH_SIZE
        });
        for (const run of failed) await recordRecovery(txStores, run, AGENT_RUN_NOT_STARTED_ERROR);
        return failed;
      });
      for (const run of waitedTooLong) options.onObservation?.(run.id);
      if (waitedTooLong.length > 0)
        control.logger.warn(
          { runs: waitedTooLong.length },
          "Failed agent runs that no worker took in time"
        );
    }
  });
}
