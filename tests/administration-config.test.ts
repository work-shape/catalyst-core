import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import {
  createSafeConfigView,
  parseClientInstanceConfig,
  resolveModuleSwitches
} from "@vivd-catalyst/config-schema";

describe("administration config", () => {
  it("keeps config asset management disabled by default", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(resolveModuleSwitches(config).assetManagement).toEqual({ enabled: false });
    expect(config.administration.agentConfiguration.editableAgentFields).toEqual([]);
    expect(
      createSafeConfigView(config, emptyAssets(), resolveInstanceModules(config).snapshot).features
        .configAssets
    ).toEqual({
      enabled: false,
      editableAgentFields: [],
      allowAgentCreation: false,
      allowAgentDeletion: false,
      allowDefaultAgentChange: false,
      allowSkillEditing: false,
      agentSkillChanges: { enabled: false, allowSkillCreation: false }
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

    expect(resolveModuleSwitches(config).assetManagement).toEqual({ enabled: true });
    expect(
      createSafeConfigView(config, emptyAssets(), resolveInstanceModules(config).snapshot).features
        .configAssets
    ).toEqual({
      enabled: true,
      editableAgentFields: ["modelBindingId", "reasoningEffort"],
      allowAgentCreation: true,
      allowAgentDeletion: false,
      allowDefaultAgentChange: false,
      allowSkillEditing: false,
      agentSkillChanges: { enabled: false, allowSkillCreation: false }
    });
  });

  it("fails assembly validation when a fast-mode binding has no fast rates", () => {
    const fastConfig = (fast: boolean, withRateCard = true) =>
      baseConfig({
        modelBindings: [
          { id: "plain", providerId: "local" },
          { id: "fast", providerId: "local", supportsFastMode: true }
        ],
        ...(withRateCard
          ? {
              usage: {
                costs: {
                  customer: {
                    id: "customer",
                    version: "1",
                    currency: "EUR",
                    models: [
                      {
                        providerId: "local",
                        model: "local",
                        uncachedInputPricePerMillionTokens: 1,
                        cachedInputPricePerMillionTokens: 1,
                        outputPricePerMillionTokens: 2,
                        ...(fast
                          ? {
                              fast: {
                                uncachedInputPricePerMillionTokens: 2,
                                cachedInputPricePerMillionTokens: 2,
                                outputPricePerMillionTokens: 4
                              }
                            }
                          : {})
                      }
                    ]
                  }
                }
              }
            }
          : {})
      });

    expect(() => parseClientInstanceConfig(fastConfig(false))).toThrow(
      "Model binding 'fast' declares supportsFastMode, but the customer rate card has no fast rates for model local/local"
    );
    expect(() => parseClientInstanceConfig(fastConfig(false, false))).toThrow(
      "declares supportsFastMode"
    );
    const config = parseClientInstanceConfig(fastConfig(true));
    expect(config.modelBindings.map((binding) => binding.supportsFastMode)).toEqual([false, true]);
    expect(config.usage.costs.customer?.models[0]?.fast?.outputPricePerMillionTokens).toBe(4);
  });

  it("rejects legacy provider editing as an interactive policy", () => {
    expect(() =>
      parseClientInstanceConfig(
        baseConfig({
          administration: {
            agentConfiguration: {
              enabled: true,
              editableAgentFields: ["modelProviderId"]
            }
          }
        })
      )
    ).toThrow();
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
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
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
