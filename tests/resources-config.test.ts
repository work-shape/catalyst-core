import { describe, expect, it } from "vitest";
import { createSafeConfigView, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

describe("resources config", () => {
  it("enables conversation resources by default", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.ui.resources.enabled).toBe(true);
    expect(createSafeConfigView(config, emptyAssets()).features.resources.enabled).toBe(true);
  });

  it("allows a deployment to disable conversation resources explicitly", () => {
    const config = parseClientInstanceConfig(baseConfig({ ui: { resources: { enabled: false } } }));

    expect(config.ui.resources.enabled).toBe(false);
    expect(createSafeConfigView(config, emptyAssets()).features.resources.enabled).toBe(false);
  });
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientInstance: {
      id: "resources-config-test",
      displayName: "Resources Config Test",
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
