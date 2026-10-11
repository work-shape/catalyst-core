import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LocalAgentRuntime,
  describeAgentDataTools,
  materializeModelTools,
  type DataToolDescriptor,
  type DataToolSource
} from "@vivd-catalyst/agent-runtime";
import { createAuditingEventEmitter } from "@vivd-catalyst/chat-server";
import { findAgentReferenceIssues } from "@vivd-catalyst/config-schema";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  createAuthorizer,
  createOperationRegistry,
  type AgentConfig,
  type AuditRecorder,
  type Logger,
  type ModelProviderConfig,
  type OperationDefinition,
  type OperationSource,
  type RuntimeCallContext,
  type ToolExecutionRequest
} from "@vivd-catalyst/core";
import {
  DETERMINISTIC_CAPABILITIES,
  DeterministicModelProvider
} from "@vivd-catalyst/model-provider";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import {
  ToolRegistry,
  createToolOperationRunner,
  registerToolOperations,
  type RunOperationDeps
} from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { setupAccessInstance } from "./support/access-instance";
import { createMemoryOperationRunStore } from "./support/memory-operation-runs";
import { silentTestLogger, withTestModelGateway } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";
import { recordedAuditEvent } from "./support/tool-runner";

// The fakes stand for what the Connections of an instance bring (C1 slice B): an
// `OperationSource` with the operations and a `DataToolSource` that describes them as tools.
// `DataToolSource` and `DataToolDescriptor` are imported from the agent runtime until
// `core/src/data-tools.ts` exists (C1 slice K); then they come from core.

const ECHO = "connection.fake.echo";
const WRITE = "connection.fake.write";
const clientInstanceId = asClientInstanceId("data-tools-client");

const context: RuntimeCallContext = {
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
const echoInputJsonSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false
};

