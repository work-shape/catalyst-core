import type { ResultShaper } from "@work-shape/catalyst-core";
import type { CatalogueEntry } from "@work-shape/catalyst-connections";
import {
  AppError,
  type ConnectorTypeDefinition,
  type JobWorker,
  type StructuredDataPublicationReviewer
} from "@work-shape/catalyst-core";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import type { ToolAssemblyDefinition } from "@work-shape/catalyst-tool-sdk";
import { createClientInstanceExecutionAssembly } from "./app";
import type { ClientInstanceCapability } from "./capabilities";
import { readClientInstanceEnv, type ClientInstanceEnv } from "./env";
import { createClientInstanceAgentRunJobs } from "./agent-run-jobs";
import { createJobWorker } from "./job-worker";
import { runWorkerUntilStopped } from "./worker-lifecycle";
import { registerModuleOperations } from "@work-shape/catalyst-server";

// How long a worker that was told to stop lets its runs end on their own. A run that is not
// done by then ends as interrupted and the person sends the message again.
export const DEFAULT_AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

export interface CreateClientInstanceAgentRunWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  tools: ToolAssemblyDefinition[];
  /** The Connector types of this build, the same ones the API process is given. */
  connectorTypes?: ConnectorTypeDefinition[];
  /** The catalogue entries of this build: their hosts join the egress list where offered. */
  catalogue?: readonly CatalogueEntry[];
  /** Synchronous result transformations registered by this build. */
  resultShapers?: Readonly<Record<string, ResultShaper>>;
  /** The capabilities of this build, the same ones the API process is given. */
  capabilities: readonly ClientInstanceCapability[];
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
  registerModuleOperations(execution.operationCalls.registry, execution.modulesStarted.routes);
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
  await runWorkerUntilStopped(service, {
    stoppingMessage: "Agent run worker is stopping",
    drainMs
  });
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
