import {
  isAuthenticatedServicePrincipal,
  servicePrincipalAsRunUser
} from "@work-shape/catalyst-core";
import {
  createAgentRunJobs,
  createLocalAgentRunExecutor,
  type AgentRunJobs,
  type AgentRunJobsOptions,
  type AgentRunSignal,
  type WorkerLocalAgentRuntimeOptions
} from "@work-shape/catalyst-agent-runtime";
import {
  AppError,
  agentUseRefusalOf,
  asUserId,
  createAuthorizer,
  isAgentAvailableInWorkspace,
  type AgentRun,
  type AuthenticatedUser,
  type ClientInstanceId,
  type JobWorker,
  type Logger,
  type OperationRegistry,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { workflowAgentActor, workflowAgentCall, workflowAgentInput } from "./workflow-agent-actor";
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
  operationCalls: { registry: Pick<OperationRegistry, "resolveMany"> };
}

/** The job kinds that execute Agent Runs, for the process that serves them. */
export function createClientInstanceAgentRunJobs(
  execution: AgentRunExecutionAssembly,
  options: Pick<AgentRunJobsOptions, "onObservation" | "cancellations" | "unattended"> = {}
): AgentRunJobs {
  return createAgentRunJobs({
    clientInstanceId: execution.clientInstanceId,
    stores: execution.store,
    slots: readAgentRunWorkerConcurrency(execution.env) ?? DEFAULT_AGENT_RUN_WORKER_SLOTS,
    loadCurrentUser: (run) =>
      loadCurrentUser(execution.store, execution.operationCalls.registry, run),
    loadWorkflowAgent: (run) => workflowAgentInput(execution.store, run),
    loadWorkflowAgentDraft: async (run) => {
      const call = await workflowAgentCall(execution.store, execution.operationCalls.registry, run);
      return call && "draft" in call ? call.draft : undefined;
    },
    execute: createLocalAgentRunExecutor(execution.localAgentRuntimeOptions),
    onObservation: options.onObservation,
    cancellations: options.cancellations,
    ...(options.unattended ? { unattended: options.unattended } : {})
  });
}

/**
 * The job worker that serves the runs inside the API process. A worker of its own, so the runs
 * keep their slots and stop apart from the API's jobs. It tells the API's observers of every
 * stored event and hears of a cancellation at once.
 */
export function createInProcessAgentRunWorker(
  execution: AgentRunExecutionAssembly & { logger: Logger },
  signals: { observations: AgentRunSignal; cancellations: AgentRunSignal },
  unattended?: AgentRunJobsOptions["unattended"]
): JobWorker {
  return createJobWorker({
    stores: execution.store,
    clientInstanceId: execution.clientInstanceId,
    logger: execution.logger,
    ...createClientInstanceAgentRunJobs(execution, {
      onObservation: (runId) => signals.observations.notify(runId),
      cancellations: signals.cancellations,
      ...(unattended ? { unattended } : {})
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

/** Whether `agent.use` refuses the owner the agent now (AGENT-USE-1), as a new start decides. */
async function scheduledAgentUseRefused(
  store: PlatformStores,
  owner: AuthenticatedUser,
  agentName: string
): Promise<boolean> {
  const [limited, asset, access] = await Promise.all([
    store.configAssets.listAgentUseLimits({ clientInstanceId: owner.clientInstanceId, agentName }),
    store.configAssets.getConfigAsset({
      clientInstanceId: owner.clientInstanceId,
      kind: "agent",
      name: agentName
    }),
    createAuthorizer(store.access).forActor(owner)
  ]);
  const resource = {
    kind: "agent",
    name: agentName,
    ...(asset ? { assetId: asset.id } : {}),
    ...(asset?.scope.kind === "workspace" ? { workspaceId: asset.scope.workspaceId } : {})
  };
  return (
    agentUseRefusalOf(access.authorize("agent.use", resource), limited.has(agentName)) !== undefined
  );
}

async function loadCurrentUser(
  store: PlatformStores,
  registry: Pick<OperationRegistry, "resolveMany">,
  run: AgentRun
): Promise<AuthenticatedUser> {
  if (run.workflowStepRunId) {
    const actor = await workflowAgentActor(store, registry, run);
    if (!actor)
      throw new AppError("FORBIDDEN", "Workflow principal is unavailable or disabled", {
        reason: "run_as_disabled"
      });
    return isAuthenticatedServicePrincipal(actor) ? servicePrincipalAsRunUser(actor) : actor;
  }
  if (!run.ownerUserId) throw new AppError("FORBIDDEN", "Agent run has no owner");
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
  const current: AuthenticatedUser = {
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
  // The queued job is not a permission snapshot. Revocation between tick and execution
  // closes it here, before a model or a tool sees the prompt.
  const scheduled = await store.scheduledStarts.isScheduledAgentRun({
    clientInstanceId: run.clientInstanceId,
    runId: run.id
  });
  if (scheduled) {
    const conversation = await store.conversations.getConversation(
      run.clientInstanceId,
      run.conversationId
    );
    const workspace =
      conversation &&
      (await store.workspaces.getWorkspace(
        run.clientInstanceId,
        conversation.collaborationWorkspaceId
      ));
    const member =
      workspace &&
      (await store.workspaces.getMembership({
        clientInstanceId: run.clientInstanceId,
        collaborationWorkspaceId: workspace.id,
        userId: asUserId(run.ownerUserId)
      }));
    const availability = await store.configAssets.listAgentAvailability({
      clientInstanceId: run.clientInstanceId
    });
    if (
      !workspace ||
      !member ||
      !isAgentAvailableInWorkspace(availability.get(run.agentName), workspace) ||
      (await scheduledAgentUseRefused(store, current, run.agentName))
    )
      throw new AppError(
        "FORBIDDEN",
        "Scheduled prompt owner can no longer use this agent in this workspace"
      );
  }
  return current;
}
