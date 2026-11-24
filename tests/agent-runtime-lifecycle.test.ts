import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asMessageId,
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
  it("reclaims stale pending run-start idempotency commands", async () => {
    const store = (await createTestInstance()).stores;
    const clientInstanceId = asClientInstanceId("run-start-reclaim-client");
    const baseInput = {
      clientInstanceId,
      ownerUserId: "user-1",
      idempotencyKey: "idem-reclaim",
      commandKind: "start_conversation_run" as const
    };

    const firstClaim = await store.agentRuns.claimRunStartCommand({
      ...baseInput,
      createdAt: "2026-06-27T00:00:00.000Z"
    });
    expect(firstClaim.status).toBe("claimed");

    const freshRetry = await store.agentRuns.claimRunStartCommand({
      ...baseInput,
      createdAt: "2026-06-27T00:01:00.000Z",
      reclaimPendingBefore: "2026-06-26T23:59:00.000Z"
    });
    expect(freshRetry.status).toBe("existing");

    const reclaimed = await store.agentRuns.claimRunStartCommand({
      ...baseInput,
      createdAt: "2026-06-27T00:06:00.000Z",
      reclaimPendingBefore: "2026-06-27T00:05:00.000Z"
    });
    expect(reclaimed.status).toBe("claimed");
    expect(reclaimed.command).toMatchObject({
      status: "pending",
      updatedAt: "2026-06-27T00:06:00.000Z"
    });
    await expect(
      store.agentRuns.completeRunStartCommand({
        ...baseInput,
        claimedAt: firstClaim.command.updatedAt,
        conversationId: asConversationId("conv_reclaim_old"),
        userMessageId: asMessageId("msg_reclaim_old"),
        runId: asAgentRunId("run_reclaim_old"),
        updatedAt: "2026-06-27T00:07:00.000Z"
      })
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("observes a completed local run from an event cursor", async () => {
    const clientInstanceId = asClientInstanceId("cursor-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-cursor",
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
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "cursor_agent",
              displayName: "Cursor Agent",
              instructions: "Help the user.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProvider: {
          id: "test-provider",
          async complete() {
            return {
              text: "Cursor response.",
              toolCalls: [],
              usage: noReportedUsage()
            };
          }
        },
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
        agentName: "cursor_agent",
        conversationId,
        message: {
          text: "hello"
        }
      },
      context
    );

    const allEvents = [];
    for await (const event of runtime.observe(run.runId, context)) {
      allEvents.push(event);
    }
    expect(allEvents.map((event) => event.type)).toEqual([
      "message_delta",
      "message_completed",
      "run_completed"
    ]);

    const resumedEvents = [];
    for await (const event of runtime.observe(run.runId, context, { afterSequence: 1 })) {
      resumedEvents.push(event);
    }

    expect(resumedEvents.map((event) => event.type)).toEqual([
      "message_completed",
      "run_completed"
    ]);
    expect(resumedEvents.map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("announces the end of a run only after the run is recorded as ended", async () => {
    const clientInstanceId = asClientInstanceId("terminal-order-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-terminal-order",
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
    const inputMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId,
      role: "user",
      text: "hello"
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "terminal_order_agent",
              displayName: "Terminal Order Agent",
              instructions: "Help the user.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        // A store that takes its time, as a loaded database does.
        agentRunStore: {
          ...store.agentRuns,
          async updateAgentRunStatus(input) {
            await new Promise((resolve) => setTimeout(resolve, 25));
            return store.agentRuns.updateAgentRunStatus(input);
          }
        },
        runObservationStore: store.agentRuns,
        modelProvider: {
          id: "test-provider",
          async complete() {
            return {
              text: "Done.",
              toolCalls: [],
              usage: noReportedUsage()
            };
          }
        },
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
        agentName: "terminal_order_agent",
        conversationId,
        inputMessageId: inputMessage.id,
        message: {
          text: "hello"
        }
      },
      context
    );

    // What an observer reads back at the moment it hears the run has ended.
    const recordedWhenAnnounced: Array<string | undefined> = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "run_completed") {
        const recorded = await store.agentRuns.getAgentRun({ clientInstanceId, runId: run.runId });
        recordedWhenAnnounced.push(recorded?.status);
      }
    }

    expect(recordedWhenAnnounced).toEqual(["completed"]);
  });

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

  it("persists the streamed assistant prefix when a run is cancelled", async () => {
    const clientInstanceId = asClientInstanceId("cancel-prefix-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-cancel-prefix",
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
    let releaseProvider: () => void = () => undefined;
    const providerCanContinue = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "cancel_prefix_agent",
              displayName: "Cancel Prefix Agent",
              instructions: "Help the user.",
              modelProviderId: "test-provider",
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProvider: {
          id: "test-provider",
          async complete() {
            throw new Error("Expected the streaming provider path to be used");
          },
          async *stream(): AsyncIterable<ModelCompletionStreamEvent> {
            yield {
              type: "reasoning_delta",
              id: "reasoning_1",
              delta: "Thinking before the visible prefix."
            };
            yield {
              type: "text_delta",
              delta: "Visible prefix"
            };
            await providerCanContinue;
            yield {
              type: "text_delta",
              delta: " late token"
            };
            yield {
              type: "completed",
              completion: {
                text: "Visible prefix late token final",
                toolCalls: [],
                usage: noReportedUsage()
              }
            };
          }
        },
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
        agentName: "cancel_prefix_agent",
        conversationId,
        message: {
          text: "cancel after a prefix"
        }
      },
      context
    );

    const events = [];
    for await (const event of runtime.observe(run.runId, context)) {
      events.push(event);
      if (event.type === "message_delta") {
        await runtime.cancel(run.runId, "user_requested", context);
      }
    }
    releaseProvider();
    await Promise.resolve();

    expect(events.map((event) => event.type)).toEqual([
      "reasoning_delta",
      "message_delta",
      "message_completed",
      "run_cancelled"
    ]);
    expect(
      events.filter((event) => event.type === "message_delta").map((event) => event.delta)
    ).toEqual(["Visible prefix"]);
    expect(events.find((event) => event.type === "message_completed")).toMatchObject({
      message: {
        text: "Visible prefix",
        metadata: {
          agentRuntime: {
            kind: "assistant_final",
            runId: run.runId,
            finishStatus: "cancelled",
            cancellationReason: "user_requested",
            reasoning: [
              {
                id: "reasoning_1",
                text: "Thinking before the visible prefix."
              }
            ]
          }
        }
      }
    });

    const assistantMessages = (
      await store.conversations.listMessages({
        clientInstanceId,
        conversationId
      })
    ).filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]).toMatchObject({
      text: "Visible prefix",
      metadata: {
        agentRuntime: {
          kind: "assistant_final",
          finishStatus: "cancelled",
          cancellationReason: "user_requested"
        }
      }
    });
  });

  it("aborts the active tool context when a run is cancelled", async () => {
    const clientInstanceId = asClientInstanceId("cancel-tool-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-cancel-tool",
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
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    let markToolAborted!: () => void;
    const toolAborted = new Promise<void>((resolve) => {
      markToolAborted = resolve;
    });
    let observedAbortReason: unknown;
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "cancel_tool_agent",
              displayName: "Cancel Tool Agent",
              instructions: "Use the tool.",
              modelProviderId: "test-provider",
              toolNames: ["test.wait"],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProvider: {
          id: "test-provider",
          async complete() {
            throw new Error("Expected the streaming provider path to be used");
          },
          async *stream(): AsyncIterable<ModelCompletionStreamEvent> {
            yield {
              type: "completed",
              completion: {
                text: "",
                toolCalls: [
                  {
                    toolCallId: "call_wait",
                    toolName: "test.wait",
                    input: {}
                  }
                ],
                usage: noReportedUsage()
              }
            };
          }
        },
        toolRegistry: new ToolRegistry({
          tools: [
            defineTool({
              name: "test.wait",
              effect: "reading",
              description: "Wait until cancelled.",
              inputSchema: z.object({}),
              async execute() {
                throw new Error("Tool registry execution should not be used by this test");
              }
            })
          ]
        }),
        async runTool(_request, toolContext) {
          markToolStarted();
          await new Promise<void>((resolve) => {
            if (toolContext.signal?.aborted) {
              resolve();
              return;
            }
            toolContext.signal?.addEventListener("abort", () => resolve(), { once: true });
          });
          observedAbortReason = toolContext.signal?.reason;
          markToolAborted();
          return {
            status: "cancelled",
            error: {
              code: "cancelled",
              message: "Tool was cancelled"
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
        agentName: "cancel_tool_agent",
        conversationId,
        message: {
          text: "Wait"
        }
      },
      context
    );
    await toolStarted;

    await runtime.cancel(run.runId, "user_requested", context);
    await toolAborted;

    expect(observedAbortReason).toBe("user_requested");
    await expect(runtime.getStatus(run.runId, context)).resolves.toBe("cancelled");
  });
});
