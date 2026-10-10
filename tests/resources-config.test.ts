import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import {
  createSafeConfigView,
  parseClientInstanceConfig,
  resolveModuleSwitches
} from "@vivd-catalyst/config-schema";

describe("resources config", () => {
  it("enables conversation resources by default", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(resolveModuleSwitches(config).resources).toEqual({ enabled: true });
    expect(
      createSafeConfigView(config, emptyAssets(), resolveInstanceModules(config).snapshot).features
        .resources.enabled
    ).toBe(true);
  });

  it("allows a deployment to disable conversation resources explicitly", () => {
    const config = parseClientInstanceConfig(baseConfig({ ui: { resources: { enabled: false } } }));

    expect(resolveModuleSwitches(config).resources).toEqual({ enabled: false });
    expect(
      createSafeConfigView(config, emptyAssets(), resolveInstanceModules(config).snapshot).features
        .resources.enabled
    ).toBe(false);
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
