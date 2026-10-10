import { createLogger } from "./logger";
import {
  AppError,
  type JobWorker,
  type StructuredDataPublicationReviewer
} from "@vivd-catalyst/core";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import { createClientInstanceExecutionAssembly } from "./app";
import type { ClientInstanceCapability } from "./capabilities";
import { readClientInstanceEnv, type ClientInstanceEnv } from "./env";
import { createClientInstanceAgentRunJobs } from "./agent-run-jobs";
import { createJobWorker } from "./job-worker";

// How long a worker that was told to stop lets its runs end on their own. A run that is not
// done by then ends as interrupted and the person sends the message again.
export const DEFAULT_AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

export interface CreateClientInstanceAgentRunWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  tools: ToolAssemblyDefinition[];
  capabilities?: ClientInstanceCapability[];
  structuredDataPublicationReviewer?: StructuredDataPublicationReviewer;
}

export interface ClientInstanceAgentRunWorker {
  readonly config: ClientInstanceConfig;
  /** The job worker that serves `agent_run.execute`. */
  readonly worker: JobWorker;
  /** Starts the worker and resolves once `stop` has ended its runs. */
  runUntilStopped(): Promise<void>;
  /**
   * Stops claiming. With `drainMs` the running runs get that long to end; the ones left are
   * ended as interrupted. A second call ends the drain at once.
   */
  stop(input?: { drainMs?: number }): Promise<void>;
  close(): Promise<void>;
}

export async function createClientInstanceAgentRunWorker(
  input: CreateClientInstanceAgentRunWorkerInput
): Promise<ClientInstanceAgentRunWorker> {
  const execution = await createClientInstanceExecutionAssembly(input);
  const workerId = execution.env.AGENT_RUN_WORKER_ID;
  const worker = createJobWorker({
    stores: execution.store,
    clientInstanceId: execution.clientInstanceId,
    // The worker id names this process in the log lines of its jobs.
    logger: workerId ? execution.logger.child({ workerId }) : execution.logger,
    ...createClientInstanceAgentRunJobs(execution)
  });
  let stopped: (() => void) | undefined;
  const untilStopped = new Promise<void>((resolve) => {
    stopped = resolve;
  });

  return {
    config: execution.config,
    worker,
    runUntilStopped() {
      worker.start();
      return untilStopped;
    },
    async stop(stopInput = {}) {
      try {
        await worker.stop(stopInput);
      } finally {
        stopped?.();
      }
    },
    close: () => execution.close()
  };
}

export async function runClientInstanceAgentRunWorker(
  input: CreateClientInstanceAgentRunWorkerInput
): Promise<void> {
  const service = await createClientInstanceAgentRunWorker(input);
  const drainMs = readAgentRunWorkerDrainTimeoutMs(readClientInstanceEnv(input.env));
  let signals = 0;
  // The first signal drains the running runs up to the timeout; a second one ends them now.
  const stop = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals > 2) return;
    createLogger().info({ signal, draining: signals === 1 }, "Agent run worker is stopping");
    service.stop(signals === 1 ? { drainMs } : {}).catch((error: unknown) => {
      createLogger().error({ error }, "Worker shutdown failed");
      process.exitCode = 1;
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await service.runUntilStopped();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await service.close();
  }
}

export function readAgentRunWorkerDrainTimeoutMs(env: ClientInstanceEnv): number {
  const raw = env.AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS;
  if (!raw) return DEFAULT_AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS must be a non-negative integer"
    );
  }
  return value;
}

export { readAgentRunWorkerConcurrency } from "./agent-run-jobs";
