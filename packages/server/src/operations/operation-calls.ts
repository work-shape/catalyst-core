import {
  asUserId,
  personalDataConversation,
  createOperationRegistry,
  isAgentAvailableInWorkspace,
  isAuthenticatedServicePrincipal,
  type AuthenticatedIdentity,
  type CollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import type { RunOperationDeps } from "@work-shape/catalyst-tool-execution";
import {
  ApprovalRequestWorkflow,
  type ApprovalRequestWorkflowOptions
} from "../approvals/approval-request-service";
import { createAppActionOperationSource } from "../apps/action-source";
import { guardAppOrigin } from "../apps/app-origin-guard";
import { createHeldAssetPreviewer } from "../approvals/held-asset-preview";
import {
  createOperationCallApprovalHandler,
  executeApprovedOperationCall
} from "../approvals/operation-call-approval-handler";
import { createOperationApprovalFiler } from "../approvals/operation-approval-filer";
import { publishApprovalKinds } from "../approvals/publish-approval";
import { createNoticeHandler } from "../notices/notice-kind";
import { createFeedbackReviewHandler } from "../feedback/feedback-review-kind";
import type { ChatServerOptions, OperationCalls, ResolvedChatServerOptions } from "../types";
import { resolveOperationResource } from "./operation-resource";
import { createAuditingEventEmitter } from "./event-emitter";
import { holdsWorkspaceBundle } from "../workspaces/workspace-access";
import {
  agentUseRefusal,
  callerAccess,
  recordAgentUseRefusal
} from "../workspaces/agent-availability";
import { createPublishNarrator } from "../publish-narrative/publish-narrator";
import type { BeforeActionCheck, PublishNarrativeStoredData } from "@work-shape/catalyst-core";

export type OperationCallsOptions = Pick<
  Omit<ResolvedChatServerOptions, "operationCalls">,
  | "clientInstanceId"
  | "stores"
  | "auditRecorder"
  | "authorizer"
  | "config"
  | "logger"
  | "modules"
  | "operations"
> & {
  /** Without it this process holds no call for an approval and refuses one that needs it. */
  approvalRequests?: ChatServerOptions["approvalRequests"] &
    Pick<ApprovalRequestWorkflowOptions, "checks">;
  /**
   * What answers at every before-event of a call, and dry at the publish question. Required,
   * so a process that forgets it fails to build instead of allowing everything: one that checks
   * nothing says so with `NO_BEFORE_ACTION_CHECK`.
   */
  checks: BeforeActionCheck;
  /**
   * The asset kinds of the instance: incomplete resources of declared rights are resolved
   * against them, and a held `assets.put` is shown as the asset it saves.
   */
  configAssets?: Pick<ResolvedChatServerOptions["configAssets"], "kinds">;
  /** The tools an agent's definition lists. Without it this process serves no agent. */
  agentToolNames?: RunOperationDeps["agentToolNames"];
  workflowAgentActor?: import("../approvals/operation-call-approval-handler").OperationCallApprovalOptions["workflowAgentActor"];
  /** Who sees which stored data, for the publish question's sentence. Absent without the module. */
  publishStoredData?: PublishNarrativeStoredData;
};

/**
 * The system sender the publish question names for a `mail.send` step, where release config
 * switches outbound mail on: the name on the From line, as MAIL-1 registers it, and the address.
 */
function mailSenderOf(
  config: OperationCallsOptions["config"]
): { mailSender: { name: string; address: string } } | Record<string, never> {
  const mail = config.infrastructure.mail;
  if (!mail?.outbound.enabled) return {};
  return {
    mailSender: {
      name: mail.sender.fromName ?? config.clientInstance.displayName,
      address: mail.sender.fromAddress
    }
  };
}

/** Builds the call path of one process. See `OperationCalls`. */
export function createOperationCalls(options: OperationCallsOptions): OperationCalls {
  const registry = createOperationRegistry();
  const { clientInstanceId } = options;
  const handlerOptions = {
    workflowAgentActor: options.workflowAgentActor,
    clientInstanceId,
    deps: () => deps,
    users: options.stores.users,
    personalApiKeys: options.stores.personalApiKeys,
    configAssets: options.stores.configAssets,
    ...(options.configAssets
      ? {
          assetPreview: createHeldAssetPreviewer({
            clientInstanceId,
            store: options.stores.configAssets,
            kinds: options.configAssets.kinds,
            modules: options.modules
          })
        }
      : {})
  };
  const policy: RunOperationDeps["policy"] = {
    personalConversation: (id, runId) =>
      personalDataConversation(options.stores, clientInstanceId, id, runId),
    instanceDefaults: options.config.policy.defaults,
    centralSettings: () => options.operations?.centralPolicySettings?.() ?? [],
    // Read for each call that acts for a person, so a value set a moment ago holds at once.
    personSetting: ({ userId, operation }) =>
      options.stores.userOperationSettings.get({ clientInstanceId, userId, operation }),
    alwaysAllowLocked: options.config.policy.alwaysAllow.locked
  };
  // The sentence a publish question opens with, the same for a read and a held publish. It
  // dry-evaluates runtime admission without executing a step, calling a model or keeping hits.
  const publishNarrator = createPublishNarrator({
    clientInstanceId,
    ...(options.config.clientInstance.timeZone === undefined
      ? {}
      : { timeZone: options.config.clientInstance.timeZone }),
    stores: options.stores,
    ...(options.configAssets ? { kinds: options.configAssets.kinds } : {}),
    checks: options.checks,
    resolve: (operation) => deps.registry.resolve(operation),
    policy,
    ...(options.publishStoredData ? { storedData: options.publishStoredData } : {}),
    ...mailSenderOf(options.config)
  });
  // A held publish is decided by the holders of the kind's `approve` right.
  const held = publishApprovalKinds({
    clientInstanceId,
    ...(options.configAssets ? { kinds: options.configAssets.kinds } : {}),
    store: options.stores.configAssets,
    drafts: options.stores.agentProposals,
    files: options.stores.pages,
    workspaces: options.stores.workspaces,
    narrator: publishNarrator,
    defaultLocale: options.config.localization.defaultLocale,
    effectOf: async (operation) => (await deps.registry.resolve(operation))?.effect
  });
  const handlers = [
    // A confirmation in the Inbox is an `operation_call`; it shows what a held kind's subject is.
    createOperationCallApprovalHandler({ ...handlerOptions, subjectKinds: held }),
    ...held.map((kind) => createOperationCallApprovalHandler(handlerOptions, kind)),
    // A notice the platform files for one person, such as a Workflow's (NOTIFY-a).
    createNoticeHandler(),
    // A comment on an agent's answer, for the agent's reviewers (LU-4).
    ...(options.modules.isEnabled("feedback")
      ? [
          createFeedbackReviewHandler({
            clientInstanceId,
            stores: options.stores,
            auditRecorder: options.auditRecorder
          })
        ]
      : [])
  ];
  const approvalRequestHandlers = new Map([
    ...(options.approvalRequests?.handlers ?? []),
    ...handlers.map((handler) => [handler.kind, handler] as const)
  ]);
  const filer = options.approvalRequests
    ? createOperationApprovalFiler({
        clientInstanceId,
        approvals: options.approvalRequests.store,
        held,
        authorizer: options.authorizer,
        configAssets: options.stores.configAssets,
        ...(handlerOptions.assetPreview ? { assetPreview: handlerOptions.assetPreview } : {}),
        creator: new ApprovalRequestWorkflow({
          ...options.approvalRequests,
          handlers: approvalRequestHandlers,
          clientInstanceId,
          auditRecorder: options.auditRecorder
        })
      })
    : undefined;
  const deps: RunOperationDeps = {
    clientInstanceId,
    instanceAdminName: () => options.stores.users.getInstanceAdminName({ clientInstanceId }),
    // What every call resolves its operation through, when it is made and when it is executed
    // after an approval. A call of a Connection operation that came from a frame of an App is
    // asked there whether its App still stands and its caller may still use it.
    registry: guardAppOrigin(registry, {
      clientInstanceId,
      store: options.stores.configAssets,
      modules: options.modules
    }),
    resolveResource: (resource) => resolveOperationResource(options, resource),
    runs: options.stores.operationRuns,
    authorizer: options.authorizer,
    events:
      options.operations?.events ??
      createAuditingEventEmitter(options.auditRecorder, options.checks),
    audit: options.auditRecorder,
    policy,
    approvals: options.operations?.approvals ?? filer,
    approvedToolCall: (run, runtime) =>
      run.approvalRequestId
        ? executeApprovedOperationCall(
            { ...handlerOptions, approvals: options.stores.approvals },
            run.approvalRequestId,
            runtime.signal,
            runtime
          )
        : Promise.resolve(undefined),
    liveOnce: options.stores.liveOnceSwitches,
    modules: options.modules,
    agentToolNames: options.agentToolNames,
    conversationWorkspace: async (id) =>
      (await options.stores.conversations.getConversation(clientInstanceId, id))
        ?.collaborationWorkspaceId,
    useRightRefusal: async (action, locale) => {
      const admin = await options.stores.users.getInstanceAdminName({ clientInstanceId });
      if ((locale ?? options.config.localization.defaultLocale) === "de") {
        const asset = action === "connection.use" ? "diese Verbindung" : "diese Wissensbasis";
        return `Dir fehlt das Recht, ${asset} zu verwenden. ${admin ? `Frag einen Instanz-Admin, zum Beispiel ${admin}.` : "Frag einen Instanz-Admin."} Diese Abfrage wurde deshalb nicht ausgeführt.`;
      }
      const asset = action === "connection.use" ? "this Connection" : "this Knowledge Base";
      return `You do not have permission to use ${asset}. ${admin ? `Ask an instance admin, for example ${admin}.` : "Ask an instance admin."}`;
    },
    worksInWorkspace: async ({ actor, workspaceId }) =>
      (await options.stores.workspaces.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspaceId,
        userId: asUserId(actor.id)
      })) !== undefined ||
      (!isAuthenticatedServicePrincipal(actor) &&
        (await holdsWorkspaceBundle(options, actor, workspaceId))),
    agentAvailable: (input) => agentAvailableTo(options, input),
    logger: options.logger,
    now: options.operations?.now
  };
  // The named actions of published Apps, as operations of this registry. A name of one is
  // read from the App when it is called, so nothing is read here.
  registry.addSource(
    createAppActionOperationSource({
      resolveResource: deps.resolveResource,
      clientInstanceId,
      store: options.stores.configAssets,
      modules: options.modules,
      registry,
      policy: deps.policy
    })
  );
  return { registry, deps, approvalRequestHandlers, publishNarrator };
}

