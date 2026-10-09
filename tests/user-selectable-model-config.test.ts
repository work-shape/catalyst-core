import { describe, expect, it } from "vitest";
import { createSafeConfigView, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

const noChoice = { selectableReasoningEfforts: [] };
// What a binding offers when release config does not say, starting on an assumed medium.
const defaultChoice = {
  reasoningEffort: "medium",
  selectableReasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
};

describe("user-selectable model config", () => {
  it("offers each agent its own model plus its listed user-selectable bindings", () => {
    const config = parseClientInstanceConfig({
      version: 1,
      clientInstance: {
        id: "selectable-model-test",
        displayName: "Selectable Model Test",
        environment: "development"
      },
      infrastructure: {
        models: {
          openai: {
            provider: "openai-compatible",
            region: "global",
            api: "responses",
            model: "gpt-5.6-sol",
            baseUrl: "https://api.openai.com/v1",
            credentialSecret: "OPENAI_API_KEY",
            contextManagement: {
              compaction: {
                compactThresholdTokens: 270_000
              }
            }
          }
        }
      },
      modelBindings: [
        {
          id: "sol",
          providerId: "openai",
          model: "gpt-5.6-sol",
          // Still accepted, without effect: agents offer bindings with or without it.
          userSelectable: true
        },
        {
          id: "terra",
          providerId: "openai",
          model: "gpt-5.6-terra"
        },
        {
          id: "guard",
          providerId: "openai",
          model: "gpt-5-nano",
          agentSelectable: false
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
          // "retired" no longer exists and agents may not use "guard": both are ignored.
          // Listing the agent's own binding does not duplicate it.
          modelBindingId: "conversationTitle",
          userSelectableModelBindingIds: ["terra", "conversationTitle", "retired", "guard"],
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

    expect(safeConfig).not.toHaveProperty("selectableModels");
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
      {
        bindingId: "conversationTitle",
        model: "gpt-5.6-luna",
        region: "global",
        compactThresholdTokens: 270_000,
        ...defaultChoice
      },
      {
        bindingId: "terra",
        model: "gpt-5.6-terra",
        region: "global",
        compactThresholdTokens: 270_000,
        ...defaultChoice
      }
    ]);
    // An agent on the provider default has no binding for its own model: no id, and no choice
    // of effort.
    expect(safeConfig.agents[2]?.selectableModels).toEqual([
      { model: "gpt-5.6-sol", region: "global", compactThresholdTokens: 270_000, ...noChoice },
      {
        bindingId: "sol",
        model: "gpt-5.6-sol",
        region: "global",
        compactThresholdTokens: 270_000,
        ...defaultChoice
      }
    ]);
  });

  it("describes each offered model for the model picker", () => {
    const config = parseClientInstanceConfig({
      version: 1,
      clientInstance: {
        id: "model-picker-test",
        displayName: "Model Picker Test",
        environment: "development"
      },
      localization: { defaultLocale: "en", supportedLocales: ["en", "de"] },
      infrastructure: {
        models: {
          "azure-eu": {
            provider: "openai-compatible",
            region: "eu",
            api: "responses",
            model: "gpt-5.6-sol"
          },
          global: { provider: "openai-compatible", region: "global", model: "claude-opus" }
        }
      },
      modelBindings: [
        {
          id: "sol",
          providerId: "azure-eu",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          description: { en: "For complex work.", de: "Für komplexe Aufgaben." },
          userSelectableReasoningEfforts: ["xhigh", "low"]
        },
        { id: "luna", providerId: "azure-eu", model: "gpt-5.6-luna", reasoningEffort: "low" },
        {
          id: "opus",
          providerId: "global",
          vendor: "anthropic",
          usageTier: "very_high",
          userSelectableReasoningEfforts: []
        },
        { id: "unpriced", providerId: "azure-eu", model: "gpt-unpriced" }
      ],
      usage: {
        costs: {
          customer: {
            id: "test",
            version: "1",
            currency: "EUR",
            models: [
              {
                providerId: "azure-eu",
                model: "gpt-5.6-sol",
                uncachedInputPricePerMillionTokens: 5,
                cachedInputPricePerMillionTokens: 0.5,
                outputPricePerMillionTokens: 30
              },
              {
                providerId: "azure-eu",
                model: "gpt-5.6-luna",
                uncachedInputPricePerMillionTokens: 0.2,
                cachedInputPricePerMillionTokens: 0.02,
                outputPricePerMillionTokens: 1.6
              },
              {
                providerId: "global",
                model: "claude-opus",
                uncachedInputPricePerMillionTokens: 1,
                cachedInputPricePerMillionTokens: 0.1,
                outputPricePerMillionTokens: 2
              }
            ]
          }
        }
      }
    });

    const safeConfig = createSafeConfigView(
      config,
      {
        version: 1,
        defaultAgentName: "assistant",
        agents: [
          {
            name: "assistant",
            displayName: "Assistant",
            instructions: "Help the user.",
            modelBindingId: "sol",
            reasoningEffort: "high",
            userSelectableModelBindingIds: ["luna", "opus", "unpriced"],
            modelReasoningEfforts: { luna: "medium" },
            toolNames: [],
            skillNames: [],
            initialPrompts: []
          }
        ],
        skills: []
      },
      { requestedLocale: "de" }
    );

    expect(safeConfig.agents[0]?.selectableModels).toEqual([
      {
        bindingId: "sol",
        model: "gpt-5.6-sol",
        description: "Für komplexe Aufgaben.",
        region: "eu",
        // (3 × 5 + 30) / 4 = 11.25 per million tokens.
        usageTier: "high",
        // The agent's own effort for its own model joins the efforts the binding lists, weakest
        // first.
        reasoningEffort: "high",
        selectableReasoningEfforts: ["low", "high", "xhigh"]
      },
      {
        bindingId: "luna",
        model: "gpt-5.6-luna",
        region: "eu",
        usageTier: "low",
        // The effort the agent sets for this model, among the efforts offered by default.
        reasoningEffort: "medium",
        selectableReasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
      },
      // Release config overrides the tier its prices would give, and an empty list of efforts
      // leaves users no choice.
      {
        bindingId: "opus",
        model: "claude-opus",
        region: "global",
        vendor: "anthropic",
        usageTier: "very_high",
        ...noChoice
      },
      // No rate card entry and no override: the picker shows no tier.
      { bindingId: "unpriced", model: "gpt-unpriced", region: "eu", ...defaultChoice }
    ]);
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
        infrastructure: {
          models: {
            openai: {
              provider: "openai-compatible",
              region: "global",
              api: "chat_completions",
              model: "gpt-test",
              contextManagement: {
                compaction: {
                  compactThresholdTokens: 270_000
                }
              }
            }
          }
        }
      })
    ).toThrow(/requires api: responses/u);
  });
});
