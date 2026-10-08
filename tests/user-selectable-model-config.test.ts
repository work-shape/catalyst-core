import { describe, expect, it } from "vitest";
import { createSafeConfigView, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

const noChoice = { selectableReasoningEfforts: [] };

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
        compactThresholdTokens: 270_000,
        ...noChoice
      },
      { bindingId: "terra", model: "gpt-5.6-terra", compactThresholdTokens: 270_000, ...noChoice }
    ]);
    // An agent on the provider default has no binding id for its own model.
    expect(safeConfig.agents[2]?.selectableModels).toEqual([
      { model: "gpt-5.6-sol", compactThresholdTokens: 270_000, ...noChoice },
      { bindingId: "sol", model: "gpt-5.6-sol", compactThresholdTokens: 270_000, ...noChoice }
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
      modelProviders: [
        {
          id: "azure-eu",
          type: "openai-compatible",
          api: "responses",
          model: "gpt-5.6-sol",
          compliance: { residency: "eu" }
        },
        { id: "global", type: "openai-compatible", model: "claude-opus" }
      ],
      modelBindings: [
        {
          id: "sol",
          providerId: "azure-eu",
          model: "gpt-5.6-sol",
          reasoningEffort: "medium",
          description: { en: "For complex work.", de: "Für komplexe Aufgaben." },
          userSelectableReasoningEfforts: ["high", "low", "medium"]
        },
        { id: "luna", providerId: "azure-eu", model: "gpt-5.6-luna", reasoningEffort: "low" },
        { id: "opus", providerId: "global", vendor: "anthropic", usageTier: "very_high" },
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
        residency: "eu",
        // (3 × 5 + 30) / 4 = 11.25 per million tokens.
        usageTier: "high",
        // The agent's own effort for its own model, offered efforts weakest first.
        reasoningEffort: "high",
        selectableReasoningEfforts: ["low", "medium", "high"]
      },
      {
        bindingId: "luna",
        model: "gpt-5.6-luna",
        residency: "eu",
        usageTier: "low",
        reasoningEffort: "medium",
        ...noChoice
      },
      // Release config overrides the tier its prices would give.
      {
        bindingId: "opus",
        model: "claude-opus",
        vendor: "anthropic",
        usageTier: "very_high",
        ...noChoice
      },
      // No rate card entry and no override: the picker shows no tier.
      { bindingId: "unpriced", model: "gpt-unpriced", residency: "eu", ...noChoice }
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
