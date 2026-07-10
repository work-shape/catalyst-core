import { describe, expect, it } from "vitest";
import {
  createSafeConfigView,
  parseClientInstanceConfig
} from "@vivd-catalyst/config-schema";

describe("administration config", () => {
  it("keeps config asset management disabled by default", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.administration.configAssets.enabled).toBe(false);
    expect(config.administration.configAssets.editableAgentFields).toEqual({
      model: false,
      maxSteps: false
    });
    expect(createSafeConfigView(config, emptyAssets()).features.configAssets).toEqual({
      enabled: false,
      editableAgentFields: { model: false, maxSteps: false }
    });
  });

  it("exposes an explicitly enabled config asset management feature", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        administration: {
          configAssets: {
            enabled: true,
            editableAgentFields: { model: true, maxSteps: false }
          }
        }
      })
    );

    expect(config.administration.configAssets.enabled).toBe(true);
    expect(createSafeConfigView(config, emptyAssets()).features.configAssets).toEqual({
      enabled: true,
      editableAgentFields: { model: true, maxSteps: false }
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
