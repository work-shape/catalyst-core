import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asClientInstanceId,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { type ModelCompletionStreamEvent } from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { defineTool } from "@work-shape/catalyst-tool-sdk";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createConversationWithMessages,
  createUnusedToolRunner,
  noReportedUsage,
  readAssistantReasoningSummaries
} from "./helpers/agent-runtime";

import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
  it("streams model text around tool calls and keeps final messages separate", async () => {
    const clientInstanceId = asClientInstanceId("tool-stream-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-tool-stream",
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
    const store = (await createTestInstance()).stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    let modelStep = 0;
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete() {
        throw new Error("Expected the streaming provider path to be used");
      },
      async *stream(): AsyncIterable<ModelCompletionStreamEvent> {
        modelStep += 1;
        if (modelStep === 1) {
          yield {
            type: "reasoning_delta",
            id: "rs_1:summary:0",
            delta: "I need to inspect the referenced page."
          };
          yield {
            type: "tool_call_preparing",
            toolCallId: "call_1",
            toolName: "test.inspect"
          };
          yield {
            type: "completed",
            completion: {
              text: "I will inspect page 2.",
              toolCalls: [
                {
                  toolCallId: "call_1",
                  toolName: "test.inspect",
                  input: { page: 2 }
                }
              ],
              usage: noReportedUsage()
            }
          };
          return;
        }

        yield {
          type: "text_delta",
          delta: "The page contains the invoice total."
        };
        yield {
          type: "completed",
          completion: {
            text: "The page contains the invoice total.",
            toolCalls: [],
            usage: noReportedUsage()
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "tool_stream_agent",
              displayName: "Tool Stream Agent",
              instructions: "Use tools when useful.",
              modelProviderId: "test-provider",
              toolNames: ["test.inspect"],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProvider,
        toolRegistry: new ToolRegistry({
          tools: [
            defineTool({
              name: "test.inspect",
              effect: "reading",
              description: "Inspect a page.",
              inputSchema: z.object({ page: z.number() }),
              async execute() {
                throw new Error("Tool registry execution should not be used by this test");
              }
            })
          ]
        }),
        async runTool(request) {
          return {
            status: "success",
            output: {
              inspectedPage: (request.input as { page?: number }).page
            }
          };
        },
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );

    const run = await runtime.start(
      {
        agentName: "tool_stream_agent",
        conversationId,
        message: {
          text: "Check page 2"
        }
      },
      context
    );

    const textDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    const preparingTools: string[] = [];
    const startedToolInputs: unknown[] = [];
    const completedMessages: string[] = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "reasoning_delta") {
        reasoningDeltas.push(event.delta);
      }
      if (event.type === "message_delta") {
        textDeltas.push(event.delta);
      }
      if (event.type === "tool_call_preparing") {
        preparingTools.push(event.toolName);
      }
      if (event.type === "tool_call_started") {
        startedToolInputs.push(event.input);
      }
      if (event.type === "message_completed") {
        completedMessages.push(event.message.text);
      }
    }

    expect(textDeltas).toEqual(["I will inspect page 2.", "The page contains the invoice total."]);
    expect(reasoningDeltas).toEqual(["I need to inspect the referenced page."]);
    expect(preparingTools).toEqual(["test.inspect"]);
    expect(startedToolInputs).toEqual([{ page: 2 }]);
    expect(completedMessages).toEqual(["The page contains the invoice total."]);

    const assistantMessages = (
      await store.conversations.listMessages({
        clientInstanceId,
        conversationId
      })
    ).filter((message) => message.role === "assistant");
    expect(assistantMessages.map((message) => message.text)).toEqual([
      "I will inspect page 2.",
      "The page contains the invoice total."
    ]);
    expect(readAssistantReasoningSummaries(assistantMessages[0]?.metadata)).toEqual([
      {
        id: "rs_1:summary:0",
        text: "I need to inspect the referenced page."
      }
    ]);
  });

  it("projects provider-native tool stream events as runtime tool observations", async () => {
    const clientInstanceId = asClientInstanceId("provider-tool-stream-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-provider-tool-stream",
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
    const store = (await createTestInstance()).stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete() {
        throw new Error("Expected the streaming provider path to be used");
      },
      async *stream(): AsyncIterable<ModelCompletionStreamEvent> {
        yield {
          type: "provider_tool_started",
          toolCallId: "ws_1",
          toolName: "web_search",
          input: { query: "dishwasher reviews" }
        };
        yield {
          type: "text_delta",
          delta: "I found current dishwasher recommendations."
        };
        yield {
          type: "provider_tool_completed",
          toolCallId: "ws_1",
          toolName: "web_search",
          output: {
            status: "completed",
            sourceCount: 2
          }
        };
        yield {
          type: "completed",
          completion: {
            text: "I found current dishwasher recommendations.",
            toolCalls: [],
            usage: noReportedUsage()
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "provider_tool_stream_agent",
              displayName: "Provider Tool Stream Agent",
              instructions: "Use provider tools when useful.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProvider,
        toolRegistry: new ToolRegistry({ tools: [] }),
        runTool: createUnusedToolRunner(),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );

    const run = await runtime.start(
      {
        agentName: "provider_tool_stream_agent",
        conversationId,
        message: {
          text: "Search the web"
        }
      },
      context
    );

    const events = [];
    for await (const event of runtime.observe(run.runId, context)) {
      events.push(event);
    }

    expect(events.map((event) => event.type)).toEqual([
      "tool_call_started",
      "message_delta",
      "tool_call_completed",
      "message_completed",
      "run_completed"
    ]);
    expect(events[0]).toMatchObject({
      type: "tool_call_started",
      toolCallId: "ws_1",
      toolName: "web_search",
      input: {
        query: "dishwasher reviews"
      }
    });
    expect(events[2]).toMatchObject({
      type: "tool_call_completed",
      toolCallId: "ws_1",
      toolName: "web_search",
      result: {
        status: "success",
        output: {
          status: "completed",
          sourceCount: 2
        }
      },
      modelOutput: ""
    });
  });
});
