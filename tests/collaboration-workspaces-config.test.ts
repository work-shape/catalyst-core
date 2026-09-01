import { describe, expect, it } from "vitest";
import { createSafeConfigView, parseClientInstanceConfig } from "@vivd-catalyst/config-schema";

describe("Collaboration Workspaces config", () => {
  it("is disabled by default and reports the disabled state in SafeConfig", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.ui.collaborationWorkspaces.enabled).toBe(false);
    expect(
      createSafeConfigView(config, emptyAssets()).features.collaborationWorkspaces.enabled
    ).toBe(false);
  });

  it("reports an explicitly enabled state in SafeConfig", () => {
    const config = parseClientInstanceConfig(
      baseConfig({ ui: { collaborationWorkspaces: { enabled: true } } })
    );

    expect(config.ui.collaborationWorkspaces.enabled).toBe(true);
    expect(
      createSafeConfigView(config, emptyAssets()).features.collaborationWorkspaces.enabled
    ).toBe(true);
  });
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientInstance: {
      id: "collaboration-workspaces-config-test",
      displayName: "Collaboration Workspaces Config Test",
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
