import { createOperationRegistry } from "@vivd-catalyst/core";
import type { RunOperationDeps } from "@vivd-catalyst/tool-execution";
import {
  ApprovalRequestWorkflow,
  type ApprovalRequestWorkflowOptions
} from "../approval-request-workflow";
import {
  createOperationApprovalFiler,
  createOperationCallApprovalHandler
} from "../operation-call-approval-handler";
import type { ChatServerOptions, OperationCalls, ResolvedChatServerOptions } from "../types";
import { createAuditingEventEmitter } from "./event-emitter";

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
    Pick<ApprovalRequestWorkflowOptions, "checkRunner">;
  /** The tools an agent's definition lists. Without it this process serves no agent. */
  agentToolNames?: RunOperationDeps["agentToolNames"];
};

/** Builds the call path of one process. See `OperationCalls`. */
export function createOperationCalls(options: OperationCallsOptions): OperationCalls {
  const registry = createOperationRegistry();
  const { clientInstanceId } = options;
  const handler = createOperationCallApprovalHandler({
    clientInstanceId,
    deps: () => deps,
    users: options.stores.users
  });
  const approvalRequestHandlers = new Map([
    ...(options.approvalRequests?.handlers ?? []),
    [handler.kind, handler]
  ]);
  const filer = options.approvalRequests
    ? createOperationApprovalFiler({
        clientInstanceId,
        store: options.approvalRequests.store,
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
    registry,
    runs: options.stores.operationRuns,
    authorizer: options.authorizer,
    events: options.operations?.events ?? createAuditingEventEmitter(options.auditRecorder),
    audit: options.auditRecorder,
    policy: {
      instanceDefaults: options.config.policy.defaults,
      centralSettings: () => options.operations?.centralPolicySettings?.() ?? []
    },
    approvals: options.operations?.approvals ?? filer,
    modules: options.modules,
    agentToolNames: options.agentToolNames,
    logger: options.logger,
    now: options.operations?.now
  };
  return { registry, deps, approvalRequestHandlers };
}
