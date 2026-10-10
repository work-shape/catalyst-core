import {
  createAgentRunJobs,
  createLocalAgentRunExecutor,
  type AgentRunJobs,
  type AgentRunSignal,
  type WorkerLocalAgentRuntimeOptions
} from "@vivd-catalyst/agent-runtime";
import {
  AppError,
  asUserId,
  type AgentRun,
  type AgentRunId,
  type AuthenticatedUser,
  type ClientInstanceId,
  type JobWorker,
  type Logger,
  type PlatformStores
} from "@vivd-catalyst/core";
import type { ClientInstanceEnv } from "./env";
import { createJobWorker } from "./job-worker";

// How many runs one process executes at once unless `AGENT_RUN_WORKER_CONCURRENCY` says
// otherwise. A run waits on its model and its tools most of the time, so the number is bound
// by memory and by the database pool, not by processors. The runs of an instance that execute
// at once are this number times its worker processes.
const DEFAULT_AGENT_RUN_WORKER_SLOTS = 8;

/**
 * Where the Agent Runs of the instance execute. `in_process`, the default: this process serves
 * `agent_run.execute` beside the API, which is all a single-process instance needs.
 * `separate`: only the worker processes started with `runAgentRunWorker` serve it, and the API
 * executes no run.
 */
export type AgentRunWorkerPlacement = "in_process" | "separate";

/** What the execution assembly of a client instance gives the Agent Run jobs. */
interface AgentRunExecutionAssembly {
  clientInstanceId: ClientInstanceId;
  store: PlatformStores;
  env: ClientInstanceEnv;
  localAgentRuntimeOptions: WorkerLocalAgentRuntimeOptions;
}

/** The job kinds that execute Agent Runs, for the process that serves them. */
export function createClientInstanceAgentRunJobs(
  execution: AgentRunExecutionAssembly,
  options: { onObservation?: (runId: AgentRunId) => void; cancellations?: AgentRunSignal } = {}
): AgentRunJobs {
  return createAgentRunJobs({
    clientInstanceId: execution.clientInstanceId,
    stores: execution.store,
    slots: readAgentRunWorkerConcurrency(execution.env) ?? DEFAULT_AGENT_RUN_WORKER_SLOTS,
    loadCurrentUser: (run) => loadCurrentUser(execution.store, run),
    execute: createLocalAgentRunExecutor(execution.localAgentRuntimeOptions),
    onObservation: options.onObservation,
    cancellations: options.cancellations
  });
}

/**
 * The job worker that serves the runs inside the API process. A worker of its own, so the runs
 * keep their slots and stop apart from the API's jobs. It tells the API's observers of every
 * stored event and hears of a cancellation at once.
 */
export function createInProcessAgentRunWorker(
  execution: AgentRunExecutionAssembly & { logger: Logger },
  signals: { observations: AgentRunSignal; cancellations: AgentRunSignal }
): JobWorker {
  return createJobWorker({
    stores: execution.store,
    clientInstanceId: execution.clientInstanceId,
    logger: execution.logger,
    ...createClientInstanceAgentRunJobs(execution, {
      onObservation: (runId) => signals.observations.notify(runId),
      cancellations: signals.cancellations
    })
  });
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

async function loadCurrentUser(store: PlatformStores, run: AgentRun): Promise<AuthenticatedUser> {
  const user = await store.users.getUser({
    clientInstanceId: run.clientInstanceId,
    userId: asUserId(run.ownerUserId)
  });
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
