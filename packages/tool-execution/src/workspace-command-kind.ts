import {
  defineJobKind,
  defineSchedule,
  scheduledJobPayloadSchema,
  subjectDedupeKey,
  type ExecutionWorkspaceId,
  type WorkspaceCommandId
} from "@vivd-catalyst/core";
import { z } from "zod";

// The lease of a running command and of the copy on its row, as the command worker's own loop
// held it. A worker that dies is noticed after this long; the executor renews the lease every
// third of it.
export const WORKSPACE_COMMAND_LEASE_MS = 10 * 60 * 1000;
// How often a running command looks for a cancellation request on its row, as the old loop did.
export const WORKSPACE_COMMAND_CANCELLATION_CHECK_INTERVAL_MS = 1000;
// Transition release only: how often commands without a job are given one. Such a command
// waits at most this long when no worker of the previous release is left to take it.
const WORKSPACE_COMMAND_ADOPTION_INTERVAL_MS = 15 * 1000;
const SCHEDULED_LEASE_MS = 2 * 60 * 1000;

/**
 * Runs one row of `workspace_commands`. The row stays the record the tools read; the job is the
 * only claim on it. Enqueued by the command client in the transaction that writes the row and
 * served by the command worker.
 *
 * One attempt: a command that ran half is reported failed to the agent, which decides what to
 * do, and is never run a second time. One command per workspace at a time, in the order queued.
 */
export const runWorkspaceCommandJob = defineJobKind({
  kind: "workspace.command",
  payloadSchema: z.object({ commandId: z.string().min(1) }),
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: WORKSPACE_COMMAND_LEASE_MS,
  concurrency: { perKey: 1 }
});

/** How the job of a command is enqueued: one live job per command, one running per workspace. */
export function workspaceCommandJobOptions(command: {
  id: WorkspaceCommandId;
  workspaceId: ExecutionWorkspaceId;
}): { subject: string; dedupeKey: string; concurrencyKey: string } {
  return {
    subject: command.id,
    dedupeKey: subjectDedupeKey(runWorkspaceCommandJob.kind, command.id),
    concurrencyKey: command.workspaceId
  };
}

function defineScheduledKind(kind: string) {
  return defineJobKind({
    kind,
    payloadSchema: scheduledJobPayloadSchema,
    maxAttempts: 1,
    backoff: { baseMs: 0, maxMs: 0 },
    leaseMs: SCHEDULED_LEASE_MS,
    concurrency: { global: 1 }
  });
}

/**
 * Transition release only: gives a job to every command that waits for work and has none. An
 * API of the previous release queued it, or a worker of that release left it behind. It goes
 * with the lease columns of `workspace_commands` in the contract step.
 */
export const adoptWorkspaceCommandsJob = defineScheduledKind("workspace_command.adopt_legacy");

export const adoptWorkspaceCommandsSchedule = defineSchedule({
  kind: adoptWorkspaceCommandsJob,
  every: WORKSPACE_COMMAND_ADOPTION_INTERVAL_MS,
  // Commands in flight at the upgrade get their job as soon as the new worker is up.
  dueAtStart: true
});

/** Removes the hydrated workspace directories that no command has used for the idle time. */
export const cleanWorkspaceCommandTempStateJob = defineScheduledKind(
  "workspace_command.clean_temp_state"
);
