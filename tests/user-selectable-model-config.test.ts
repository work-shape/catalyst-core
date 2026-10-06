import { describe, expect, it } from "vitest";
import { createSafeConfigView, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

describe("user-selectable model config", () => {
  it("offers each agent its own model plus its listed user-selectable bindings", () => {
    const config = parseClientInstanceConfig({
      version: 1,
      clientInstance: {
        id: "selectable-model-test",
        displayName: "Selectable Model Test",
        environment: "development"
      },
      modelProviders: [
        {
          id: "openai",
          type: "openai-compatible",
          api: "responses",
          model: "gpt-5.6-sol",
          baseUrl: "https://api.openai.com/v1",
          apiKeyEnvName: "OPENAI_API_KEY",
          contextManagement: {
            compaction: {
              compactThresholdTokens: 270_000
            }
          }
        }
      ],
      modelBindings: [
        {
          id: "sol",
          providerId: "openai",
          model: "gpt-5.6-sol",
          userSelectable: true
        },
        {
          id: "terra",
          providerId: "openai",
          model: "gpt-5.6-terra",
          userSelectable: true
        },
        {
          id: "conversationTitle",
          providerId: "openai",
          model: "gpt-5.6-luna",
          agentSelectable: false
        }
      ]
    });

    const safeConfig = createSafeConfigView(config, {
      version: 1,
      defaultAgentName: "assistant",
      agents: [
        {
          name: "assistant",
          displayName: "Assistant",
          instructions: "Help the user.",
          modelBindingId: "sol",
          toolNames: [],
          skillNames: [],
          initialPrompts: []
        },
        {
          name: "chooser",
          displayName: "Chooser",
          instructions: "Help the user.",
          // The title binding is not userSelectable and "retired" no longer exists: both are
          // ignored. Listing the agent's own binding does not duplicate it.
          modelBindingId: "conversationTitle",
          userSelectableModelBindingIds: ["terra", "conversationTitle", "retired"],
          toolNames: [],
          skillNames: [],
          initialPrompts: []
        },
        {
          name: "provider_default",
          displayName: "Provider default",
          instructions: "Help the user.",
          userSelectableModelBindingIds: ["sol"],
          toolNames: [],
          skillNames: [],
          initialPrompts: []
        }
      ],
      skills: []
    });

    expect(safeConfig.selectableModels).toEqual([
      { bindingId: "sol", model: "gpt-5.6-sol", compactThresholdTokens: 270_000 },
      { bindingId: "terra", model: "gpt-5.6-terra", compactThresholdTokens: 270_000 }
    ]);
    // An empty list leaves only the agent's own model, so the chat shows no selector.
    expect(safeConfig.agents[0]).toMatchObject({
      name: "assistant",
      defaultModelBindingId: "sol",
      compactThresholdTokens: 270_000,
      selectableModels: [
        { bindingId: "sol", model: "gpt-5.6-sol", compactThresholdTokens: 270_000 }
      ]
    });
    expect(safeConfig.agents[1]?.selectableModels).toEqual([
      { bindingId: "conversationTitle", model: "gpt-5.6-luna", compactThresholdTokens: 270_000 },
      { bindingId: "terra", model: "gpt-5.6-terra", compactThresholdTokens: 270_000 }
    ]);
    // An agent on the provider default has no binding id for its own model.
    expect(safeConfig.agents[2]?.selectableModels).toEqual([
      { model: "gpt-5.6-sol", compactThresholdTokens: 270_000 },
      { bindingId: "sol", model: "gpt-5.6-sol", compactThresholdTokens: 270_000 }
    ]);
    expect(config.modelBindings[2]?.userSelectable).toBe(false);
  });

  it("rejects provider compaction for chat completions", () => {
    expect(() =>
      parseClientInstanceConfig({
        version: 1,
        clientInstance: {
          id: "invalid-compaction-test",
          displayName: "Invalid Compaction Test",
          environment: "development"
        },
        modelProviders: [
          {
            id: "openai",
            type: "openai-compatible",
            api: "chat_completions",
            model: "gpt-test",
            contextManagement: {
              compaction: {
                compactThresholdTokens: 270_000
              }
            }
          }
        ]
      })
    ).toThrow(/requires api: responses/u);
  });
});
