import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AppError,
  asAgentRunId,
  asClientInstanceId,
  type ChatMessage,
  type JsonObject,
  type ModelProviderConfig,
  type RunObservationStore,
  type RuntimeCallContext,
  type ToolExecution,
  type ToolExecutionResult
} from "@vivd-catalyst/core";
import { InMemoryPlatformStore } from "@vivd-catalyst/core/testing";
import { LocalAgentRuntime, type LocalAgentRunFailureReport } from "@vivd-catalyst/agent-runtime";
import {
  modelContentText,
  type ModelCompletionStreamEvent,
  type ModelMessage,
  type ModelProvider
} from "@vivd-catalyst/model-provider";
import { defineTool } from "@vivd-catalyst/tool-sdk";
import { ToolRegistry } from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import {
  createAssistantToolCallsMetadata,
  createModelVisibleToolOutput,
  readAssistantReasoningSummaries,
  createToolResultMetadata
} from "../packages/agent-runtime/src/model-context-projection";

describe("local agent runtime", () => {
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
    const store = new InMemoryPlatformStore();
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "cursor_agent",
          displayName: "Cursor Agent",
          instructions: "Help the user.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
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
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

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
    const store = new InMemoryPlatformStore();
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
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "cancel_prefix_agent",
          displayName: "Cancel Prefix Agent",
          instructions: "Help the user.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
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
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

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
    expect(events.filter((event) => event.type === "message_delta").map((event) => event.delta)).toEqual([
      "Visible prefix"
    ]);
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

    const assistantMessages = (await store.listMessages({
      clientInstanceId,
      conversationId
    })).filter((message) => message.role === "assistant");
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
    const store = new InMemoryPlatformStore();
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
    const modelProvider: ModelProvider = {
      id: "test-provider",
      async complete(request) {
        providerMessages = request.messages;
        const sawEarlierTurn = request.messages.some(
          (message) => message.role === "user" && modelContentText(message.content).includes("favorite color is blue")
        );
        return {
          text: sawEarlierTurn ? "Your favorite color is blue." : "I do not know yet.",
          toolCalls: [],
          usage: {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            source: "not_reported"
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "history_agent",
          displayName: "History Agent",
          instructions: "Use conversation history.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

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

  it("marks the durable run failed when observation persistence fails", async () => {
    const clientInstanceId = asClientInstanceId("observation-failure-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-observation-failure",
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
    const store = new InMemoryPlatformStore();
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const inputMessage = await store.appendMessage({
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
    const failingObservationStore: RunObservationStore = {
      async appendRunObservation() {
        throw new AppError("INTERNAL", "simulated observation write failure");
      },
      async listRunObservations() {
        return [];
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "observation_failure_agent",
          displayName: "Observation Failure Agent",
          instructions: "Help the user.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      agentRunStore: store,
      runObservationStore: failingObservationStore,
      modelProvider: {
        id: "test-provider",
        async complete() {
          return {
            text: "This response cannot be made durable.",
            toolCalls: [],
            usage: noReportedUsage()
          };
        }
      },
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

    const run = await runtime.start(
      {
        agentName: "observation_failure_agent",
        conversationId,
        inputMessageId: inputMessage.id,
        message: {
          text: "hello"
        }
      },
      context
    );

    for await (const _event of runtime.observe(run.runId, context)) {
      // Drain the live observer; the durable run status is the public API authority.
    }
    const persistedRun = await waitForPersistedRunStatus(store, {
      clientInstanceId,
      runId: run.runId,
      status: "failed"
    });

    expect(persistedRun).toMatchObject({
      status: "failed",
      error: {
        code: "OBSERVATION_PERSISTENCE_FAILED",
        message: "Agent run observation persistence failed",
        category: "internal_error"
      }
    });
  });

  it("resolves the configured model binding for an agent run", async () => {
    const clientInstanceId = asClientInstanceId("binding-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-binding",
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
    const store = new InMemoryPlatformStore();
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "provider-default"
    };
    let providerRequest: Parameters<ModelProvider["complete"]>[0] | undefined;
    const modelProvider: ModelProvider = {
      id: "test-provider",
      async complete(request) {
        providerRequest = request;
        return {
          text: "Bound model response.",
          toolCalls: [],
          usage: noReportedUsage()
        };
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "binding_agent",
          displayName: "Binding Agent",
          instructions: "Use the configured model binding.",
          modelBindingId: "primaryReasoning",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      modelBindings: [
        {
          id: "primaryReasoning",
          providerId: "test-provider",
          model: "bound-model",
          reasoningEffort: "high"
        }
      ],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

    const run = await runtime.start(
      {
        agentName: "binding_agent",
        conversationId,
        message: {
          text: "Use the bound model."
        }
      },
      context
    );

    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "message_completed") {
        break;
      }
    }

    expect(providerRequest).toMatchObject({
      providerId: "test-provider",
      model: "bound-model",
      reasoningEffort: "high"
    });
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
    const store = new InMemoryPlatformStore();
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
    const modelProvider: ModelProvider = {
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
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "tool_history_agent",
          displayName: "Tool History Agent",
          instructions: "Use conversation history.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

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
    const store = new InMemoryPlatformStore();
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
    const modelProvider: ModelProvider = {
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
            source: "not_reported"
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "locale_agent",
          displayName: "Locale Agent",
          instructions: "Help the user.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      }),
      clock: {
        now: () => new Date("2026-06-19T12:00:00.000Z")
      }
    });

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
    const store = new InMemoryPlatformStore();
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
    const modelProvider: ModelProvider = {
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
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "tool_stream_agent",
          displayName: "Tool Stream Agent",
          instructions: "Use tools when useful.",
          modelProviderId: "test-provider",
          toolNames: ["test.inspect"],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({
        tools: [
          defineTool({
            name: "test.inspect",
            description: "Inspect a page.",
            inputSchema: z.object({ page: z.number() }),
            async execute() {
              throw new Error("Tool registry execution should not be used by this test");
            }
          })
        ]
      }),
      toolExecution: {
        async authorize() {
          return { status: "allowed" };
        },
        async execute(request) {
          return {
            status: "success",
            output: {
              inspectedPage: (request.input as { page?: number }).page
            }
          };
        }
      },
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

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
    const startedToolInputs: unknown[] = [];
    const completedMessages: string[] = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "reasoning_delta") {
        reasoningDeltas.push(event.delta);
      }
      if (event.type === "message_delta") {
        textDeltas.push(event.delta);
      }
      if (event.type === "tool_call_started") {
        startedToolInputs.push(event.input);
      }
      if (event.type === "message_completed") {
        completedMessages.push(event.message.text);
      }
    }

    expect(textDeltas).toEqual([
      "I will inspect page 2.",
      "The page contains the invoice total."
    ]);
    expect(reasoningDeltas).toEqual(["I need to inspect the referenced page."]);
    expect(startedToolInputs).toEqual([{ page: 2 }]);
    expect(completedMessages).toEqual(["The page contains the invoice total."]);

    const assistantMessages = (await store.listMessages({
      clientInstanceId,
      conversationId
    })).filter((message) => message.role === "assistant");
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

  it("feeds invalid tool argument JSON back to the model as a failed tool result", async () => {
    const clientInstanceId = asClientInstanceId("invalid-tool-json-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-invalid-tool-json",
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
    const store = new InMemoryPlatformStore();
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
    let invalidToolResult = "";
    let validToolExecutions = 0;
    const modelProvider: ModelProvider = {
      id: "test-provider",
      async complete() {
        throw new Error("Expected the streaming provider path to be used");
      },
      async *stream(request): AsyncIterable<ModelCompletionStreamEvent> {
        modelStep += 1;
        if (modelStep === 1) {
          yield {
            type: "completed",
            completion: {
              text: "I will inspect the page.",
              toolCalls: [
                {
                  toolCallId: "call_bad_json",
                  toolName: "test.inspect",
                  input: {},
                  inputParseError: {
                    code: "invalid_json",
                    message: "Tool input must be valid JSON",
                    rawInput: "{\"page\":"
                  }
                }
              ],
              usage: noReportedUsage()
            }
          };
          return;
        }

        if (modelStep === 2) {
          const toolMessage = request.messages.find(
            (message) => message.role === "tool" && message.toolCallId === "call_bad_json"
          );
          invalidToolResult = modelContentText(toolMessage?.content ?? "");
          yield {
            type: "completed",
            completion: {
              text: "I will retry with valid JSON.",
              toolCalls: [
                {
                  toolCallId: "call_valid_json",
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
          type: "completed",
          completion: {
            text: "The valid retry worked.",
            toolCalls: [],
            usage: noReportedUsage()
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "invalid_tool_json_agent",
          displayName: "Invalid Tool JSON Agent",
          instructions: "Use tools when useful.",
          modelProviderId: "test-provider",
          toolNames: ["test.inspect"],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({
        tools: [
          defineTool({
            name: "test.inspect",
            description: "Inspect a page.",
            inputSchema: z.object({ page: z.number() }),
            async execute() {
              throw new Error("Tool registry execution should not be used by this test");
            }
          })
        ]
      }),
      toolExecution: {
        async authorize() {
          return { status: "allowed" };
        },
        async execute() {
          validToolExecutions += 1;
          return {
            status: "success",
            output: {
              inspected: true
            }
          };
        }
      },
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

    const run = await runtime.start(
      {
        agentName: "invalid_tool_json_agent",
        conversationId,
        message: {
          text: "Check page 2"
        }
      },
      context
    );

    const failedToolErrors: unknown[] = [];
    const completedMessages: string[] = [];
    for await (const event of runtime.observe(run.runId, context)) {
      if (event.type === "tool_call_failed") {
        failedToolErrors.push(event.result.error);
      }
      if (event.type === "message_completed") {
        completedMessages.push(event.message.text);
      }
    }

    expect(failedToolErrors).toEqual([
      {
        code: "validation_failed",
        message: "Tool input must be valid JSON",
        details: {
          issues: [
            {
              code: "invalid_json",
              path: "",
              message: "Tool input must be valid JSON"
            }
          ]
        }
      }
    ]);
    expect(invalidToolResult).toContain("Tool input must be valid JSON");
    expect(invalidToolResult).toContain("invalid_json");
    expect(validToolExecutions).toBe(1);
    expect(completedMessages).toEqual(["The valid retry worked."]);
  });

  it("does not expose raw internal error text in run failure events", async () => {
    const clientInstanceId = asClientInstanceId("internal-error-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-internal-error",
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
    const store = new InMemoryPlatformStore();
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const thrownError = new Error("Failed query: insert into messages params: secret document text");
    let reportedFailure: LocalAgentRunFailureReport | undefined;
    const modelProvider: ModelProvider = {
      id: "test-provider",
      async complete() {
        throw thrownError;
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "error_agent",
          displayName: "Error Agent",
          instructions: "Help the user.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      }),
      runFailureReporter(report) {
        reportedFailure = report;
      }
    });

    const run = await runtime.start(
      {
        agentName: "error_agent",
        conversationId,
        message: {
          text: "hello"
        }
      },
      context
    );

    const failed = await firstRunFailedEvent(runtime, run.runId, context);

    expect(failed.error).toEqual({
      code: "INTERNAL",
      message: "Agent run failed",
      category: "internal_error"
    });
    expect(reportedFailure?.runId).toBe(run.runId);
    expect(reportedFailure?.failure).toEqual(failed.error);
    expect(reportedFailure?.error).toBe(thrownError);
  });

  it("keeps non-internal AppError messages visible in run failure events", async () => {
    const clientInstanceId = asClientInstanceId("app-error-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-app-error",
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
    const store = new InMemoryPlatformStore();
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    const modelProvider: ModelProvider = {
      id: "test-provider",
      async complete() {
        throw new AppError("CONFLICT", "Daily model call safeguard has been reached");
      }
    };
    const runtime = new LocalAgentRuntime({
      agents: [
        {
          name: "app_error_agent",
          displayName: "App Error Agent",
          instructions: "Help the user.",
          modelProviderId: "test-provider",
          toolNames: [],
          initialPrompts: []
        }
      ],
      modelProviders: [providerConfig],
      defaultModelProvider: providerConfig,
      conversationHistory: store,
      modelProvider,
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: createUnusedToolExecution(),
      usageGovernance: new ModelUsageGovernance({
        store,
        budget: {
          costSafetyMultiplier: 1
        },
        safeguards: {}
      })
    });

    const run = await runtime.start(
      {
        agentName: "app_error_agent",
        conversationId,
        message: {
          text: "hello"
        }
      },
      context
    );

    const failed = await firstRunFailedEvent(runtime, run.runId, context);

    expect(failed.error).toEqual({
      code: "CONFLICT",
      message: "Daily model call safeguard has been reached",
      category: "app_error"
    });
  });
});

async function createConversationWithMessages(
  store: InMemoryPlatformStore,
  input: {
    clientInstanceId: ChatMessage["clientInstanceId"];
    messages: Array<{ role: ChatMessage["role"]; text: string; metadata?: JsonObject }>;
  }
): Promise<ChatMessage["conversationId"]> {
  const conversation = await store.createConversation({
    clientInstanceId: input.clientInstanceId,
    ownerUserId: "user-1",
    ownerExternalUserId: "user-1",
    title: "Test conversation",
    retainedUntil: new Date(Date.now() + 86_400_000).toISOString()
  });
  for (const message of input.messages) {
    await store.appendMessage({
      clientInstanceId: input.clientInstanceId,
      conversationId: conversation.id,
      role: message.role,
      text: message.text,
      metadata: message.metadata
    });
  }
  return conversation.id;
}

function createUnusedToolExecution(): ToolExecution {
  return {
    async authorize() {
      throw new Error("Tool execution should not be used");
    },
    async execute() {
      throw new Error("Tool execution should not be used");
    }
  };
}

function noReportedUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    source: "not_reported" as const
  };
}

function modelContextOptions() {
  return {
    toolOutput: {
      maxTokens: 60000
    }
  };
}

async function firstRunFailedEvent(
  runtime: LocalAgentRuntime,
  runId: ReturnType<typeof asAgentRunId>,
  context: RuntimeCallContext
) {
  for await (const event of runtime.observe(runId, context)) {
    if (event.type === "run_failed") {
      return event;
    }
  }
  throw new Error("Run did not fail");
}

async function waitForPersistedRunStatus(
  store: InMemoryPlatformStore,
  input: {
    clientInstanceId: ReturnType<typeof asClientInstanceId>;
    runId: ReturnType<typeof asAgentRunId>;
    status: string;
  }
) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const run = await store.getAgentRun({
      clientInstanceId: input.clientInstanceId,
      runId: input.runId
    });
    if (run?.status === input.status) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Run did not reach status '${input.status}'`);
}
