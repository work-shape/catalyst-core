import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import {
  createSafeConfigView,
  loadClientInstanceConfigFromFile,
  parseClientInstanceConfig
} from "@vivd-catalyst/config-schema";

const REMOVED_SWITCH_MESSAGE =
  /'ui\.collaborationWorkspaces' was removed.*Remove the key from the config/u;

describe("removed workspace switch", () => {
  it("loads a config without the key and emits no workspace feature in SafeConfig", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.ui).not.toHaveProperty("collaborationWorkspaces");
    expect(
      createSafeConfigView(config, emptyAssets(), resolveInstanceModules(config, []).snapshot)
        .features
    ).not.toHaveProperty("collaborationWorkspaces");
  });

  it("loads a legacy config that still turns workspaces on, and drops the key", () => {
    const config = parseClientInstanceConfig(
      baseConfig({ ui: { title: "Kept", collaborationWorkspaces: { enabled: true } } })
    );

    expect(config.ui.title).toBe("Kept");
    expect(config.ui).not.toHaveProperty("collaborationWorkspaces");
  });

  it.each([
    ["enabled: false", { enabled: false }],
    ["an empty object, which used to mean off", {}],
    ["a value that is no switch", true]
  ])("refuses %s and says to remove the key", (_name, value) => {
    expect(() =>
      parseClientInstanceConfig(baseConfig({ ui: { collaborationWorkspaces: value } }))
    ).toThrowError(REMOVED_SWITCH_MESSAGE);
  });
});

/**
 * The shape the Musterbau configs have until their overlays are cleaned up: the base file
 * names a shared UI file, and the environment file extends it with an inline `ui` that holds
 * nothing but the removed switch.
 */
describe("removed workspace switch in config files", () => {
  const baseFile = [
    "version: 1",
    "clientInstance:",
    "  id: workspace-switch-file-test",
    "  displayName: Workspace Switch File Test",
    "  environment: development",
    "localization:",
    "  defaultLocale: de",
    "  supportedLocales:",
    "    - de",
    "infrastructure:",
    "  models:",
    "    local:",
    "      provider: deterministic",
    "uiFile: ./ui.yaml",
    ""
  ].join("\n");
  const uiFile = ["clientName: Base Co", "title: Shared title", ""].join("\n");

  function environmentFile(enabled: boolean): string {
    return [
      "extends: ./app.operated.yaml",
      "ui:",
      "  collaborationWorkspaces:",
      `    enabled: ${String(enabled)}`,
      ""
    ].join("\n");
  }

  async function writeFixtures(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-workspace-switch-"));
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(root, name), contents, "utf8");
    }
    return root;
  }

  it("loads an environment file whose overlay still turns workspaces on", async () => {
    const root = await writeFixtures({
      "ui.yaml": uiFile,
      "app.base.yaml": baseFile,
      "app.operated.yaml": "extends: ./app.base.yaml\n",
      "app.production.yaml": environmentFile(true)
    });

    const config = await loadClientInstanceConfigFromFile(join(root, "app.production.yaml"));

    expect(config.ui.clientName).toBe("Base Co");
    expect(config.ui.title).toBe("Shared title");
    expect(config.ui).not.toHaveProperty("collaborationWorkspaces");
  });

  it("refuses an environment file whose overlay turns workspaces off", async () => {
    const root = await writeFixtures({
      "ui.yaml": uiFile,
      "app.base.yaml": baseFile,
      "app.operated.yaml": "extends: ./app.base.yaml\n",
      "app.production.yaml": environmentFile(false)
    });

    await expect(
      loadClientInstanceConfigFromFile(join(root, "app.production.yaml"))
    ).rejects.toThrowError(REMOVED_SWITCH_MESSAGE);
  });

  it("applies the same rule to the shared UI file", async () => {
    const withSwitch = (enabled: boolean) =>
      writeFixtures({
        "ui.yaml": `${uiFile}collaborationWorkspaces:\n  enabled: ${String(enabled)}\n`,
        "app.yaml": baseFile
      });

    const config = await loadClientInstanceConfigFromFile(join(await withSwitch(true), "app.yaml"));
    expect(config.ui.title).toBe("Shared title");
    expect(config.ui).not.toHaveProperty("collaborationWorkspaces");

    await expect(
      loadClientInstanceConfigFromFile(join(await withSwitch(false), "app.yaml"))
    ).rejects.toThrowError(REMOVED_SWITCH_MESSAGE);
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
