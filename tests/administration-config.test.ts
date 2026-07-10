import { describe, expect, it } from "vitest";
import {
  createSafeConfigView,
  parseClientInstanceConfig
} from "@vivd-catalyst/config-schema";

describe("administration config", () => {
  it("keeps config asset management disabled by default", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.administration.agentConfiguration.enabled).toBe(false);
    expect(config.administration.agentConfiguration.editableAgentFields).toEqual([]);
    expect(createSafeConfigView(config, emptyAssets()).features.configAssets).toEqual({
      enabled: false,
      editableAgentFields: [],
      allowAgentCreation: false,
      allowAgentDeletion: false,
      allowDefaultAgentChange: false,
      allowSkillEditing: false
    });
  });

  it("exposes an explicitly enabled config asset management feature", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        administration: {
          agentConfiguration: {
            enabled: true,
            editableAgentFields: ["modelBindingId", "reasoningEffort"],
            allowAgentCreation: true
          }
        }
      })
    );

    expect(config.administration.agentConfiguration.enabled).toBe(true);
    expect(createSafeConfigView(config, emptyAssets()).features.configAssets).toEqual({
      enabled: true,
      editableAgentFields: ["modelBindingId", "reasoningEffort"],
      allowAgentCreation: true,
      allowAgentDeletion: false,
      allowDefaultAgentChange: false,
      allowSkillEditing: false
    });
  });
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientInstance: {
      id: "administration-config-test",
      displayName: "Administration Config Test",
      environment: "development"
    },
    localization: {
      defaultLocale: "en",
      supportedLocales: ["en"]
    },
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    ...overrides
  };
}

function emptyAssets() {
  return {
    version: 0,
    agents: [],
    skills: []
  };
}
