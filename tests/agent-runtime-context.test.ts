import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asAgentRunId,
  asClientInstanceId,
  type ModelProviderConfig,
  type RuntimeCallContext,
  type ToolExecutionResult
} from "@work-shape/catalyst-core";
import { modelContentText, type ModelMessage } from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { defineTool } from "@work-shape/catalyst-tool-sdk";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createAssistantToolCallsMetadata,
  createConversationWithMessages,
  createModelVisibleToolOutput,
  createToolResultMetadata,
  createUnusedToolRunner,
  modelContextOptions,
  noReportedUsage
} from "./helpers/agent-runtime";

import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
  it("loads an edited asset snapshot on the next run", async () => {
    const clientInstanceId = asClientInstanceId("mutable-assets-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-mutable-assets",
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
    let assetVersion = 1;
    let instructions = "First asset instructions.";
    const seenSystemInstructions: string[] = [];
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: {
          async getSnapshot() {
            return {
              version: assetVersion,
              defaultAgentName: "mutable_agent",
              agents: [
                {
                  name: "mutable_agent",
                  displayName: "Mutable Agent",
                  instructions,
                  modelProviderId: "test-provider",
                  toolNames: [],
                  skillNames: [],
                  initialPrompts: []
                }
              ],
              skills: []
            };
          },
          getSkill: async () => undefined,
          getSkillRevision: async () => undefined
        },
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProvider: {
          id: "test-provider",
          async complete(request) {
            const systemMessage = request.messages.find((message) => message.role === "system");
            seenSystemInstructions.push(
              systemMessage ? modelContentText(systemMessage.content) : ""
            );
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

    const firstRun = await runtime.start(
      {
        agentName: "mutable_agent",
        conversationId,
        message: { text: "First run" }
      },
      context
    );
    for await (const _event of runtime.observe(firstRun.runId, context)) {
      // Drain the run before editing the source.
    }

    assetVersion = 2;
    instructions = "Edited asset instructions.";
    const secondRun = await runtime.start(
      {
        agentName: "mutable_agent",
        conversationId,
        message: { text: "Second run" }
      },
      context
    );
    for await (const _event of runtime.observe(secondRun.runId, context)) {
      // Drain the run so the second snapshot is observed.
    }

    expect(seenSystemInstructions[0]).toContain("First asset instructions.");
    expect(seenSystemInstructions[1]).toContain("Edited asset instructions.");
  });

  it("loads conversation history before the new user message", async () => {
    const clientInstanceId = asClientInstanceId("history-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-history",
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
      messages: [
        { role: "user", text: "My favorite color is blue." },
        { role: "assistant", text: "I will remember that." },
        { role: "user", text: "What is my favorite color?" }
      ]
    });
    let providerMessages: ModelMessage[] = [];
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        providerMessages = request.messages;
        const sawEarlierTurn = request.messages.some(
          (message) =>
            message.role === "user" &&
            modelContentText(message.content).includes("favorite color is blue")
        );
        return {
          text: sawEarlierTurn ? "Your favorite color is blue." : "I do not know yet.",
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            source: "not_reported",
            webSearchCallCount: 0
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
              name: "history_agent",
              displayName: "History Agent",
              instructions: "Use conversation history.",
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
        agentName: "history_agent",
        conversationId,
        message: {
          text: "What is my favorite color?"
        }
      },
      context
    );

    const completedMessages: string[] = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "message_completed") {
        completedMessages.push(event.message.text);
      }
    }

    expect(completedMessages).toEqual(["Your favorite color is blue."]);
    expect(providerMessages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user"
    ]);
  });

  it("loads complete tool-call history by default before a follow-up turn", async () => {
    const clientInstanceId = asClientInstanceId("tool-history-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-tool-history",
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
    const runId = asAgentRunId("run_tool_history");
    const toolCall = {
      toolCallId: "call_old_page",
      toolName: "view_document_page",
      input: {
        fileId: "file_contract",
        pageNumber: 6
      }
    };
    const result: ToolExecutionResult = {
      status: "success",
      output: {
        pageNumber: 6,
        status: "loaded"
      }
    };
    const modelOutput = await createModelVisibleToolOutput(result, modelContextOptions());
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: [
        {
          role: "assistant",
          text: "I will inspect page 6.",
          metadata: createAssistantToolCallsMetadata({ runId, toolCalls: [toolCall] })
        },
        {
          role: "tool",
          text: modelOutput.text,
          metadata: createToolResultMetadata({
            runId,
            toolCall,
            result,
            modelOutput
          })
        },
        ...Array.from({ length: 18 }, (_, index) => ({
          role: "assistant" as const,
          text: `Filler response ${index + 1}.`
        })),
        { role: "user", text: "Did it work?" }
      ]
    });
    let providerMessages: ModelMessage[] = [];
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        providerMessages = request.messages;
        return {
          text: "Yes, page 6 was loaded.",
          toolCalls: [],
          usage: noReportedUsage()
        };
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "tool_history_agent",
              displayName: "Tool History Agent",
              instructions: "Use conversation history.",
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
        agentName: "tool_history_agent",
        conversationId,
        message: {
          text: "Did it work?"
        }
      },
      context
    );

    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "run_completed") {
        break;
      }
    }

    const assistantToolCallIndex = providerMessages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.toolCalls?.some((candidate) => candidate.toolCallId === "call_old_page")
    );
    const toolResultIndex = providerMessages.findIndex(
      (message) => message.role === "tool" && message.toolCallId === "call_old_page"
    );
    expect(assistantToolCallIndex).toBeGreaterThan(-1);
    expect(toolResultIndex).toBeGreaterThan(assistantToolCallIndex);
  });

  it("adds the resolved locale and current date to system instructions", async () => {
    const clientInstanceId = asClientInstanceId("locale-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-locale",
      locale: "de",
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
    let providerMessages: ModelMessage[] = [];
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        providerMessages = request.messages;
        return {
          text: "Erledigt.",
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            source: "not_reported",
            webSearchCallCount: 0
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
              name: "locale_agent",
              displayName: "Locale Agent",
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
        modelProvider,
        toolRegistry: new ToolRegistry({ tools: [] }),
        runTool: createUnusedToolRunner(),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        }),
        clock: {
          now: () => new Date("2026-06-19T12:00:00.000Z")
        }
      })
    );

    const run = await runtime.start(
      {
        agentName: "locale_agent",
        conversationId,
        message: {
          text: "Hallo"
        }
      },
      context
    );

    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "run_completed") {
        break;
      }
    }

    expect(providerMessages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("- User selected language: German (locale: de).")
    });
    expect(providerMessages[0]?.content).toContain(
      "- Current date: Freitag, 19. Juni 2026 (ISO: 2026-06-19)."
    );
    expect(providerMessages[0]?.content).not.toContain("Respond in German");
  });

  it("tells the agent the asset its conversation is about and offers the tools of that subject", async () => {
    const clientInstanceId = asClientInstanceId("subject-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-subject",
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
    const about = await createConversationWithMessages(store, { clientInstanceId, messages: [] });
    const aboutNothing = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const offeredFor: string[][] = [];
    const requests: Parameters<FakeModelProvider["complete"]>[0][] = [];
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        requests.push(request);
        return {
          text: "Done.",
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            source: "not_reported",
            webSearchCallCount: 0
          }
        };
      }
    };
    const subjectTool = (name: string) =>
      defineTool({
        name,
        effect: "reading",
        description: "A tool of the subject.",
        inputSchema: z.object({}),
        async execute() {
          throw new Error("Tool registry execution should not be used by this test");
        }
      });
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "subject_agent",
              displayName: "Subject Agent",
              instructions: "Help the user.",
              modelProviderId: "test-provider",
              // A definition that lists an asset tool is offered it only where the server offers it.
              toolNames: ["platform.assets.get"],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        modelProvider,
        toolRegistry: new ToolRegistry({
          tools: [subjectTool("platform.assets.get"), subjectTool("platform.assets.put")]
        }),
        runTool: createUnusedToolRunner(),
        conversationOffer: {
          async offerOf({ conversationId, agentToolNames }) {
            offeredFor.push([...agentToolNames]);
            return conversationId === about
              ? {
                  subject: { kind: "workflow", name: "month-end" },
                  toolNames: ["platform.assets.get", "platform.assets.put"],
                  skillNames: [],
                  orientation: "The platform keeps assets."
                }
              : undefined;
          }
        },
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );
    const firstRequestOf = async (conversationId: typeof about) => {
      requests.length = 0;
      const run = await runtime.start(
        { agentName: "subject_agent", conversationId, message: { text: "Can you change it?" } },
        context
      );
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "run_completed") break;
      }
      const [request] = requests;
      return {
        system: modelContentText(request?.messages[0]?.content ?? ""),
        tools: (request?.tools ?? []).flatMap((tool) => ("name" in tool ? [tool.name] : []))
      };
    };

    const first = await firstRequestOf(about);
    expect(first.system).toContain("Subject of this conversation:");
    expect(first.system).toContain("This conversation is about one workflow, named 'month-end'.");
    expect(first.system).toContain("Never ask which workflow they mean.");
    expect(first.system).toContain(
      "Read it with platform.assets.get, naming no asset, before you answer"
    );
    // The offer is asked with the tools the agent's definition lists, and what it offers comes
    // in the order that keeps what stays the same first: the platform's rules, the orientation,
    // the agent's instructions, then the subject.
    expect(offeredFor[0]).toEqual(["platform.assets.get"]);
    const order = [
      "Platform rules:",
      "How this platform works:\nThe platform keeps assets.",
      "Client agent instructions:",
      "Runtime context:",
      "Subject of this conversation:"
    ].map((heading) => first.system.indexOf(heading));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    expect(first.tools).toEqual(
      expect.arrayContaining(["platform.assets.get", "platform.assets.put"])
    );

    const other = await firstRequestOf(aboutNothing);
    expect(other.system).not.toContain("Subject of this conversation:");
    expect(other.system).not.toContain("How this platform works:");
    expect(other.system).not.toContain("month-end");
    expect(other.tools).not.toContain("platform.assets.get");
  });
});
