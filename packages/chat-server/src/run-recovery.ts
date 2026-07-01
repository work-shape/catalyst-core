import type {
  AgentRun,
  AgentRunError,
  AgentRunId,
  AgentRuntimeEvent,
  RunObservation
} from "@vivd-catalyst/core";
import { isAppError } from "@vivd-catalyst/core";
import type { FastifyBaseLogger } from "fastify";
import type { ChatServerOptions } from "./types";

export interface RunRecoveryOptions {
  staleActiveRunMs?: number;
  watchdogIntervalMs?: number;
  batchSize?: number;
  runOnStartup?: boolean;
}

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
const DEFAULT_WATCHDOG_INTERVAL_MS = 60 * 1000;
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
  private readonly watchdogIntervalMs: number;
  private readonly batchSize: number;
  private readonly runOnStartup: boolean;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly options: ChatServerOptions,
    private readonly logger?: FastifyBaseLogger,
    recoveryOptions: RunRecoveryOptions = {}
  ) {
    this.staleActiveRunMs = recoveryOptions.staleActiveRunMs ?? DEFAULT_STALE_ACTIVE_RUN_MS;
    this.watchdogIntervalMs = recoveryOptions.watchdogIntervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;
    this.batchSize = recoveryOptions.batchSize ?? DEFAULT_BATCH_SIZE;
    this.runOnStartup = recoveryOptions.runOnStartup ?? true;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    if (this.runOnStartup) {
      void this.sweep().catch((error: unknown) => {
        this.logger?.warn({ err: error }, "Agent run recovery startup sweep failed");
      });
    }
    this.timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.logger?.warn({ err: error }, "Agent run recovery watchdog sweep failed");
      });
    }, this.watchdogIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async sweep(now = new Date()): Promise<RunRecoverySweepSummary> {
    if (this.running) {
      return { recovered: 0, checked: 0 };
    }
    this.running = true;
    try {
      const staleUpdatedBefore = staleCutoff(now, this.staleActiveRunMs);
      const candidates = await this.options.conversationStore.listStaleActiveAgentRuns({
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
        this.logger?.warn({ recovered, checked: candidates.length }, "Recovered stale active agent runs");
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
  if (!isActiveRun(run)) {
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
  const recovered = await options.conversationStore.recoverStaleAgentRun({
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
  await recordRecoveryAudit(options, recovered.run, new Date(input.recoveredAt)).catch(() => undefined);
  return {
    run: recovered.run,
    observation: recovered.observation
  };
}

export function isActiveRun(run: AgentRun): boolean {
  return ACTIVE_RUN_STATUSES.has(run.status);
}

export function isMissingLocalRuntimeState(error: unknown): boolean {
  return isAppError(error) && error.code === "NOT_FOUND";
}

export function recoveryEventFromObservation(
  observation: RunObservation | undefined
): AgentRuntimeEvent | undefined {
  return observation?.payload;
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
