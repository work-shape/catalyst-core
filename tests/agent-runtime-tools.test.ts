import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import { messageSchema } from "@work-shape/catalyst-api-contract";
import {
  asClientInstanceId,
  asManagedArtifactId,
  readAssistantFinalMetadata,
  readToolResultMetadata,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import {
  modelContentText,
  type ModelCompletionStreamEvent
} from "@work-shape/catalyst-model-provider";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createConversationWithMessages, noReportedUsage } from "./helpers/agent-runtime";
import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";
import { createTestToolRunner } from "./support/tool-runner";

describe("local agent runtime", () => {
  it("E6 persists only cited Knowledge Base source identities on the assistant answer", async () => {
    const clientInstanceId = asClientInstanceId("knowledge-citation-runtime");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "knowledge-citations",
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
    const provider: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    let step = 0;
    const source = {
      ref: "K1",
      knowledgeBase: "handbook",
      documentId: "doc",
      fileId: "file",
      fileName: "handbook.pdf",
      page: 4,
      originLink: "https://example.test/original"
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              name: "reader",
              displayName: "Reader",
              instructions: "Search and cite.",
              modelProviderId: provider.id,
              toolNames: [],
              skillNames: [],
              initialPrompts: [],
              knowledgeBases: ["handbook"]
            }
          ]
        }),
        modelProviders: [provider],
        defaultModelProvider: provider,
        conversationHistory: store.conversations,
        modelProvider: {
          id: provider.id,
          async complete() {
            step += 1;
            return step === 1
              ? {
                  text: "",
                  toolCalls: [
                    {
                      toolCallId: "search",
                      toolName: "knowledge.search",
                      input: { query: "vacation" }
                    }
                  ],
                  usage: noReportedUsage()
                }
              : { text: "28 days [K1].", toolCalls: [], usage: noReportedUsage() };
          }
        },
        toolRegistry: new ToolRegistry({ tools: [] }),
        dataTools: {
          describe: async () => [
            {
              name: "knowledge.handbook.search",
              effect: "reading",
              description: "Handbook",
              inputJsonSchema: {}
            },
            {
              name: "knowledge.search",
              effect: "reading",
              description: "Search handbook",
              inputJsonSchema: {}
            }
          ]
        },
        runTool: async () => ({
          status: "success",
          output: {
            passages: [
              { ...source, text: "private passage text", score: 1 },
              { ...source, ref: "K2", text: "uncited passage", score: 0.5 }
            ]
          }
        }),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );
    const run = await runtime.start(
      { agentName: "reader", conversationId, message: { text: "How much vacation?" } },
      context
    );
    for await (const _event of runtime.observe(run.runId, context)) {
      /* drain */
    }
    const messages = await store.conversations.listMessages({ clientInstanceId, conversationId });
    const answer = messages.findLast((message) => message.role === "assistant");
    const metadata = readAssistantFinalMetadata(answer?.metadata);
    expect(metadata?.knowledgeSources).toEqual([source]);
    // The API client parses this schema before the renderer sees the answer. Unknown final
    // metadata fields are stripped, so a metadata-only test would miss the broken render path.
    const received = messageSchema.parse(answer);
    expect(readAssistantFinalMetadata(received.metadata)?.knowledgeSources).toEqual([source]);
    expect(JSON.stringify(metadata)).not.toContain("private passage text");
    expect(JSON.stringify(metadata)).not.toContain("uncited passage");
  });

  it("persists tool result artifacts in durable observations and tool message metadata", async () => {
    const clientInstanceId = asClientInstanceId("tool-artifact-observation-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-tool-artifact-observation",
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
    const conversation = await store.createConversationForTesting({
      clientInstanceId,
      createdByUserId: "user-1",
      createdByExternalUserId: "user-1",
      title: "Tool artifact observation",
      retainedUntil: "2026-07-29T00:00:00.000Z"
    });
    const userMessage = await store.conversations.appendMessage({
      clientInstanceId,
      conversationId: conversation.id,
      role: "user",
      text: "Create the artifact"
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "test-model"
    };
    let modelStep = 0;
    const artifact = {
      artifactId: asManagedArtifactId("art_runtime_persisted"),
      kind: "document.pdf",
      filename: "result.pdf",
      mimeType: "application/pdf",
      metadata: {
        source: "test"
      }
    };
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete() {
        modelStep += 1;
        if (modelStep === 1) {
          return {
            text: "I will create the artifact.",
            toolCalls: [
              {
                toolCallId: "call_artifact",
                toolName: "test.promote_artifact",
                input: { path: "result.pdf" }
              }
            ],
            usage: noReportedUsage()
          };
        }
        return {
          text: "Artifact ready.",
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
              name: "artifact_agent",
              displayName: "Artifact Agent",
              instructions: "Use tools when useful.",
              modelProviderId: "test-provider",
              toolNames: ["test.promote_artifact"],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        defaultModelProvider: providerConfig,
        conversationHistory: store.conversations,
        agentRunStore: store.agentRuns,
        runObservationStore: store.agentRuns,
        modelProvider,
        toolRegistry: new ToolRegistry({
          tools: [
            defineTool({
              name: "test.promote_artifact",
              effect: "reading",
              description: "Promote an artifact.",
              inputSchema: z.object({ path: z.string() }),
              async execute() {
                throw new Error("Tool registry execution should not be used by this test");
              }
            })
          ]
        }),
        async runTool() {
          return {
            status: "success",
            output: {
              artifactId: artifact.artifactId,
              path: "result.pdf"
            },
            artifacts: [artifact]
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
        agentName: "artifact_agent",
        conversationId: conversation.id,
        inputMessageId: userMessage.id,
        message: {
          text: "Create the artifact"
        }
      },
      context
    );

    for await (const _event of runtime.observe(run.runId, context)) {
      // Drain the run so event persistence has completed.
    }

    const observations = await store.agentRuns.listRunObservations({
      clientInstanceId,
      runId: run.runId
    });
    const toolObservation = observations.find(
      (observation) => observation.type === "tool_call_completed"
    );
    expect(toolObservation?.payload).toMatchObject({
      type: "tool_call_completed",
      result: {
        status: "success",
        artifacts: [artifact]
      }
    });

    const toolMessage = (
      await store.conversations.listMessages({
        clientInstanceId,
        conversationId: conversation.id
      })
    ).find((message) => message.role === "tool");
    expect(readToolResultMetadata(toolMessage?.metadata)?.result).toMatchObject({
      status: "success",
      artifacts: [artifact]
    });
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
    let invalidToolResult = "";
    let validToolExecutions = 0;
    const inspectTools = new ToolRegistry({
      tools: [
        defineTool({
          name: "test.inspect",
          description: "Inspect a page.",
          effect: "reading",
          inputSchema: z.object({ page: z.number() }),
          execute() {
            validToolExecutions += 1;
            return toolSuccess({ inspected: true });
          }
        })
      ]
    });
    const providerContinuation = {
      providerId: "test-provider",
      state: { encrypted: "opaque-provider-state" }
    };
    let receivedProviderContinuation: unknown;
    const modelProvider: FakeModelProvider = {
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
              continuation: providerContinuation,
              toolCalls: [
                {
                  toolCallId: "call_bad_json",
                  toolName: "test.inspect",
                  input: {},
                  inputParseError: {
                    code: "invalid_json",
                    message: "Tool input must be valid JSON",
                    rawInput: '{"page":'
                  }
                }
              ],
              usage: noReportedUsage()
            }
          };
          return;
        }

        if (modelStep === 2) {
          receivedProviderContinuation = request.continuation;
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
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "invalid_tool_json_agent",
              displayName: "Invalid Tool JSON Agent",
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
        toolRegistry: inspectTools,
        // The call takes the path every tool call takes, so the input that could not be read
        // is answered by that path and not by this test.
        runTool: createTestToolRunner({
          registry: inspectTools,
          getAgentToolNames: () => ["test.inspect"]
        }),
        usageGovernance: new ModelUsageGovernance({
          store: store.usage,
          budget: {},
          safeguards: {}
        })
      })
    );

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
        if (event.result.status !== "success") failedToolErrors.push(event.result.error);
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
    expect(receivedProviderContinuation).toBe(providerContinuation);
    expect(validToolExecutions).toBe(1);
    expect(completedMessages).toEqual(["The valid retry worked."]);
  });
});
