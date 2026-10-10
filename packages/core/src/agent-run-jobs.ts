import { z } from "zod";
import type { AgentRunError } from "./agent-runtime";
import type { AgentRunId, ClientInstanceId } from "./ids";
import {
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  subjectDedupeKey,
  type EnqueueJobOptions
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
 * Gives a job to every run in progress that has none. In the transition release such a run
 * was accepted by an API of the previous release, or a worker of that release holds it: the
 * job of a held run ends at once and the next tick gives the run another, until that worker
 * is done or its lease ran out. After the transition the only such run is one whose job was
 * buried without its `onExhausted`; the job it gets here finds the run started and fails it.
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

/** What a run is failed with when its worker was stopped and the run did not end in time. */
export const AGENT_RUN_INTERRUPTED_ERROR: AgentRunError = {
  code: "AGENT_RUN_RUNTIME_INTERRUPTED",
  message: "Agent run worker stopped before completion",
  category: "runtime_interrupted"
};
