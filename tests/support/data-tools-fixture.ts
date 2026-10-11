import { z } from "zod";
import { createAuditingEventEmitter } from "@vivd-catalyst/chat-server";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  createAuthorizer,
  createOperationRegistry,
  type AgentConfig,
  type AuditRecorder,
  type DataToolDescriptor,
  type DataToolSource,
  type OperationDefinition,
  type OperationSource,
  type RuntimeCallContext,
  type ToolExecutionRequest
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import {
  ToolRegistry,
  createToolOperationRunner,
  registerToolOperations,
  type OperationApprovalRequests,
  type RunOperationDeps
} from "@vivd-catalyst/tool-execution";
import { createMemoryOperationRunStore } from "./memory-operation-runs";
import { silentTestLogger } from "./model-gateway";
import { recordedAuditEvent } from "./tool-runner";

// The fakes stand for what the Connections of an instance bring (C1 slice B): an
// `OperationSource` with the operations and a `DataToolSource` that describes them as tools.

export const ECHO = "connection.fake.echo";
export const WRITE = "connection.fake.write";
export const clientInstanceId = asClientInstanceId("data-tools-client");

export const context: RuntimeCallContext = {
  clientInstanceId,
  correlationId: "corr-data-tools",
  user: {
    id: "user-1",
    externalUserId: "user-1",
    displayLabel: "User",
    roles: ["user"],
    permissionRefs: [],
    clientInstanceId,
    authSource: "test"
  }
};

const echoInputSchema = z.object({ text: z.string() });
export const echoInputJsonSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false
};

/** A Connection with a reading and a changing operation, as its two sources. */
export function createFakeConnection(options: { writePolicy?: "approval" } = {}) {
  const executed: string[] = [];
  const describeCalls: string[][] = [];
  const resolveCalls: string[] = [];
  const gone = new Set<string>();
  /** How the tool source answers: as asked, with an error, or never. */
  const source: { answers: "yes" | "throws" | "never" } = { answers: "yes" };
  const operation = (name: string, effect: "reading" | "changing"): OperationDefinition => ({
    name,
    effect,
    ...(effect === "changing" && options.writePolicy ? { defaultPolicy: options.writePolicy } : {}),
    ...(effect === "reading" ? { recordsEveryCall: true as const } : {}),
    action: null,
    authorize: () => ({ allowed: true }),
    scope: null,
    auth: "principal",
    inputSchema: echoInputSchema,
    outputSchema: z.unknown(),
    resource: () => undefined,
    timeoutMs: 30_000,
    execute(input) {
      executed.push(name);
      return Promise.resolve({ echo: echoInputSchema.parse(input).text });
    }
  });
  const operations = new Map([
    [ECHO, operation(ECHO, "reading")],
    [WRITE, operation(WRITE, "changing")]
  ]);
  const existing = () => [...operations.values()].filter((entry) => !gone.has(entry.name));
  const operationSource: OperationSource = {
    resolve(name) {
      resolveCalls.push(name);
      return Promise.resolve(existing().find((entry) => entry.name === name));
    },
    list: () => Promise.resolve(existing())
  };
  const toolSource: DataToolSource = {
    describe(toolNames) {
      describeCalls.push([...toolNames]);
      if (source.answers === "throws") return Promise.reject(new Error("store unreachable"));
      if (source.answers === "never") return new Promise(() => {});
      return Promise.resolve(
        existing()
          .filter((entry) => toolNames.includes(entry.name))
          .map((entry): DataToolDescriptor => ({
            name: entry.name,
            description: `Fake operation ${entry.name}`,
            inputJsonSchema: echoInputJsonSchema,
            effect: entry.effect
          }))
      );
    }
  };
  return { executed, describeCalls, resolveCalls, gone, source, operationSource, toolSource };
}

export const releaseTool = defineTool({
  name: "test.inspect",
  description: "Inspects a page.",
  effect: "reading",
  inputSchema: z.object({ page: z.number() }),
  execute: async () => toolSuccess({ inspected: true })
});

/** The call path of an instance with the release tool and, where given, the fake Connection. */
export function createCallPath(input: {
  agentToolNames: Record<string, readonly string[]>;
  connection?: ReturnType<typeof createFakeConnection>;
  describeTimeoutMs?: number;
  approvals?: OperationApprovalRequests;
}) {
  const runs = createMemoryOperationRunStore();
  const toolRegistry = new ToolRegistry({ tools: [releaseTool] });
  const registry = createOperationRegistry();
  registerToolOperations(registry, toolRegistry.list(), { clientInstanceId });
  if (input.connection) registry.addSource(input.connection.operationSource);
  const audit: AuditRecorder = {
    record: (event) => Promise.resolve(recordedAuditEvent(clientInstanceId, event))
  };
  const deps: RunOperationDeps = {
    clientInstanceId,
    registry,
    runs,
    authorizer: createAuthorizer(),
    events: createAuditingEventEmitter(audit),
    audit,
    policy: {
      instanceDefaults: { reading: "allow", changing: "confirm" },
      centralSettings: () => []
    },
    agentToolNames: (agentName) => input.agentToolNames[agentName] ?? [],
    ...(input.approvals ? { approvals: input.approvals } : {}),
    logger: silentTestLogger
  };
  return {
    deps,
    runs,
    toolRegistry,
    runTool: createToolOperationRunner(
      deps,
      toolRegistry,
      input.connection && {
        source: input.connection.toolSource,
        describeTimeoutMs: input.describeTimeoutMs
      }
    )
  };
}

export function toolRequest(toolName: string, agentName: string): ToolExecutionRequest {
  return {
    toolName,
    toolCallId: asToolCallId(`toolcall_${agentName}`),
    agentRunId: asAgentRunId("run_data_tools"),
    conversationId: asConversationId("conv_data_tools"),
    agentName,
    input: { text: "hello" }
  };
}

export function agent(name: string, toolNames: string[]): AgentConfig {
  return {
    name,
    displayName: name,
    instructions: "Use tools when useful.",
    modelProviderId: "test-provider",
    toolNames,
    skillNames: [],
    initialPrompts: []
  };
}