/**
 * Whether an agent is available in a workspace now, by the rule a new run is started under
 * (`getWorkspaceAssetSnapshot`), and with an actor whether that person may use it there
 * (`agent.use`, AGENT-USE-1). With a correlation id, a refusal of `agent.use` is recorded as a
 * subagent's: the other caller, a call that waited, records its own refusal.
 */
async function agentAvailableTo(
  options: OperationCallsOptions,
  input: {
    agentName: string;
    workspaceId: CollaborationWorkspaceId;
    actor?: AuthenticatedIdentity;
    correlationId?: string;
  }
): Promise<boolean> {
  const { clientInstanceId } = options;
  const [workspace, availability] = await Promise.all([
    options.stores.workspaces.getWorkspace(clientInstanceId, input.workspaceId),
    options.stores.configAssets.listAgentAvailability({ clientInstanceId })
  ]);
  if (
    workspace === undefined ||
    !isAgentAvailableInWorkspace(availability.get(input.agentName), workspace)
  )
    return false;
  if (input.actor === undefined) return true;
  const [access, limited, asset] = await Promise.all([
    callerAccess(options, input.actor),
    options.stores.configAssets.listAgentUseLimits({
      clientInstanceId,
      agentName: input.agentName
    }),
    options.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name: input.agentName
    })
  ]);
  const keys = new Map(asset ? [[asset.name, { id: asset.id, scope: asset.scope }]] : []);
  const refusal = agentUseRefusal(access, { agentKeys: keys }, limited, input.agentName);
  if (refusal !== undefined && input.correlationId !== undefined)
    await recordAgentUseRefusal(
      options,
      {
        actor: input.actor,
        workspace,
        agentName: input.agentName,
        entry: "subagent",
        correlationId: input.correlationId
      },
      refusal,
      asset?.id
    );
  return refusal === undefined;
}
