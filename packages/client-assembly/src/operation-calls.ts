import {
  ApprovalCheckRunner,
  ApprovalRequestWorkflow,
  createOperationCalls,
  type ChatServerOptions,
  type OperationCalls
} from "@vivd-catalyst/chat-server";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  createAuthorizer,
  type ApprovalRequestHandlerRegistry,
  type AuditRecorder,
  type Authorizer,
  type ClientInstanceId,
  type ConfigAssetSource,
  type Logger,
  type ModuleSnapshot,
  type PlatformStores,
  type ToolOperationRunner
} from "@vivd-catalyst/core";
import type { ModelGateway } from "@vivd-catalyst/model-provider";
import {
  createToolOperationRunner,
  registerToolOperations,
  type DataToolSource,
  type ToolRegistry
} from "@vivd-catalyst/tool-execution";

export interface InstanceOperationCallsInput {
  clientInstanceId: ClientInstanceId;
  config: ClientInstanceConfig;
  logger: Logger;
  modules: ModuleSnapshot;
  store: PlatformStores;
  auditRecorder: AuditRecorder;
  modelGateway: ModelGateway;
  /** Where an agent's definition is read, for the tools it lists. */
  assetSource: ConfigAssetSource;
  /** The approval kinds the assembly brings. The kind of a held call is added to them. */
  approvalRequestHandlers: ApprovalRequestHandlerRegistry;
  operations?: ChatServerOptions["operations"];
}

export interface InstanceOperationCalls {
  authorizer: Authorizer;
  operationCalls: OperationCalls;
  /** Files approval requests of every kind of the instance, a held call's among them. */
  approvalRequestCreator: ApprovalRequestWorkflow;
}

/**
 * The one call path of a process: an agent's tool call and a person's call of an operation
 * take the same checks, leave the same kind of run and wait for the same kind of approval.
 */
export function createInstanceOperationCalls(
  input: InstanceOperationCallsInput
): InstanceOperationCalls {
  const { clientInstanceId, config, store, auditRecorder, assetSource } = input;
  const authorizer = createAuthorizer(store.access);
  const checkRunner = new ApprovalCheckRunner({
    clientInstanceId,
    config,
    modelGateway: input.modelGateway
  });
  const operationCalls = createOperationCalls({
    clientInstanceId,
    stores: store,
    auditRecorder,
    authorizer,
    config,
    logger: input.logger,
    modules: input.modules,
    operations: input.operations,
    approvalRequests: {
      store: store.approvals,
      handlers: input.approvalRequestHandlers,
      checkRunner
    },
    async agentToolNames(agentName) {
      const assets = await assetSource.getSnapshot();
      return assets.agents.find((candidate) => candidate.name === agentName)?.toolNames ?? [];
    }
  });
  const approvalRequestCreator = new ApprovalRequestWorkflow({
    clientInstanceId,
    store: store.approvals,
    handlers: operationCalls.approvalRequestHandlers,
    checkRunner,
    onDecided: (request) => store.approvals.appendApprovalDecision(request),
    auditRecorder
  });
  return { authorizer, operationCalls, approvalRequestCreator };
}

/** What an agent's runs get of the instance's tools. */
export interface InstanceAgentTools {
  toolRegistry: ToolRegistry;
  /** Where the tools that exist as data are described. Without it an agent has release tools only. */
  dataTools?: DataToolSource;
  dataToolDescribeTimeoutMs: number;
  runTool: ToolOperationRunner;
}

/**
 * Registers every tool of the release as an operation and answers what an agent's runs need:
 * the tools to offer the model and the way to call them, those that exist as data among them.
 * A call takes the call path, like every other caller of an operation. The operations of the
 * data tools come from an `OperationSource` of the same registry, never from here.
 */
export function createInstanceAgentTools(
  operationCalls: OperationCalls,
  tools: ToolRegistry,
  options: {
    clientInstanceId: ClientInstanceId;
    logger: Logger;
    runtime: Pick<ClientInstanceConfig["runtime"], "dataToolDescribeTimeoutMs">;
    dataTools?: DataToolSource;
  }
): InstanceAgentTools {
  const { dataTools, runtime, ...toolOptions } = options;
  const describeTimeoutMs = runtime.dataToolDescribeTimeoutMs;
  registerToolOperations(operationCalls.registry, tools.list(), toolOptions);
  return {
    toolRegistry: tools,
    ...(dataTools ? { dataTools } : {}),
    dataToolDescribeTimeoutMs: describeTimeoutMs,
    runTool: createToolOperationRunner(
      operationCalls.deps,
      tools,
      dataTools && { source: dataTools, describeTimeoutMs }
    )
  };
}
