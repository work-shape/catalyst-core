import { workflowAgentActor, workflowAgentStep } from "./workflow-agent-actor";
import {
  GuardrailRunner,
  ApprovalRequestWorkflow,
  createOperationCalls,
  registerSubagentOperation,
  type ChatServerOptions,
  type OperationCalls
} from "@work-shape/catalyst-server";
import type { ClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  AGENTS_RUN_OPERATION,
  RUN_AGENT_TOOL_NAME,
  createAuthorizer,
  knowledgeOperationNamesOf,
  type ApprovalRequestHandlerRegistry,
  type AuditRecorder,
  type Authorizer,
  type ClientInstanceId,
  type ConfigAssetSource,
  type ConversationOfferSource,
  type DataToolSource,
  type Logger,
  type ModuleSnapshot,
  type PlatformStores,
  type PublishNarrativeStoredData,
  type ToolDecisionRunner,
  type ToolOperationRunner
} from "@work-shape/catalyst-core";
import type { ModelGateway } from "@work-shape/catalyst-model-provider";
import { conversationToolNames } from "./conversation-offer";
import {
  createBoundedDataToolSource,
  createDecidedToolCallRunner,
  createToolOperationRunner,
  registerToolOperations,
  type ToolRegistry
} from "@work-shape/catalyst-tool-execution";

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
  /** The asset kinds of the instance: a held save of an asset is shown as that asset. */
  configAssets: Pick<ChatServerOptions["configAssets"], "kinds">;
  /** The approval kinds the assembly brings. The kind of a held call is added to them. */
  approvalRequestHandlers: ApprovalRequestHandlerRegistry;
  operations?: ChatServerOptions["operations"];
  /** What a conversation about an asset is offered beyond its agent's definition. */
  conversationOffer?: ConversationOfferSource;
  /** Who sees which stored data, for the publish question's sentence. */
  publishStoredData?: PublishNarrativeStoredData;
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
  const guardrails = new GuardrailRunner({
    clientInstanceId,
    config,
    modelGateway: input.modelGateway,
    hits: store.guardrails,
    assets: store.configAssets,
    shipped: store.guardrails
  });
  const operationCalls = createOperationCalls({
    clientInstanceId,
    stores: store,
    auditRecorder,
    authorizer,
    config,
    logger: input.logger,
    modules: input.modules,
    configAssets: input.configAssets,
    operations: input.operations,
    guardrails,
    ...(input.publishStoredData ? { publishStoredData: input.publishStoredData } : {}),
    approvalRequests: {
      store: store.approvals,
      handlers: input.approvalRequestHandlers,
      guardrails
    },
    async workflowAgentActor(runId) {
      const run = await store.agentRuns.getAgentRun({ clientInstanceId, runId });
      return run ? workflowAgentActor(store, run) : undefined;
    },
    async agentToolNames(agentName, conversationId) {
      // A Workflow agent step's thread holds its one run, whatever its status: its tools are
      // its Workflow's, never those of an agent asset of the same name (CR-2).
      const run =
        conversationId &&
        (await store.agentRuns.getLatestConversationAgentRun({ clientInstanceId, conversationId }));
      if (run && run.workflowStepRunId) return (await workflowAgentStep(store, run))?.tools ?? [];
      const assets = await assetSource.getSnapshot();
      const agent = assets.agents.find((candidate) => candidate.name === agentName);
      const listed = agent?.toolNames ?? [];
      // The tools the server binds to the subject of a conversation are no part of an agent's
      // definition: the conversation of the call decides whether the agent has them.
      const offer = conversationId
        ? await input.conversationOffer?.offerOf({
            clientInstanceId,
            conversationId,
            agentToolNames: listed
          })
        : undefined;
      // The query of each Knowledge Base the agent lists, which its one knowledge tool calls,
      // and the start of a subagent, which `run_agent` calls.
      return [
        ...(await conversationToolNames(listed, offer)),
        ...(agent ? knowledgeOperationNamesOf(agent) : []),
        ...(listed.includes(RUN_AGENT_TOOL_NAME) ? [AGENTS_RUN_OPERATION] : [])
      ];
    }
  });
  // The start of a subagent, which an agent's `run_agent` call is (CR-1).
  registerSubagentOperation(operationCalls.registry, {
    clientInstanceId,
    stores: store,
    assetSource,
    agentAvailable: async (input) => (await operationCalls.deps.agentAvailable?.(input)) ?? false
  });
  const approvalRequestCreator = new ApprovalRequestWorkflow({
    clientInstanceId,
    store: store.approvals,
    handlers: operationCalls.approvalRequestHandlers,
    guardrails,
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
  /** Carries out a call a run waited on once its person decided, in the run's worker. */
  runDecidedTool: ToolDecisionRunner;
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
  const { runtime, ...toolOptions } = options;
  // One bounded source for the runtime and the runner: they share the reads that are
  // outstanding and the ceiling on them.
  const dataTools = options.dataTools && createBoundedDataToolSource(options.dataTools);
  const describeTimeoutMs = runtime.dataToolDescribeTimeoutMs;
  registerToolOperations(operationCalls.registry, tools.list(), {
    clientInstanceId: toolOptions.clientInstanceId,
    logger: toolOptions.logger
  });
  return {
    toolRegistry: tools,
    ...(dataTools ? { dataTools } : {}),
    dataToolDescribeTimeoutMs: describeTimeoutMs,
    runTool: createToolOperationRunner(
      operationCalls.deps,
      tools,
      dataTools && { source: dataTools, describeTimeoutMs }
    ),
    runDecidedTool: createDecidedToolCallRunner(operationCalls.deps)
  };
}
