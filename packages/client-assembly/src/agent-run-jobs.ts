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
  type PlatformStores
} from "@vivd-catalyst/core";
import type { ClientInstanceEnv } from "./env";

// How many runs one process executes at once unless `AGENT_RUN_WORKER_CONCURRENCY` says
// otherwise. A run waits on its model and its tools most of the time, so the number is bound
// by memory and by the database pool, not by processors. The runs of an instance that execute
// at once are this number times its worker processes.
const DEFAULT_AGENT_RUN_WORKER_SLOTS = 8;

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
