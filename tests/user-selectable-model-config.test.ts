import { describe, expect, it } from "vitest";
import {
  createSafeConfigView,
  parseClientInstanceConfig
} from "@vivd-catalyst/config-schema";

describe("user-selectable model config", () => {
  it("exposes only explicitly selectable bindings and the agent default", () => {
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
        }
      ],
      skills: []
    });

    expect(safeConfig.selectableModels).toEqual([
      { bindingId: "sol", model: "gpt-5.6-sol", compactThresholdTokens: 270_000 },
      { bindingId: "terra", model: "gpt-5.6-terra", compactThresholdTokens: 270_000 }
    ]);
    expect(safeConfig.agents[0]).toMatchObject({
      name: "assistant",
      defaultModelBindingId: "sol",
      compactThresholdTokens: 270_000
    });
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