/** A Connection with a reading and a changing operation, as its two sources. */
function createFakeConnection() {
  const executed: string[] = [];
  const describeCalls: string[][] = [];
  const gone = new Set<string>();
  const operation = (name: string, effect: "reading" | "changing"): OperationDefinition => ({
    name,
    effect,
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
    resolve: (name) => Promise.resolve(existing().find((entry) => entry.name === name)),
    list: () => Promise.resolve(existing())
  };
  const toolSource: DataToolSource = {
    describe(toolNames) {
      describeCalls.push([...toolNames]);
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
  return { executed, describeCalls, gone, operationSource, toolSource };
}

const releaseTool = defineTool({
  name: "test.inspect",
  description: "Inspects a page.",
  effect: "reading",
  inputSchema: z.object({ page: z.number() }),
  execute: async () => toolSuccess({ inspected: true })
});

/** The call path of an instance with the release tool and, where given, the fake Connection. */
function createCallPath(input: {
  agentToolNames: Record<string, readonly string[]>;
  connection?: ReturnType<typeof createFakeConnection>;
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
    logger: silentTestLogger
  };
  return {
    runs,
    toolRegistry,
    runTool: createToolOperationRunner(deps, toolRegistry, input.connection?.toolSource)
  };
}

function toolRequest(toolName: string, agentName: string): ToolExecutionRequest {
  return {
    toolName,
    toolCallId: asToolCallId(`toolcall_${agentName}`),
    agentRunId: asAgentRunId("run_data_tools"),
    conversationId: asConversationId("conv_data_tools"),
    agentName,
    input: { text: "hello" }
  };
}

function agent(name: string, toolNames: string[]): AgentConfig {
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

const providerConfig: ModelProviderConfig = {
  id: "test-provider",
  type: "deterministic",
  model: "test-model"
};

/** A local chat: the agent runtime with the deterministic provider on a stored conversation. */
async function startChat(input: {
  agent: AgentConfig;
  connection: ReturnType<typeof createFakeConnection>;
  logger?: Logger;
}) {
  const store = (await createTestInstance()).stores;
  const conversation = await store.createConversationForTesting({
    clientInstanceId,
    createdByUserId: "user-1",
    createdByExternalUserId: "user-1",
    title: "Data tools",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
  const path = createCallPath({
    agentToolNames: { [input.agent.name]: input.agent.toolNames },
    connection: input.connection
  });
  const failures: unknown[] = [];
  const runtime = new LocalAgentRuntime(
    withTestModelGateway({
      ...(input.logger ? { logger: input.logger } : {}),
      assetSource: createStaticConfigAssetSource({ agents: [input.agent] }),
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store.conversations,
      // The provider of local development: `/tool <name> <json>` calls a tool it was offered
      // and is refused for one it was not.
      modelProvider: new DeterministicModelProvider("test-provider"),
      modelCapabilities: DETERMINISTIC_CAPABILITIES,
      toolRegistry: path.toolRegistry,
      dataTools: input.connection.toolSource,
      runTool: path.runTool,
      runFailureReporter: (report) => void failures.push(report.error),
      usageGovernance: new ModelUsageGovernance({ store: store.usage, budget: {}, safeguards: {} })
    })
  );
  const say = async (text: string) => {
    const run = await runtime.start(
      { agentName: input.agent.name, conversationId: conversation.id, message: { text } },
      context
    );
    const completed: string[] = [];
    const failed: string[] = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "message_completed") completed.push(event.message.text);
      if (event.type === "run_failed") failed.push(event.error.message);
    }
    failed.push(...failures.splice(0).map(String));
    return { completed, failed };
  };
  return { say, runs: path.runs.runs };
}

describe("an agent carries data tools", () => {
  it("calls a Connection operation in a chat as one Operation Run of the user", async () => {
    const connection = createFakeConnection();
    const chat = await startChat({
      agent: agent("data_agent", ["test.inspect", ECHO]),
      connection
    });

    const answer = await chat.say(`/tool ${ECHO} {"text":"hello"}`);

    expect(answer.failed).toEqual([]);
    expect(answer.completed.join("\n")).toContain('"echo": "hello"');
    expect(connection.executed).toEqual([ECHO]);
    expect(chat.runs).toHaveLength(1);
    expect(chat.runs[0]).toMatchObject({
      operation: ECHO,
      effect: "reading",
      status: "done",
      actor: { kind: "user", id: "user-1" },
      origin: { kind: "agent", agentName: "data_agent", toolName: ECHO }
    });
    // The run made two model calls, the one that called the tool and the one that answered.
    // The source was read once for the run, with every data tool of the agent in that one
    // read, and once more by the one call.
    expect(connection.describeCalls).toEqual([[ECHO], [ECHO]]);
  });

  it("refuses an agent that does not list the tool, naming the tool", async () => {
    const connection = createFakeConnection();
    const path = createCallPath({ agentToolNames: { other_agent: ["test.inspect"] }, connection });

    const result = await path.runTool(toolRequest(ECHO, "other_agent"), context);

    expect(result).toMatchObject({
      status: "failed",
      error: {
        code: "not_allowed",
        message: `Agent 'other_agent' is not allowed to use '${ECHO}'`
      }
    });
    expect(connection.executed).toEqual([]);
    expect(path.runs.runs).toHaveLength(1);
    expect(path.runs.runs[0]).toMatchObject({
      operation: ECHO,
      status: "denied",
      denial: { kind: "forbidden", action: `agent_tool:${ECHO}`, reason: "no_grant" }
    });
  });

  it("refuses an agent's changing call as policy and does not run it", async () => {
    const connection = createFakeConnection();
    const path = createCallPath({ agentToolNames: { data_agent: [WRITE] }, connection });

    const result = await path.runTool(toolRequest(WRITE, "data_agent"), context);

    expect(result).toMatchObject({ status: "failed", error: { code: "not_allowed" } });
    expect(connection.executed).toEqual([]);
    expect(path.runs.runs).toHaveLength(1);
    expect(path.runs.runs[0]).toMatchObject({ status: "denied", denial: { kind: "policy" } });
  });

  it("goes on without a listed tool that is gone, and a call of it is not allowed", async () => {
    const connection = createFakeConnection();
    connection.gone.add(ECHO);
    const logged: unknown[] = [];
    const logger: Logger = {
      ...silentTestLogger,
      info: (record: unknown) => void logged.push(record),
      child: () => logger
    };
    const chat = await startChat({
      agent: agent("data_agent", ["test.inspect", ECHO]),
      connection,
      logger
    });

    const answer = await chat.say("Hello");

    expect(answer.failed).toEqual([]);
    expect(answer.completed).toHaveLength(1);
    // The model was not offered the tool: the provider refuses to call it.
    const refused = await chat.say(`/tool ${ECHO} {"text":"hello"}`);
    expect(refused.failed.join("\n")).toContain(`Tool '${ECHO}' is not available to this agent`);
    expect(connection.executed).toEqual([]);
    expect(chat.runs).toEqual([]);
    expect(logged).toContainEqual(
      expect.objectContaining({
        type: "agent_run.data_tools_missing",
        agentName: "data_agent",
        toolNames: [ECHO]
      })
    );

    const path = createCallPath({ agentToolNames: { data_agent: [ECHO] }, connection });
    const result = await path.runTool(toolRequest(ECHO, "data_agent"), context);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: `Tool '${ECHO}' is not registered` }
    });
    expect(path.runs.runs).toEqual([]);
  });

  it("offers an agent the same tools as before on an instance with no source", async () => {
    const toolRegistry = new ToolRegistry({ tools: [releaseTool] });
    const capabilities = { nativeTools: [] };
    const releaseOnly = [
      {
        kind: "function",
        name: "test.inspect",
        description: "Inspects a page.",
        inputJsonSchema: releaseTool.inputJsonSchema
      }
    ];
    // Names and schemas for an agent of release tools: what the registry describes, unchanged.
    expect(
      materializeModelTools({ agent: agent("plain", ["test.inspect"]), capabilities, toolRegistry })
    ).toEqual(releaseOnly);

    // An agent that lists a data tool gets the release tools and nothing else.
    const listing = agent("listing", ["test.inspect", ECHO]);
    const dataTools = await describeAgentDataTools(listing, undefined);
    expect(dataTools).toEqual({ described: [], missing: [ECHO] });
    expect(
      materializeModelTools({
        agent: listing,
        capabilities,
        toolRegistry,
        dataTools: dataTools.described
      })
    ).toEqual(releaseOnly);

    // And a call of it finds no tool, as a call of any unknown name does.
    const path = createCallPath({ agentToolNames: { listing: listing.toolNames } });
    expect(await path.runTool(toolRequest(ECHO, "listing"), context)).toMatchObject({
      status: "failed",
      error: { code: "not_allowed", message: `Tool '${ECHO}' is not registered` }
    });
    expect(path.runs.runs).toEqual([]);
  });

  it("reads an agent without data tools at no cost and never lets a source add a tool", async () => {
    const connection = createFakeConnection();
    expect(
      await describeAgentDataTools(agent("plain", ["test.inspect"]), connection.toolSource)
    ).toEqual({ described: [], missing: [] });
    expect(connection.describeCalls).toEqual([]);

    // A source that answers more than it was asked, and a release name among it.
    const greedy: DataToolSource = {
      describe: () =>
        Promise.resolve(
          [ECHO, WRITE, "test.inspect"].map((name) => ({
            name,
            description: "From the source.",
            effect: "reading" as const
          }))
        )
    };
    const listing = agent("listing", ["test.inspect", ECHO]);
    const described = await describeAgentDataTools(listing, greedy);
    expect(described.described.map((tool) => tool.name)).toEqual([ECHO]);
    // With the real source the model reads the source's description and schema.
    const read = await describeAgentDataTools(listing, connection.toolSource);
    expect(
      materializeModelTools({
        agent: listing,
        capabilities: { nativeTools: [] },
        toolRegistry: new ToolRegistry({ tools: [releaseTool] }),
        dataTools: read.described
      })
    ).toEqual([
      expect.objectContaining({ kind: "function", name: "test.inspect" }),
      {
        kind: "function",
        name: ECHO,
        description: `Fake operation ${ECHO}`,
        inputJsonSchema: echoInputJsonSchema
      }
    ]);
    const tools = materializeModelTools({
      agent: listing,
      capabilities: { nativeTools: [] },
      toolRegistry: new ToolRegistry({ tools: [releaseTool] }),
      // Handed in whole, as if the filter of the read were missing.
      dataTools: await greedy.describe([], {})
    });
    expect(tools.map((tool) => [tool.name, "description" in tool && tool.description])).toEqual([
      ["test.inspect", "Inspects a page."],
      [ECHO, "From the source."]
    ]);
  });

  it("refuses a release tool that takes a name of a data tool", () => {
    const impostor = defineTool({
      name: "connection.fake.echo",
      description: "Not a Connection operation.",
      effect: "reading",
      inputSchema: z.object({}),
      execute: async () => toolSuccess({})
    });
    expect(() => new ToolRegistry({ tools: [impostor] })).toThrow(/starts with 'connection\.'/u);
  });
});

describe("validation of an agent that lists data tools", () => {
  const refs = {
    modelProviderIds: ["test-provider"],
    modelBindingIds: [],
    fastModeModelBindingIds: [],
    enabledToolNames: ["test.inspect"]
  };
  const issuesOf = (toolNames: string[]) =>
    findAgentReferenceIssues({ agents: [agent("helper", toolNames)], skillNames: [], refs });

  it("accepts the name of a Connection operation and nothing else that looks like one", () => {
    expect(issuesOf(["test.inspect", ECHO, "connection.sample-business.revenue_by_month"])).toEqual(
      []
    );
    for (const name of [
      "connection.fake",
      "connection.fake.",
      "connection..echo",
      "connection.fake.echo.more",
      "connection.Fake.echo",
      "connection.fake.9echo",
      "connection.fake.e cho",
      `connection.${"a".repeat(65)}.echo`,
      `connection.fake.${"a".repeat(65)}`,
      "connections.fake.echo",
      "unknown.tool"
    ]) {
      expect(issuesOf([name]), name).toEqual([
        `Agent 'helper' references unavailable tool '${name}'`
      ]);
    }
  });

  it("saves such an agent, and a Namespace allowlist still refuses a name it does not hold", async () => {
    const t = await setupAccessInstance();

    expect((await t.putAgent(t.admin.id, "helper", { toolNames: [ECHO] })).statusCode).toBe(200);
    await t.expectRefused(
      t.admin.id,
      "assets.put",
      {
        params: { kind: "agent", name: "broken" },
        payload: {
          config: {
            ...agent("broken", ["connection.fake"]),
            modelProviderId: "local"
          }
        }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );

    await t.createNamespace("kai-", { allowedToolNames: ["known.tool"] });
    expect(
      (await t.putAgent(t.admin.id, "kai-helper", { toolNames: ["known.tool"] })).statusCode
    ).toBe(200);
    await t.expectRefused(
      t.admin.id,
      "assets.put",
      {
        params: { kind: "agent", name: "kai-other" },
        payload: {
          config: { ...agent("kai-other", [ECHO]), modelProviderId: "local" }
        }
      },
      {
        status: 403,
        code: "FORBIDDEN",
        details: { reason: "tool_not_allowed", toolName: ECHO, namespace: "kai-" }
      }
    );
  });
});
