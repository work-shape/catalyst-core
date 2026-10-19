import {
  asUserId,
  createOperationRegistry,
  isAgentAvailableInWorkspace
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
import type { ChatServerOptions, OperationCalls, ResolvedChatServerOptions } from "../types";
import { resolveOperationResource } from "./operation-resource";
import { createAuditingEventEmitter } from "./event-emitter";
import type { GuardrailRunner } from "../guardrails/guardrail-runner";
import { createPublishNarrator } from "../publish-narrative/publish-narrator";
import type { PublishNarrativeStoredData } from "@work-shape/catalyst-core";

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
    Pick<ApprovalRequestWorkflowOptions, "guardrails">;
  /** Runs the guardrails at every before-event of a call. Without it nothing is checked. */
  guardrails?: GuardrailRunner;
  /**
   * The asset kinds of the instance: incomplete resources of declared rights are resolved
   * against them, and a held `assets.put` is shown as the asset it saves.
   */
  configAssets?: Pick<ResolvedChatServerOptions["configAssets"], "kinds">;
  /** The tools an agent's definition lists. Without it this process serves no agent. */
  agentToolNames?: RunOperationDeps["agentToolNames"];
  /** Who sees which stored data, for the publish question's sentence. Absent without the module. */
  publishStoredData?: PublishNarrativeStoredData;
};

/** Builds the call path of one process. See `OperationCalls`. */
export function createOperationCalls(options: OperationCallsOptions): OperationCalls {
  const registry = createOperationRegistry();
  const { clientInstanceId } = options;
  const handlerOptions = {
    clientInstanceId,
    deps: () => deps,
    users: options.stores.users,
    configAssets: options.stores.configAssets,
    ...(options.configAssets
      ? {
          assetPreview: createHeldAssetPreviewer({
            clientInstanceId,
            store: options.stores.configAssets,
            kinds: options.configAssets.kinds,
            namespaces: options.stores.access,
            modules: options.modules
          })
        }
      : {})
  };
  const policy: RunOperationDeps["policy"] = {
    instanceDefaults: options.config.policy.defaults,
    centralSettings: () => options.operations?.centralPolicySettings?.() ?? []
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
    ...(options.guardrails ? { guardrails: options.guardrails } : {}),
    resolve: (operation) => deps.registry.resolve(operation),
    policy,
    ...(options.publishStoredData ? { storedData: options.publishStoredData } : {})
  });
  // A held publish is decided by the holders of the kind's `approve` right.
  const held = publishApprovalKinds({
    clientInstanceId,
    ...(options.configAssets ? { kinds: options.configAssets.kinds } : {}),
    store: options.stores.configAssets,
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
    createNoticeHandler()
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
      createAuditingEventEmitter(options.auditRecorder, options.guardrails),
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
    workspaceMember: async ({ userId, workspaceId }) =>
      (await options.stores.workspaces.getMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspaceId,
        userId: asUserId(userId)
      })) !== undefined,
    agentAvailable: async ({ agentName, workspaceId }) => {
      const [workspace, availability] = await Promise.all([
        options.stores.workspaces.getWorkspace(clientInstanceId, workspaceId),
        options.stores.configAssets.listAgentAvailability({ clientInstanceId })
      ]);
      // The rule a new run is started under (`getWorkspaceAssetSnapshot`).
      return (
        workspace !== undefined &&
        isAgentAvailableInWorkspace(availability.get(agentName), workspace)
      );
    },
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
