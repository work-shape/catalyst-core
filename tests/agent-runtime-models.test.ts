import { LocalAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import {
  asClientInstanceId,
  type ModelProviderConfig,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { ModelUsageGovernance } from "@work-shape/catalyst-usage-governance";
import { describe, expect, it } from "vitest";
import {
  createConversationWithMessages,
  createUnusedToolRunner,
  noReportedUsage
} from "./helpers/agent-runtime";
import { withTestModelGateway, type FakeModelProvider } from "./support/model-gateway";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

describe("local agent runtime", () => {
  it("runs a user-selected model binding with the effort configured for that model", async () => {
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
    const store = (await createTestInstance()).stores;
    const conversationId = await createConversationWithMessages(store, {
      clientInstanceId,
      messages: []
    });
    const providerConfig: ModelProviderConfig = {
      id: "test-provider",
      type: "deterministic",
      model: "provider-default"
    };
    let providerRequest: Parameters<FakeModelProvider["complete"]>[0] | undefined;
    const modelProvider: FakeModelProvider = {
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
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              skillNames: [],
              name: "binding_agent",
              displayName: "Binding Agent",
              instructions: "Use the configured model binding.",
              modelBindingId: "primaryReasoning",
              reasoningEffort: "xhigh",
              userSelectableModelBindingIds: ["alternate", "bindingEffort"],
              modelReasoningEfforts: { alternate: "low" },
              toolNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        modelBindings: [
          {
            id: "primaryReasoning",
            providerId: "test-provider",
            model: "bound-model",
            reasoningEffort: "high",
            userSelectableReasoningEfforts: ["low", "high"]
          },
          {
            id: "unlisted",
            providerId: "test-provider",
            model: "unlisted-model",
            userSelectable: true
          },
          {
            id: "bindingEffort",
            providerId: "test-provider",
            model: "binding-effort-model",
            reasoningEffort: "medium"
          },
          {
            id: "alternate",
            providerId: "test-provider",
            model: "user-selected-model",
            userSelectable: true
          }
        ],
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

    const requestFor = async (
      modelBindingId: string | undefined,
      reasoningEffort?: "low" | "medium"
    ) => {
      providerRequest = undefined;
      const run = await runtime.start(
        {
          agentName: "binding_agent",
          modelBindingId,
          reasoningEffort,
          conversationId,
          message: { text: "Use the bound model." }
        },
        context
      );
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "message_completed") {
          break;
        }
      }
      return providerRequest;
    };

    expect(await requestFor("alternate")).toMatchObject({
      providerId: "test-provider",
      model: "user-selected-model",
      reasoningEffort: "low"
    });
    // Without an effort for the picked model its binding's default applies, never the effort
    // of the agent's own model.
    expect(await requestFor("bindingEffort")).toMatchObject({
      model: "binding-effort-model",
      reasoningEffort: "medium"
    });
    // The agent's own effort stays with its own model, picked explicitly or not.
    for (const modelBindingId of ["primaryReasoning", undefined]) {
      expect(await requestFor(modelBindingId)).toMatchObject({
        model: "bound-model",
        reasoningEffort: "xhigh"
      });
    }
    // An effort the user picked wins while the model that runs offers it.
    expect(await requestFor(undefined, "low")).toMatchObject({
      model: "bound-model",
      reasoningEffort: "low"
    });
    // A pick the model does not offer falls back to the configured effort.
    expect(await requestFor(undefined, "medium")).toMatchObject({ reasoningEffort: "xhigh" });
    expect(await requestFor("alternate", "low")).toMatchObject({
      model: "user-selected-model",
      reasoningEffort: "low"
    });

    // A userSelectable binding the agent does not list is rejected by the runtime itself.
    providerRequest = undefined;
    const rejectedRun = await runtime.start(
      {
        agentName: "binding_agent",
        modelBindingId: "unlisted",
        conversationId,
        message: { text: "Use the unlisted model." }
      },
      context
    );
    let lastRejectedEvent: unknown;
    for await (const event of runtime.observe(rejectedRun.runId, context)) {
      lastRejectedEvent = event;
    }
    expect(lastRejectedEvent).toMatchObject({
      type: "run_failed",
      error: {
        message:
          "Model binding 'unlisted' is not available for user selection with agent 'binding_agent'"
      }
    });
    expect(providerRequest).toBeUndefined();
  });

  it("requests fast mode only when the agent enables it and the used binding supports it", async () => {
    const clientInstanceId = asClientInstanceId("fast-mode-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-fast-mode",
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
      model: "provider-default"
    };
    const providerRequests: Array<Parameters<FakeModelProvider["complete"]>[0]> = [];
    const modelProvider: FakeModelProvider = {
      id: "test-provider",
      async complete(request) {
        providerRequests.push(request);
        return {
          text: "Done.",
          toolCalls: [],
          usage: {
            ...noReportedUsage(),
            ...(request.fastMode ? { providerServiceTier: "priority" } : {})
          }
        };
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              name: "fast_agent",
              displayName: "Fast Agent",
              instructions: "Answer quickly.",
              modelBindingId: "fastBinding",
              fastMode: true,
              userSelectableModelBindingIds: ["plainBinding"],
              toolNames: [],
              skillNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        modelBindings: [
          {
            id: "fastBinding",
            providerId: "test-provider",
            model: "fast-model",
            supportsFastMode: true
          },
          {
            id: "plainBinding",
            providerId: "test-provider",
            model: "plain-model",
            userSelectable: true
          }
        ],
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

    for (const modelBindingId of [undefined, "plainBinding"]) {
      const run = await runtime.start(
        { agentName: "fast_agent", modelBindingId, conversationId, message: { text: "Go." } },
        context
      );
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "message_completed") {
          break;
        }
      }
    }

    expect(providerRequests.map((request) => [request.model, request.fastMode])).toEqual([
      ["fast-model", true],
      ["plain-model", false]
    ]);
    const events = await store.usage.listModelUsageEvents({ clientInstanceId });
    expect(
      events
        .map((event) => [event.model, event.fastMode, event.providerServiceTier])
        .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    ).toEqual([
      ["fast-model", true, "priority"],
      ["plain-model", false, undefined]
    ]);
  });

  it("runs the binding offered as the own model of an agent on its provider's model on that same model", async () => {
    const clientInstanceId = asClientInstanceId("own-binding-client");
    const context: RuntimeCallContext = {
      clientInstanceId,
      correlationId: "corr-own-binding",
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
      id: "azure-eu",
      type: "deterministic",
      model: "catalyst-gpt-6.1-sol"
    };
    const providerRequests: Array<Parameters<FakeModelProvider["complete"]>[0]> = [];
    const modelProvider: FakeModelProvider = {
      id: "azure-eu",
      async complete(request) {
        providerRequests.push(request);
        return { text: "Done.", toolCalls: [], usage: noReportedUsage() };
      }
    };
    const runtime = new LocalAgentRuntime(
      withTestModelGateway({
        assetSource: createStaticConfigAssetSource({
          agents: [
            {
              name: "provider_agent",
              displayName: "Provider Agent",
              instructions: "Help.",
              modelProviderId: "azure-eu",
              userSelectableModelBindingIds: ["primaryReasoning"],
              toolNames: [],
              skillNames: [],
              initialPrompts: []
            }
          ]
        }),
        modelProviders: [providerConfig],
        modelBindings: [
          {
            id: "primaryReasoning",
            providerId: "azure-eu",
            model: "catalyst-gpt-6.1-sol",
            label: "GPT-6.1 Sol"
          }
        ],
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

    // Without a pick, as before, and from the entry the picker now offers as its own model.
    for (const modelBindingId of [undefined, "primaryReasoning"]) {
      const run = await runtime.start(
        { agentName: "provider_agent", modelBindingId, conversationId, message: { text: "Go." } },
        context
      );
      for await (const event of runtime.observe(run.runId, context)) {
        if (event.type === "message_completed") {
          break;
        }
      }
    }

    expect(providerRequests.map((request) => [request.providerId, request.model])).toEqual([
      ["azure-eu", "catalyst-gpt-6.1-sol"],
      ["azure-eu", "catalyst-gpt-6.1-sol"]
    ]);
  });
});
