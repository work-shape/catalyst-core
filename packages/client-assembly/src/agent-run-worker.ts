import {
  AgentRunWorker,
  createWorkerLocalAgentRunExecutor,
  type AgentRunWorkerStopInput
} from "@vivd-catalyst/agent-runtime";
import {
  AppError,
  type AgentRun,
  type AuthenticatedUser,
  type PlatformStore,
  type StructuredDataPublicationReviewer
} from "@vivd-catalyst/core";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import type { ToolAssemblyDefinition } from "@vivd-catalyst/tool-sdk";
import { createClientInstanceExecutionAssembly } from "./app";
import type { ClientInstanceCapability } from "./capabilities";
import type { ClientInstanceEnv } from "./env";
import type { PlatformStoreMode } from "./store";

export interface CreateClientInstanceAgentRunWorkerInput {
  config?: ClientInstanceConfig;
  configPath?: string;
  env?: ClientInstanceEnv;
  storeMode?: PlatformStoreMode;
  tools: ToolAssemblyDefinition[];
  capabilities?: ClientInstanceCapability[];
  structuredDataPublicationReviewer?: StructuredDataPublicationReviewer;
}

export interface ClientInstanceAgentRunWorker {
  readonly config: ClientInstanceConfig;
  readonly worker: AgentRunWorker;
  runUntilStopped(): Promise<void>;
  stop(input?: AgentRunWorkerStopInput): Promise<void>;
  close(): Promise<void>;
}

export async function createClientInstanceAgentRunWorker(
  input: CreateClientInstanceAgentRunWorkerInput
): Promise<ClientInstanceAgentRunWorker> {
  const execution = await createClientInstanceExecutionAssembly(input);
  if (execution.storeMode !== "postgres") {
    await execution.close();
    throw new AppError("VALIDATION_FAILED", "Agent workers require the Postgres platform store");
  }

  const worker = new AgentRunWorker({
    clientInstanceId: execution.clientInstanceId,
    store: execution.store,
    conversationHistory: execution.store,
    workerId: execution.env.AGENT_RUN_WORKER_ID,
    concurrency: readAgentRunWorkerConcurrency(execution.env),
    loadCurrentUser: (run) => loadCurrentUser(execution.store, run),
    execute: createWorkerLocalAgentRunExecutor(execution.localAgentRuntimeOptions)
  });

  return {
    config: execution.config,
    worker,
    runUntilStopped: () => worker.runUntilStopped(),
    stop: (stopInput) => worker.stop(stopInput),
    close: () => execution.close()
  };
}

export async function runClientInstanceAgentRunWorker(
  input: CreateClientInstanceAgentRunWorkerInput
): Promise<void> {
  const service = await createClientInstanceAgentRunWorker(input);
  const drainTimeoutMs = readAgentRunWorkerDrainTimeoutMs(input.env ?? process.env);
  let signals = 0;
  // First signal drains active runs up to the timeout; a second one interrupts them now.
  const stop = (signal: NodeJS.Signals) => {
    signals += 1;
    if (signals > 2) return;
    service
      .stop(
        signals === 1
          ? { drainTimeoutMs, reason: `Received ${signal}; drain timeout elapsed` }
          : { interruptActive: true, reason: `Received ${signal} again` }
      )
      .catch((error: unknown) => {
        console.error(error);
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

export const DEFAULT_AGENT_RUN_WORKER_DRAIN_TIMEOUT_MS = 15 * 60 * 1000;

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

export function readAgentRunWorkerConcurrency(env: ClientInstanceEnv): number | undefined {
  const raw = env.AGENT_RUN_WORKER_CONCURRENCY;
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new AppError(
      "VALIDATION_FAILED",
      "AGENT_RUN_WORKER_CONCURRENCY must be a positive integer"
    );
  }
  return value;
}

async function loadCurrentUser(store: PlatformStore, run: AgentRun): Promise<AuthenticatedUser> {
  const user = (await store.listUsers({ clientInstanceId: run.clientInstanceId })).find(
    (candidate) => candidate.id === run.ownerUserId
  );
  if (!user || user.status !== "active") {
    throw new AppError("FORBIDDEN", "Agent run owner is unavailable or disabled");
  }
  const principal = run.authorization?.principal;
  const identity =
    principal?.kind === "user"
      ? user.identities.find(
          (candidate) =>
            candidate.authSource === principal.authSource &&
            candidate.externalUserId === principal.externalUserId
        )
      : user.identities[0];
  return {
    id: user.id,
    externalUserId: identity?.externalUserId ?? user.id,
    displayLabel: user.displayLabel,
    email: user.email,
    roles: user.roles,
    permissionRefs: user.permissionRefs,
    permissions: user.permissions,
    clientInstanceId: user.clientInstanceId,
    authSource: identity?.authSource ?? "agent-worker",
    subjectUserId: user.id
  };
}
