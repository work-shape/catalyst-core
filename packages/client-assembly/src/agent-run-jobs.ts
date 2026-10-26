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
import { setTimeout as delay } from "node:timers/promises";
import type { ChatAttachmentService } from "@work-shape/catalyst-server";
import { createUploadFileContent } from "@work-shape/catalyst-capability-sdk";
import type { WorkflowRunFiles } from "@work-shape/catalyst-workflows";
import {
  AppError,
  agentUseRefusalOf,
  asUserId,
  isAppError,
  PENDING_ATTACHMENT_STATUSES,
  createAuthorizer,
  isAgentAvailableInWorkspace,
  type AgentRun,
  type AttachmentManifest,
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
  /** The attachment handlers, which prepare the files a Workflow agent step gets. */
  attachments?: WorkflowFileAttachments;
  /** The files of Workflow runs; absent where the instance keeps none. */
  runFiles?: Pick<WorkflowRunFiles, "read">;
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
    ...withWorkflowFiles(execution),
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

/** The longest a Workflow agent run waits for its files to be prepared before it starts. */
const WORKFLOW_FILES_WAIT_MS = 10 * 60 * 1_000;
const WORKFLOW_FILES_POLL_MS = 1_000;
const PREPARING = new Set<string>(PENDING_ATTACHMENT_STATUSES);

type WorkflowFileAttachments = Pick<
  ChatAttachmentService,
  "uploadDraftAttachment" | "listDraftAttachments" | "createAttachmentManifest"
>;

/**
 * Gives a Workflow agent step's run the files its task names: each is copied into the run's
 * thread as a draft attachment, as an upload would be, so the attachment handlers prepare it
 * where they keep their files. The run waits until each is ready or refused, and their
 * manifest is stored on the task message. A copy has the run file's checksum, so a run that
 * starts again finds the copies it made. A file that is gone since the step checked it is left
 * out, and so is one no handler takes, such as a spreadsheet, which the agent knows by name
 * only. One still preparing at the end of the wait fails the run: the agent never starts
 * without a document its task names.
 */
async function attachWorkflowFiles(
  store: PlatformStores,
  runFiles: Pick<WorkflowRunFiles, "read">,
  attachments: WorkflowFileAttachments,
  input: { run: AgentRun; fileIds: readonly string[]; signal: AbortSignal }
): Promise<AttachmentManifest> {
  const { run, signal } = input;
  const { clientInstanceId, conversationId } = run;
  const step = run.workflowStepRunId
    ? await store.workflowRuns.getStepRun({ clientInstanceId, id: run.workflowStepRunId })
    : undefined;
  if (!step) throw new AppError("NOT_FOUND", "Workflow agent step is unavailable");
  const attachmentIds = new Set<string>();
  const fileCopies: Record<string, string> = {};
  for (const fileId of new Set(input.fileIds)) {
    const read = await runFiles.read(fileId);
    if (!read) continue;
    if (
      read.file.owner?.kind !== "workflow_run" ||
      read.file.owner.id !== step.runId ||
      read.file.ownerUserId !== (run.ownerUserId ?? run.principalId)
    )
      throw new AppError("NOT_FOUND", "The file is not available to this Workflow agent step");
    let attachment;
    try {
      ({ attachment } = await attachments.uploadDraftAttachment({
        conversationId,
        ownerUserId: read.file.ownerUserId,
        filename: read.file.filename,
        ...(read.file.mimeType ? { mimeType: read.file.mimeType } : {}),
        content: createUploadFileContent(read.bytes)
      }));
    } catch (error) {
      // No handler takes this kind of file, such as a spreadsheet: the agent goes without it.
      if (isAppError(error) && (error.code === "BAD_REQUEST" || error.code === "VALIDATION_FAILED"))
        continue;
      throw error;
    }
    attachmentIds.add(attachment.id);
    fileCopies[fileId] = attachment.fileId;
  }
  const listed = async () =>
    (await attachments.listDraftAttachments(conversationId)).filter((attachment) =>
      attachmentIds.has(attachment.id)
    );
  const deadline = Date.now() + WORKFLOW_FILES_WAIT_MS;
  let current = await listed();
  while (current.some((attachment) => PREPARING.has(attachment.status)) && Date.now() < deadline) {
    await delay(WORKFLOW_FILES_POLL_MS, undefined, { signal });
    current = await listed();
  }
  if (current.some((attachment) => PREPARING.has(attachment.status))) {
    throw new AppError(
      "CONFLICT",
      "A file of the step was still being prepared when the wait ended",
      {
        reason: "files_unavailable"
      }
    );
  }
  const attachmentManifest = attachments.createAttachmentManifest(current);
  await store.childAgentRuns.attachWorkflowAgentFiles({
    clientInstanceId,
    runId: run.id,
    attachmentManifest,
    fileCopies,
    claimedAt: new Date().toISOString()
  });
  return attachmentManifest;
}

function withWorkflowFiles(
  execution: AgentRunExecutionAssembly
): Pick<AgentRunJobsOptions, "attachWorkflowFiles"> {
  const { attachments, runFiles, store } = execution;
  if (!attachments || !runFiles) return {};
  return {
    attachWorkflowFiles: (input) => attachWorkflowFiles(store, runFiles, attachments, input)
  };
}
