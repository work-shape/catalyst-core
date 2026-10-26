import {
  LocalAgentRuntime,
  type LocalAgentRunFailureReport
} from "@work-shape/catalyst-agent-runtime";
import {
  AppError,
  asClientInstanceId,
  type ModelProviderConfig,
  type RunObservationStore,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import {
  OpenAiCompatibleChatProvider,
  type ModelCompletionStreamEvent
} from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it, vi } from "vitest";
import {
  createConversationWithMessages,
  createUnusedToolRunner,
  firstRunFailedEvent,
  noReportedUsage,
  waitForPersistedRunStatus
} from "./helpers/agent-runtime";
import {
  createRecordingGovernance,
  withoutStreaming,
  withTestModelGateway,
  type FakeModelProvider
} from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
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
    const failingObservationStore: RunObservationStore = {
      async appendRunObservation() {
        throw new AppError("INTERNAL", "simulated observation write failure");
      },
      async listRunObservations() {
        return [];
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "observation_failure_agent",
              displayName: "Observation Failure Agent",
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
        agentRunStore: store.agentRuns,
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

  it.each(["chat_completions", "responses"] as const)(
    "retries an interrupted successful %s JSON response",
    async (api) => {
      const clientInstanceId = asClientInstanceId("provider-body-retry-client");
      const context: RuntimeCallContext = {
        clientInstanceId,
        correlationId: "corr-provider-body-retry",
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
        type: "openai-compatible",
        model: "test-model"
      };
      const provider = new OpenAiCompatibleChatProvider({
        id: providerConfig.id,
        api,
        model: providerConfig.model,
        baseUrl: "https://provider.test/v1",
        apiKey: "test"
      });
      const interrupted = new TypeError("terminated", {
        cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" })
      });
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(interrupted);
              }
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce(
          Response.json(
            api === "chat_completions"
              ? { choices: [{ message: { content: "Recovered after interruption." } }] }
              : {
                  output: [
                    {
                      type: "message",
                      content: [{ type: "output_text", text: "Recovered after interruption." }]
                    }
                  ]
                }
          )
        );
      try {
        const runtime = new LocalAgentRuntime(
          withTestModelGateway({
            assetSource: createStaticConfigAssetSource({
              agents: [
                {
                  name: "retry_agent",
                  skillNames: [],
                  displayName: "Retry Agent",
                  instructions: "Help the user.",
                  modelProviderId: providerConfig.id,
                  toolNames: [],
                  initialPrompts: []
                }
              ]
            }),
            modelProviders: [providerConfig],
            defaultModelProvider: providerConfig,
            conversationHistory: store.conversations,
            modelProvider: withoutStreaming(provider),
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
          { agentName: "retry_agent", conversationId, message: { text: "hello" } },
          context
        );
        const events = [];
        for await (const event of runtime.observe(run.runId, context)) {
          events.push(event);
        }
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(events.map((event) => event.type)).toContain("run_completed");
        expect(events.map((event) => event.type)).not.toContain("run_failed");
      } finally {
        fetchMock.mockRestore();
      }
    }
  );

  it("retries a transient provider disconnect before streamed output or tool execution", async () => {
    const clientInstanceId = asClientInstanceId("provider-stream-retry-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-provider-stream-retry",
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
    let attempts = 0;
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete() {
        throw new Error("Expected the streaming provider path to be used");
      },
      async *stream(): AsyncIterable<ModelCompletionStreamEvent> {
        attempts += 1;
        if (attempts === 1) {
          yield {
            type: "tool_call_preparing",
            toolCallId: "call_interrupted",
            toolName: "workspace.exec"
          };
          throw Object.assign(new TypeError("terminated"), {
            cause: { code: "UND_ERR_SOCKET" }
          });
        }
        if (attempts === 2) {
          yield {
            type: "completed",
            completion: {
              text: "Recovered after a transient disconnect.",
              toolCalls: [],
              usage: noReportedUsage()
            }
          };
          return;
        }
        yield { type: "text_delta", delta: "Visible partial output." };
        throw new TypeError("terminated");
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "provider_stream_retry_agent",
              displayName: "Provider Stream Retry Agent",
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
        })
      })
    );

    const run = await runtime.start(
      {
        agentName: "provider_stream_retry_agent",
        conversationId,
        message: { text: "hello" }
      },
      context
    );
    const events = [];
    for await (const event of runtime.observe(run.runId, context)) {
      events.push(event);
    }

    expect(attempts).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "tool_call_preparing",
      "tool_call_preparation_cancelled",
      "message_delta",
      "message_completed",
      "run_completed"
    ]);
    expect(events).not.toContainEqual(expect.objectContaining({ type: "run_failed" }));

    const secondConversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const interruptedRun = await runtime.start(
      {
        agentName: "provider_stream_retry_agent",
        conversationId: secondConversationId,
        message: { text: "hello again" }
      },
      context
    );
    const interruptedEvents = [];
    for await (const event of runtime.observe(interruptedRun.runId, context)) {
      interruptedEvents.push(event);
    }

    expect(attempts).toBe(3);
    expect(interruptedEvents.map((event) => event.type)).toEqual(["message_delta", "run_failed"]);
  });

  it("does not repeat a completed model call when usage persistence fails", async () => {
    const clientInstanceId = asClientInstanceId("usage-persistence-failure-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-usage-persistence-failure",
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
    let providerCalls = 0;
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete() {
        throw new Error("Expected the streaming provider path to be used");
      },
      async *stream(): AsyncIterable<ModelCompletionStreamEvent> {
        providerCalls += 1;
        yield {
          type: "completed",
          completion: {
            text: "The provider completed once.",
            toolCalls: [],
            usage: noReportedUsage()
          }
        };
      }
    };
    const usageGovernance = createRecordingGovernance();
    usageGovernance.failSettlement = Object.assign(new Error("usage persistence timed out"), {
      code: "ETIMEDOUT"
    });
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "usage_persistence_failure_agent",
              displayName: "Usage Persistence Failure Agent",
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
        usageGovernance
      })
    );

    const run = await runtime.start(
      {
        agentName: "usage_persistence_failure_agent",
        conversationId,
        message: { text: "hello" }
      },
      context
    );
    const events = [];
    for await (const event of runtime.observe(run.runId, context)) {
      events.push(event);
    }

    expect(providerCalls).toBe(1);
    expect(events.map((event) => event.type)).toEqual(["message_delta", "run_failed"]);
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
    const thrownError = new Error(
      "Failed query: insert into messages params: secret document text"
    );
    let reportedFailure: LocalAgentRunFailureReport | undefined;
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete() {
        throw thrownError;
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "error_agent",
              displayName: "Error Agent",
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
        runFailureReporter(report) {
          reportedFailure = report;
        }
      })
    );

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
        throw new AppError("CONFLICT", "Daily model call safeguard has been reached");
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "app_error_agent",
              displayName: "App Error Agent",
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
        })
      })
    );

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
