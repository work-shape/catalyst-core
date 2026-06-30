import { describe, expect, it } from "vitest";
import { createSafeConfigView, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

describe("agent welcome subtitle config", () => {
  it("allows an empty subtitle so deployments can hide the empty-state subline", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        agents: [
          {
            name: "test_agent",
            displayName: "Test Agent",
            welcomeMessage: "How can I help?",
            welcomeSubtitle: "",
            instructions: "Test."
          }
        ]
      })
    );

    const safeConfig = createSafeConfigView(config, { requestedLocale: "en" });

    expect(safeConfig.agents[0]?.welcomeSubtitle).toBe("");
  });

  it("resolves a localized subtitle when one is configured", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        localization: {
          defaultLocale: "en",
          supportedLocales: ["en", "de"]
        },
        agents: [
          {
            name: "test_agent",
            displayName: "Test Agent",
            welcomeMessage: "How can I help?",
            welcomeSubtitle: {
              en: "Ready for this conversation.",
              de: "Bereit fuer diese Unterhaltung."
            },
            instructions: "Test."
          }
        ]
      })
    );

    const safeConfig = createSafeConfigView(config, { requestedLocale: "de" });

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
    defaultAgentName: "test_agent",
    agents: [
      {
        name: "test_agent",
        displayName: "Test Agent",
        instructions: "Test."
      }
    ],
    modelProviders: [{ id: "local", type: "deterministic", model: "local" }],
    ...overrides
  };
}
