import { describe, expect, it } from "vitest";
import {
  agentConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig
} from "@vivd-catalyst/config-schema";

describe("agent welcome subtitle config", () => {
  it("allows an empty subtitle so deployments can hide the empty-state subline", () => {
    const config = parseClientInstanceConfig(baseConfig());
    const assets = createAssets({
      welcomeMessage: "How can I help?",
      welcomeSubtitle: ""
    });

    const safeConfig = createSafeConfigView(config, assets, { requestedLocale: "en" });

    expect(safeConfig.agents[0]?.welcomeSubtitle).toBe("");
  });

  it("resolves a localized subtitle when one is configured", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        localization: {
          defaultLocale: "en",
          supportedLocales: ["en", "de"]
        }
      })
    );
    const assets = createAssets({
      welcomeMessage: "How can I help?",
      welcomeSubtitle: {
        en: "Ready for this conversation.",
        de: "Bereit fuer diese Unterhaltung."
      }
    });

    const safeConfig = createSafeConfigView(config, assets, { requestedLocale: "de" });

    expect(safeConfig.agents[0]?.welcomeSubtitle).toBe("Bereit fuer diese Unterhaltung.");
  });
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientInstance: {
      id: "config-test",
      displayName: "Config Test",
      environment: "development"
    },
    auth: {
      development: {
        enabled: true
      }
    },
    localization: {
      defaultLocale: "en",
      supportedLocales: ["en"]
    },
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    ...overrides
  };
}

function createAssets(overrides: Record<string, unknown>) {
  return {
    version: 1,
    defaultAgentName: "test_agent",
    agents: [
      agentConfigSchema.parse({
        name: "test_agent",
        displayName: "Test Agent",
        instructions: "Test.",
        ...overrides
      })
    ],
    skills: []
  };
}
