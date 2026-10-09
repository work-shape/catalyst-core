import type { AgentRun, AgentRunError, RunObservation } from "@vivd-catalyst/core";
import { isAppError } from "@vivd-catalyst/core";
import type { Logger } from "@vivd-catalyst/core";
import type { ChatServerOptions, RunRecoveryOptions } from "./types";

export interface RunRecoverySweepSummary {
  recovered: number;
  checked: number;
}

export interface RunRecoveryResult {
  run: AgentRun;
  observation?: RunObservation;
}

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting_for_permission", "cancelling"]);
const DEFAULT_STALE_ACTIVE_RUN_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 50;

export const RUN_RECOVERY_ERROR: AgentRunError = {
  code: "AGENT_RUN_RUNTIME_INTERRUPTED",
  message: "Agent run was interrupted after the local runtime state was lost",
  category: "runtime_interrupted"
};

/**
 * Conservative stale-run policy:
 * - only active durable statuses are eligible: queued, running, waiting_for_permission, cancelling
 * - terminal runs are never mutated
 * - an active run is stale only when its durable updatedAt is older than the configured cutoff
 * - recovery records a minimized run_failed observation and marks the run failed
 * - if a terminal observation already exists, recovery fixes the run row from that observation instead
 */
export class RunRecoveryWatchdog {
  private readonly staleActiveRunMs: number;
  private readonly batchSize: number;
  private running = false;

  constructor(
    private readonly options: ChatServerOptions,
    private readonly logger?: Logger,
    recoveryOptions: RunRecoveryOptions = {}
  ) {
    this.staleActiveRunMs = recoveryOptions.staleActiveRunMs ?? DEFAULT_STALE_ACTIVE_RUN_MS;
    this.batchSize = recoveryOptions.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /**
   * A runtime that keeps runs in its own process lost them all when the last process ended.
   * Every run the store still calls active from before this start, and that this process does
   * not hold, is recovered at once: its conversation would otherwise refuse new messages until
   * the stale cutoff. A runtime whose runs live with workers is left to their leases.
   * This assumes one process per instance, which is what such a runtime supports: a second
   * process started on the same database would end the first one's live runs here.
   */
  async recoverRunsLostWithProcess(startedAt = new Date()): Promise<RunRecoverySweepSummary> {
    const { agentRuntime } = this.options;
    if (!agentRuntime.holdsRun) {
      return { recovered: 0, checked: 0 };
    }
    let recovered = 0;
    let checked = 0;
    for (;;) {
      const candidates = await this.options.stores.agentRuns.listStaleActiveAgentRuns({
        clientInstanceId: this.options.clientInstanceId,
        staleUpdatedBefore: startedAt.toISOString(),
        limit: this.batchSize
      });
      let recoveredInBatch = 0;
      for (const run of candidates) {
        if (agentRuntime.holdsRun(run.id)) continue;
        if (await recoverInterruptedRun(this.options, run, { now: startedAt })) {
          recoveredInBatch += 1;
        }
      }
      checked += candidates.length;
      recovered += recoveredInBatch;
      // A batch that changed nothing would be listed again unchanged.
      if (candidates.length < this.batchSize || recoveredInBatch === 0) break;
    }
    if (recovered > 0) {
      this.logger?.warn({ recovered, checked }, "Recovered agent runs lost with the last process");
    }
    return { recovered, checked };
  }

  async sweep(now = new Date()): Promise<RunRecoverySweepSummary> {
    if (this.running) {
      return { recovered: 0, checked: 0 };
    }
    this.running = true;
    try {
      const staleUpdatedBefore = staleCutoff(now, this.staleActiveRunMs);
      const candidates = await this.options.stores.agentRuns.listStaleActiveAgentRuns({
        clientInstanceId: this.options.clientInstanceId,
        staleUpdatedBefore,
        limit: this.batchSize
      });
      let recovered = 0;
      for (const run of candidates) {
        const result = await recoverStaleRun(this.options, run, {
          now,
          staleActiveRunMs: this.staleActiveRunMs
        });
        if (result) {
          recovered += 1;
        }
      }
      if (recovered > 0) {
        this.logger?.warn(
          { recovered, checked: candidates.length },
          "Recovered stale active agent runs"
        );
      }
      return { recovered, checked: candidates.length };
    } finally {
      this.running = false;
    }
  }
}

export async function recoverStaleRun(
  options: ChatServerOptions,
  run: AgentRun,
  input: { now?: Date; staleActiveRunMs?: number } = {}
): Promise<RunRecoveryResult | undefined> {
  const now = input.now ?? new Date();
  const staleActiveRunMs = input.staleActiveRunMs ?? DEFAULT_STALE_ACTIVE_RUN_MS;
  if (!isActiveRun(run) || run.updatedAt >= staleCutoff(now, staleActiveRunMs)) {
    return undefined;
  }
  return recoverActiveRun(options, run, {
    recoveredAt: now.toISOString(),
    staleUpdatedBefore: staleCutoff(now, staleActiveRunMs)
  });
}

export async function recoverInterruptedRun(
  options: ChatServerOptions,
  run: AgentRun,
  input: { now?: Date } = {}
): Promise<RunRecoveryResult | undefined> {
  const now = input.now ?? new Date();
  if (!isActiveRun(run) || hasLiveLease(run, now)) {
    return undefined;
  }
  return recoverActiveRun(options, run, {
    recoveredAt: now.toISOString(),
    staleUpdatedBefore: new Date(now.getTime() + 1).toISOString()
  });
}

async function recoverActiveRun(
  options: ChatServerOptions,
  run: AgentRun,
  input: {
    recoveredAt: string;
    staleUpdatedBefore: string;
  }
): Promise<RunRecoveryResult | undefined> {
  const recovered = await options.stores.agentRuns.recoverStaleAgentRun({
    clientInstanceId: options.clientInstanceId,
    runId: run.id,
    ownerUserId: run.ownerUserId,
    staleUpdatedBefore: input.staleUpdatedBefore,
    recoveredAt: input.recoveredAt,
    error: RUN_RECOVERY_ERROR
  });
  if (recovered.status !== "recovered") {
    return undefined;
  }
  await recordRecoveryAudit(options, recovered.run, new Date(input.recoveredAt)).catch(
    () => undefined
  );
  return {
    run: recovered.run,
    observation: recovered.observation
  };
}

export function isActiveRun(run: AgentRun): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

// A worker holding an unexpired lease still owns the run, whatever this process can see locally.
function hasLiveLease(run: AgentRun, now: Date): boolean {
  return run.leaseExpiresAt !== undefined && new Date(run.leaseExpiresAt) > now;
}

export function isMissingLocalRuntimeState(error: unknown): boolean {
  return isAppError(error) && error.code === "NOT_FOUND";
}

function staleCutoff(now: Date, staleActiveRunMs: number): string {
  return new Date(now.getTime() - staleActiveRunMs).toISOString();
}

async function recordRecoveryAudit(
  options: ChatServerOptions,
  run: AgentRun,
  recoveredAt: Date
): Promise<void> {
  await options.auditRecorder.record({
    type: "agent_run.recovered",
    status: "failed",
    subject: run.id,
    correlationId: run.correlationId,
    metadata: {
      conversationId: run.conversationId,
      errorCategory: RUN_RECOVERY_ERROR.category,
      errorCode: RUN_RECOVERY_ERROR.code,
      recoveredAt: recoveredAt.toISOString()
    }
  });
}
