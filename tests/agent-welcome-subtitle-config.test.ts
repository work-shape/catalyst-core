import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  agentConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";

describe("agent presentation config", () => {
  it("resolves the optional agent description independently of the welcome subtitle", () => {
    const config = parseClientInstanceConfig(
      baseConfig({ localization: { defaultLocale: "en", supportedLocales: ["en", "de"] } })
    );
    const assets = createAssets({
      description: { en: "Help with documents.", de: "Hilfe bei Unterlagen." },
      welcomeSubtitle: "Welcome!"
    });

    const safeConfig = createSafeConfigView(
      config,
      assets,
      resolveInstanceModules(config, []).snapshot,
      { requestedLocale: "de" }
    );

    expect(safeConfig.agents[0]?.description).toBe("Hilfe bei Unterlagen.");
    expect(safeConfig.agents[0]?.welcomeSubtitle).toBe("Welcome!");
    expect(
      createSafeConfigView(config, createAssets({}), resolveInstanceModules(config, []).snapshot)
        .agents[0]?.description
    ).toBeUndefined();
  });

  it("allows an empty subtitle so deployments can hide the empty-state subline", () => {
    const config = parseClientInstanceConfig(baseConfig());
    const assets = createAssets({
      welcomeMessage: "How can I help?",
      welcomeSubtitle: ""
    });

    const safeConfig = createSafeConfigView(
      config,
      assets,
      resolveInstanceModules(config, []).snapshot,
      { requestedLocale: "en" }
    );

    expect(safeConfig.agents[0]?.welcomeSubtitle).toBe("");
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
        enabled: true,
        user: { permissionRefs: ["demo-tools"] }
      }
    },
    localization: {
      defaultLocale: "en",
      supportedLocales: ["en"]
    },
    infrastructure: { models: { local: { provider: "deterministic", model: "local" } } },
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
