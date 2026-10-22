import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  createSafeConfigView,
  getModelSelectionForAgent,
  parseClientInstanceConfig,
  resolveModelBinding,
  type ClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import { MODEL_USAGE_TIER_BOUNDS, modelUsageTierFromRates } from "@work-shape/catalyst-core";
import { agentModelSelection } from "./support/chat-ui";
import { builtInModelCapabilities } from "./support/model-gateway";

/** The efforts the adapters declare, as the config route reads them from the gateway. */
const adapterEfforts = (config: ClientInstanceConfig) => (bindingId: string) =>
  builtInModelCapabilities(config)({ bindingId }).reasoningEfforts;

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
      },
      resolveInstanceModules(config, []).snapshot,
      { reasoningEffortsOfBinding: adapterEfforts(config) }
    );

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
    // An agent on the provider default that lists a binding for that same model offers it once,
    // as that binding.
    expect(safeConfig.agents[2]?.selectableModels).toEqual([
      {
        bindingId: "sol",
        model: "gpt-5.6-sol",
        region: "global",
        compactThresholdTokens: 270_000,
        ...defaultChoice
      }
    ]);
  });

  it("offers an agent on its provider's own model the binding for that model once, as its own", () => {
    const config = parseClientInstanceConfig({
      version: 1,
      clientInstance: {
        id: "own-binding-test",
        displayName: "Own Binding Test",
        environment: "development"
      },
      infrastructure: {
        models: {
          "azure-eu": {
            provider: "openai-compatible",
            region: "eu",
            api: "responses",
            model: "catalyst-gpt-6.1-sol"
          },
          other: { provider: "openai-compatible", region: "eu", model: "catalyst-gpt-6.1-sol" }
        }
      },
      modelBindings: [
        {
          id: "primaryReasoning",
          providerId: "azure-eu",
          model: "catalyst-gpt-6.1-sol",
          label: "GPT-6.1 Sol",
          vendor: "openai",
          reasoningEffort: "high"
        },
        // The same deployment name on another provider is another model.
        { id: "elsewhere", providerId: "other", label: "Elsewhere" },
        {
          id: "terra",
          providerId: "azure-eu",
          model: "catalyst-gpt-5.6-terra",
          label: "GPT-5.6 Terra",
          vendor: "openai"
        }
      ]
    });
    const agent = (name: string, fields: Record<string, unknown>) => ({
      name,
      displayName: name,
      instructions: "Help the user.",
      modelProviderId: "azure-eu",
      toolNames: [],
      skillNames: [],
      initialPrompts: [],
      ...fields
    });
    const matchedAgent = agent("matched", {
      userSelectableModelBindingIds: ["elsewhere", "terra", "primaryReasoning"]
    });
    const assets = {
      version: 1 as const,
      defaultAgentName: "matched",
      agents: [
        matchedAgent,
        agent("unmatched", { userSelectableModelBindingIds: ["elsewhere", "terra"] }),
        // An effort set for the agent's own model does not keep the raw entry.
        agent("own_effort", {
          reasoningEffort: "low",
          userSelectableModelBindingIds: ["primaryReasoning"]
        })
      ],
      skills: []
    };
    const view = createSafeConfigView(config, assets, resolveInstanceModules(config, []).snapshot, {
      reasoningEffortsOfBinding: adapterEfforts(config)
    });
    const byName = (name: string) => view.agents.find((offered) => offered.name === name);
    const raw = {
      model: "catalyst-gpt-6.1-sol",
      region: "eu",
      ...noChoice
    };
    const elsewhere = {
      bindingId: "elsewhere",
      model: "catalyst-gpt-6.1-sol",
      label: "Elsewhere",
      region: "eu",
      ...defaultChoice
    };
    const terra = {
      bindingId: "terra",
      model: "catalyst-gpt-5.6-terra",
      label: "GPT-5.6 Terra",
      vendor: "openai",
      region: "eu",
      ...defaultChoice
    };
    const primaryReasoning = {
      bindingId: "primaryReasoning",
      model: "catalyst-gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      vendor: "openai",
      region: "eu",
      reasoningEffort: "high",
      selectableReasoningEfforts: ["low", "medium", "high", "xhigh", "max"]
    };

    const matched = byName("matched");
    expect(matched).not.toHaveProperty("defaultModelBindingId");
    expect(matched?.selectableModels).toEqual([primaryReasoning, elsewhere, terra]);
    // It is what a run without a pick uses, and a saved pick of it still finds it.
    expect(agentModelSelection(matched, undefined).selectedModel).toEqual(primaryReasoning);
    expect(agentModelSelection(matched, "primaryReasoning").selectedModel).toEqual(
      primaryReasoning
    );
    // A run started from it names its binding, which runs the agent's own provider and model.
    const runFrom = agentModelSelection(matched, undefined).selectedModel?.bindingId;
    expect(runFrom).toBeDefined();
    const own = getModelSelectionForAgent(config, matchedAgent);
    const started = resolveModelBinding(config, runFrom ?? "");
    expect([started.provider.id, started.model]).toEqual([own.provider.id, own.model]);

    // Without a binding for the same provider and model the own model keeps its raw entry.
    expect(byName("unmatched")?.selectableModels).toEqual([raw, elsewhere, terra]);
    expect(byName("own_effort")?.selectableModels).toEqual([primaryReasoning]);
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
        { id: "unpriced", providerId: "azure-eu", model: "gpt-unpriced" },
        // A deployment name an operator chose, as on Azure, with the name people read.
        {
          id: "deployed",
          providerId: "azure-eu",
          model: "client-gpt-6.1-sol",
          label: "GPT-6.1 Sol",
          vendor: "openai"
        }
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
            userSelectableModelBindingIds: ["luna", "opus", "unpriced", "deployed"],
            modelReasoningEfforts: { luna: "medium" },
            toolNames: [],
            skillNames: [],
            initialPrompts: []
          }
        ],
        skills: []
      },
      resolveInstanceModules(config, []).snapshot,
      { requestedLocale: "de", reasoningEffortsOfBinding: adapterEfforts(config) }
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
        // (3 × 0.2 + 1.6) / 4 = 0.55 per million tokens.
        usageTier: "very_low",
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
      { bindingId: "unpriced", model: "gpt-unpriced", region: "eu", ...defaultChoice },
      {
        bindingId: "deployed",
        model: "client-gpt-6.1-sol",
        label: "GPT-6.1 Sol",
        vendor: "openai",
        region: "eu",
        ...defaultChoice
      }
    ]);
  });

  it("offers a reader who may not write the agent an effort only where its author left it open", () => {
    const config = parseClientInstanceConfig({
      version: 1,
      clientInstance: {
        id: "effort-choice-test",
        displayName: "Effort",
        environment: "development"
      },
      infrastructure: {
        models: {
          openai: { provider: "openai-compatible", region: "global", model: "gpt-5.6-sol" }
        }
      },
      modelBindings: [
        { id: "sol", providerId: "openai", model: "gpt-5.6-sol" },
        { id: "luna", providerId: "openai", model: "gpt-5.6-luna" },
        { id: "terra", providerId: "openai", model: "gpt-5.6-terra" }
      ]
    });
    const agent = (name: string, fields: Record<string, unknown>) => ({
      name,
      displayName: name,
      instructions: "Help the user.",
      modelBindingId: "sol",
      toolNames: [],
      skillNames: [],
      initialPrompts: [],
      ...fields
    });
    const assets = {
      version: 1,
      agents: [
        agent("set", { reasoningEffort: "high" }),
        agent("open", {}),
        agent("models", {
          reasoningEffort: "high",
          userSelectableModelBindingIds: ["luna", "terra"],
          modelReasoningEfforts: { luna: "low" }
        })
      ],
      skills: []
    };
    const view = (mayWriteAgent?: (agentName: string) => boolean) =>
      createSafeConfigView(config, assets, resolveInstanceModules(config, []).snapshot, {
        reasoningEffortsOfBinding: adapterEfforts(config),
        ...(mayWriteAgent === undefined ? {} : { mayWriteAgent })
      }).agents.map((offered) =>
        offered.selectableModels.map((model) => model.selectableReasoningEfforts.length)
      );
    const all = defaultChoice.selectableReasoningEfforts.length;

    // A member: the effort the author set is no choice, one left open is, and a second model
    // is a choice by itself.
    expect(view(() => false)).toEqual([[0], [all], [0, 0, all]]);
    // Whoever may write the agent is offered what the bindings allow, as is every reader of a
    // view that names no reader.
    expect(view((agentName) => agentName === "set")).toEqual([[all], [all], [0, 0, all]]);
    expect(view()).toEqual([[all], [all], [all, all, all]]);
  });

  it("derives one of six usage tiers from the blended price, on bounds that double", () => {
    // Input and output at the same price blend to that price.
    const tierAt = (price: number) =>
      modelUsageTierFromRates({
        uncachedInputPricePerMillionTokens: price,
        outputPricePerMillionTokens: price
      });

    expect(MODEL_USAGE_TIER_BOUNDS).toEqual([1.25, 2.5, 5, 10, 20]);
    // A price on a bound belongs to the tier above it.
    expect([0, 1.24, 1.25, 2.49, 2.5, 4.99, 5, 9.99, 10, 19.99, 20, 400].map(tierAt)).toEqual([
      "very_low",
      "very_low",
      "low",
      "low",
      "moderate",
      "moderate",
      "elevated",
      "elevated",
      "high",
      "high",
      "very_high",
      "very_high"
    ]);
    // Three parts input to one part output: (3 × 2 + 14) / 4 = 5.
    expect(
      modelUsageTierFromRates({
        uncachedInputPricePerMillionTokens: 2,
        outputPricePerMillionTokens: 14
      })
    ).toBe("elevated");
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
