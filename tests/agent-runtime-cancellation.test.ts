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
  noReportedUsage
} from "./helpers/agent-runtime";
import { withTestModelGateway } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
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
