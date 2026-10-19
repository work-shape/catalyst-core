import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  LocalAgentRuntime,
  describeAgentDataTools,
  materializeModelTools
} from "@work-shape/catalyst-agent-runtime";
import { findAgentReferenceIssues } from "@work-shape/catalyst-config-schema";
import type {
  AgentConfig,
  DataToolSource,
  Logger,
  ModelProviderConfig
} from "@work-shape/catalyst-core";
import {
  DETERMINISTIC_CAPABILITIES,
  DeterministicModelProvider,
  modelContentText
} from "@work-shape/catalyst-model-provider";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { setupConnectionInstance } from "./support/connections";
import {
  ECHO,
  WRITE,
  agent,
  clientInstanceId,
  context,
  createCallPath,
  createFakeConnection,
  echoInputJsonSchema,
  releaseTool,
  toolRequest
} from "./support/data-tools-fixture";
import {
  silentTestLogger,
  withTestModelGateway,
  type FakeModelProvider
} from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

function noReportedUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported" as const,
    webSearchCallCount: 0
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
  describeTimeoutMs?: number;
  /** Left out, the provider of local development. */
  modelProvider?: FakeModelProvider;
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
    connection: input.connection,
    describeTimeoutMs: input.describeTimeoutMs
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
      modelProvider: input.modelProvider ?? new DeterministicModelProvider("test-provider"),
      modelCapabilities: DETERMINISTIC_CAPABILITIES,
      toolRegistry: path.toolRegistry,
      dataTools: input.connection.toolSource,
      ...(input.describeTimeoutMs ? { dataToolDescribeTimeoutMs: input.describeTimeoutMs } : {}),
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

  it("refuses an agent that does not list the tool, naming the tool, without a read of the source", async () => {
    const connection = createFakeConnection();
    const path = createCallPath({ agentToolNames: { other_agent: ["test.inspect"] }, connection });

    const result = await path.runTool(toolRequest(ECHO, "other_agent"), context);

    expect(result).toEqual({
      status: "failed",
      error: {
        code: "not_allowed",
        message:
          "This agent is not set up for this action here. Nothing ran. Ask an instance administrator; no contact person is currently listed.",
        details: { action: `agent_tool:${ECHO}` }
      }
    });
    expect(connection.executed).toEqual([]);
    // The agent's list is asked first: an agent that lists no data tool reaches no source,
    // so a source that is down cannot fail its run.
    expect(connection.describeCalls).toEqual([]);
    expect(path.runs.runs).toEqual([]);
  });

  it("fails one call, not the run, when the source fails or does not answer at call time", async () => {
    for (const answers of ["throws", "never"] as const) {
      const connection = createFakeConnection();
      connection.source.answers = answers;
      const path = createCallPath({
        agentToolNames: { data_agent: [ECHO] },
        connection,
        describeTimeoutMs: 50
      });

      const result = await path.runTool(toolRequest(ECHO, "data_agent"), context);

      expect(result, answers).toMatchObject({
        status: "failed",
        error: {
          code: "handler_failed",
          message: `Tool '${ECHO}' could not be reached right now. Try again later. Reference: corr-data-tools`
        }
      });
      expect(connection.executed).toEqual([]);
      expect(path.runs.runs).toEqual([]);
    }
  });

  it("goes on without data tools when the source fails or does not answer at run start", async () => {
    for (const answers of ["throws", "never"] as const) {
      const connection = createFakeConnection();
      connection.source.answers = answers;
      const logged: unknown[] = [];
      const logger: Logger = {
        ...silentTestLogger,
        warn: (record: unknown) => void logged.push(record),
        child: () => logger
      };
      const chat = await startChat({
        agent: agent("data_agent", ["test.inspect", ECHO]),
        connection,
        logger,
        describeTimeoutMs: 50
      });

      const answer = await chat.say("Hello");

      expect(answer.failed, answers).toEqual([]);
      expect(answer.completed).toHaveLength(1);
      expect(logged).toContainEqual(
        expect.objectContaining({
          type: "agent_run.data_tools_unavailable",
          reason: answers === "throws" ? "failed" : "timed_out",
          toolNames: [ECHO]
        })
      );
    }
  });

  it("refuses a data tool the run was not offered at its start, though it exists by now", async () => {
    const connection = createFakeConnection();
    connection.gone.add(ECHO);
    const toolResults: string[] = [];
    let requests = 0;
    const chat = await startChat({
      agent: agent("data_agent", ["test.inspect", ECHO]),
      connection,
      // A model that calls the tool it was not offered, after the tool became ready.
      modelProvider: {
        id: "test-provider",
        complete: () => Promise.reject(new Error("The runtime streams")),
        async *stream(request) {
          requests += 1;
          if (requests === 1) {
            connection.gone.delete(ECHO);
            yield {
              type: "completed",
              completion: {
                text: "",
                toolCalls: [{ toolCallId: "toolcall_late", toolName: ECHO, input: { text: "x" } }],
                usage: noReportedUsage()
              }
            };
            return;
          }
          toolResults.push(
            ...request.messages
              .filter((message) => message.role === "tool")
              .map((message) => modelContentText(message.content))
          );
          yield {
            type: "completed",
            completion: { text: "Done.", toolCalls: [], usage: noReportedUsage() }
          };
        }
      }
    });

    const answer = await chat.say("Use the tool");

    // The call is a failure the agent reads, and the run ends as any other.
    expect(answer.failed).toEqual([]);
    expect(answer.completed).toEqual(["Done."]);
    expect(toolResults.join("\n")).toContain(`Tool '${ECHO}' is not available in this run`);
    expect(connection.executed).toEqual([]);
    expect(chat.runs).toEqual([]);
    // One read, at the start. The refused call asked nobody.
    expect(connection.describeCalls).toEqual([[ECHO]]);

    // The next run is offered the tool and calls it.
    requests = 0;
    const next = await chat.say("Use the tool");
    expect(next.failed).toEqual([]);
    expect(connection.executed).toEqual([ECHO]);
    expect(chat.runs).toHaveLength(1);
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
        `Agent 'helper' references unavailable tool '${name}' in toolNames[0]`
      ]);
    }
  });

  it("saves such an agent, and a Namespace allowlist still refuses a name it does not hold", async () => {
    const t = await setupConnectionInstance({ dataTools: createFakeConnection().toolSource });
    await t.seed("fake", {
      origin: "runtime",
      operations: [{ name: "echo", effect: "reading", exposure: ["agent"] }]
    });

    const saved = await t.putAgent(t.admin.id, "helper", { toolNames: [ECHO] });
    expect(saved.statusCode, saved.body).toBe(200);
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
