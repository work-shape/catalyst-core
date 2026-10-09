import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AppError } from "@vivd-catalyst/core";
import {
  createClientBranding,
  createSafeConfigView,
  loadClientInstanceConfigFromFile
} from "@vivd-catalyst/config-schema";

const baseConfig = [
  "version: 1",
  "clientInstance:",
  "  id: base-client",
  "  displayName: Base Client",
  "  environment: development",
  "localization:",
  "  defaultLocale: de",
  "  supportedLocales:",
  "    - de",
  "    - en",
  "retention:",
  "  conversationDays: 30",
  "  auditDays: 365",
  "  allowUserDelete: true",
  "infrastructure:",
  "  models:",
  "    local:",
  "      provider: deterministic",
  ""
].join("\n");

async function writeFixtures(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-extends-"));
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(root, name), contents, "utf8");
  }
  return root;
}

describe("config file extends", () => {
  it("deep-merges objects with the extending file winning and replaces arrays wholesale", async () => {
    const root = await writeFixtures({
      "app.base.yaml": baseConfig,
      "app.staging.yaml": [
        "extends: ./app.base.yaml",
        "clientInstance:",
        "  id: staging-client",
        "  environment: staging",
        "localization:",
        "  supportedLocales:",
        "    - de",
        "retention:",
        "  conversationDays: 7",
        ""
      ].join("\n")
    });

    const config = await loadClientInstanceConfigFromFile(join(root, "app.staging.yaml"));
    // overridden scalars win, untouched sibling keys survive the merge
    expect(config.clientInstance).toEqual({
      id: "staging-client",
      displayName: "Base Client",
      environment: "staging"
    });
    // arrays replace, they do not concatenate
    expect(config.localization.supportedLocales).toEqual(["de"]);
    expect(config.localization.defaultLocale).toBe("de");
    // nested partial override keeps the base's other fields
    expect(config.retention.conversationDays).toBe(7);
    expect(config.retention.auditDays).toBe(365);
  });

  it("resolves extends chains recursively", async () => {
    const root = await writeFixtures({
      "app.base.yaml": baseConfig,
      "app.env.yaml": [
        "extends: ./app.base.yaml",
        "clientInstance:",
        "  environment: staging",
        ""
      ].join("\n"),
      "app.yaml": ["extends: ./app.env.yaml", "clientInstance:", "  id: leaf-client", ""].join("\n")
    });

    const config = await loadClientInstanceConfigFromFile(join(root, "app.yaml"));
    expect(config.clientInstance.id).toBe("leaf-client");
    expect(config.clientInstance.environment).toBe("staging");
    expect(config.clientInstance.displayName).toBe("Base Client");
  });

  it("deep-merges inline UI over a UI file before applying defaults", async () => {
    const root = await writeFixtures({
      "ui.yaml": ["title: File title", "showAgentName: false", 'accentColor: "#111111"', ""].join(
        "\n"
      ),
      "app.yaml": [
        baseConfig,
        "uiFile: ./ui.yaml",
        "ui:",
        "  title: Overlay title",
        "  resources:",
        "    enabled: false",
        ""
      ].join("\n")
    });

    const config = await loadClientInstanceConfigFromFile(join(root, "app.yaml"));
    expect(config.ui.title).toBe("Overlay title");
    expect(config.ui.showAgentName).toBe(false);
    expect(config.ui.accentColor).toBe("#111111");
    expect(config.ui.resources.enabled).toBe(false);
    expect(config.ui.defaultThemeMode).toBe("system");
  });

  it("loads UI from a file without an inline overlay", async () => {
    const root = await writeFixtures({
      "ui.yaml": ["welcomeMessage: File welcome", "showAgentName: false", ""].join("\n"),
      "app.yaml": `${baseConfig}uiFile: ./ui.yaml\n`
    });

    const config = await loadClientInstanceConfigFromFile(join(root, "app.yaml"));
    expect(config.ui.welcomeMessage).toBe("File welcome");
    expect(config.ui.showAgentName).toBe(false);
    expect(config.ui.defaultThemeMode).toBe("system");
  });

  it("loads inline UI without a UI file", async () => {
    const root = await writeFixtures({
      "app.yaml": [baseConfig, "ui:", "  title: Inline title", "  showAgentName: false", ""].join(
        "\n"
      )
    });

    const config = await loadClientInstanceConfigFromFile(join(root, "app.yaml"));
    expect(config.ui.title).toBe("Inline title");
    expect(config.ui.showAgentName).toBe(false);
    expect(config.ui.defaultThemeMode).toBe("system");
  });

  it("serves the agent's name as on and the agent descriptions as off unless YAML says otherwise", async () => {
    const root = await writeFixtures({
      "defaults.yaml": baseConfig,
      "descriptions.yaml": [baseConfig, "ui:", "  showAgentDescriptions: true", ""].join("\n"),
      "name.yaml": [baseConfig, "ui:", "  showAgentName: false", ""].join("\n")
    });
    // What the config endpoint hands the chat, and the branding it is built from.
    const settings = async (file: string) => {
      const config = await loadClientInstanceConfigFromFile(join(root, file));
      const { showAgentName, showAgentDescriptions } = createSafeConfigView(config, {
        version: 1,
        defaultAgentName: "none",
        agents: [],
        skills: []
      }).ui;
      const branding = createClientBranding(config);
      expect(branding.showAgentName).toBe(showAgentName);
      expect(branding.showAgentDescriptions).toBe(showAgentDescriptions);
      return { showAgentName, showAgentDescriptions };
    };

    expect(await settings("defaults.yaml")).toEqual({
      showAgentName: true,
      showAgentDescriptions: false
    });
    expect(await settings("descriptions.yaml")).toEqual({
      showAgentName: true,
      showAgentDescriptions: true
    });
    expect(await settings("name.yaml")).toEqual({
      showAgentName: false,
      showAgentDescriptions: false
    });
  });

  it("rejects unknown inline UI overlay keys", async () => {
    const root = await writeFixtures({
      "ui.yaml": "title: File title\n",
      "app.yaml": [
        baseConfig,
        "uiFile: ./ui.yaml",
        "ui:",
        "  resorces:",
        "    enabled: true",
        "  resources:",
        "    enabld: true",
        ""
      ].join("\n")
    });

    try {
      await loadClientInstanceConfigFromFile(join(root, "app.yaml"));
      throw new Error("Expected the unknown UI overlay key to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) {
        throw error;
      }
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(error.details)).toContain("resorces");
      expect(JSON.stringify(error.details)).toContain("enabld");
    }
  });

  it("applies inline UI from an extending file over the base UI file", async () => {
    const root = await writeFixtures({
      "ui.yaml": ["clientName: Base Co", "title: Shared title", ""].join("\n"),
      "app.base.yaml": `${baseConfig}uiFile: ./ui.yaml\n`,
      "app.yaml": [
        "extends: ./app.base.yaml",
        "ui:",
        "  resources:",
        "    enabled: false",
        ""
      ].join("\n")
    });

    const config = await loadClientInstanceConfigFromFile(join(root, "app.yaml"));
    expect(config.ui.clientName).toBe("Base Co");
    expect(config.ui.title).toBe("Shared title");
    expect(config.ui.resources.enabled).toBe(false);
  });

  it("replaces a base object with a non-record override instead of silently keeping it", async () => {
    const root = await writeFixtures({
      "app.base.yaml": baseConfig.replace("conversationDays: 30", "conversationDays: 7"),
      // unquoted YAML timestamp parses as a Date, not a mergeable record
      "app.yaml": ["extends: ./app.base.yaml", "retention: 2025-01-01", ""].join("\n")
    });

    // The Date replaces the base's retention object entirely; none of the
    // base's values leak through the merge. (The schema then treats the Date
    // as an empty object and applies defaults — pre-existing zod behavior
    // that applies equally to non-extends config files.)
    const config = await loadClientInstanceConfigFromFile(join(root, "app.yaml"));
    expect(config.retention.conversationDays).toBe(30);
  });

  it("rejects extends cycles with a clear error", async () => {
    const root = await writeFixtures({
      "a.yaml": "extends: ./b.yaml\n",
      "b.yaml": "extends: ./a.yaml\n"
    });

    await expect(loadClientInstanceConfigFromFile(join(root, "a.yaml"))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("cycle")
    });
  });

  it("rejects a non-string extends value", async () => {
    const root = await writeFixtures({
      "app.yaml": ["extends:", "  - ./app.base.yaml", ""].join("\n")
    });

    await expect(loadClientInstanceConfigFromFile(join(root, "app.yaml"))).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: expect.stringContaining("extends")
    });
  });

  it("reports a missing extended file", async () => {
    const root = await writeFixtures({
      "app.yaml": "extends: ./missing.yaml\n"
    });

    await expect(loadClientInstanceConfigFromFile(join(root, "app.yaml"))).rejects.toThrowError(
      /missing\.yaml/
    );
  });

  it("still rejects moved asset keys when they come from the extended base", async () => {
    const root = await writeFixtures({
      "app.base.yaml": `${baseConfig}defaultAgentName: someone\n`,
      "app.yaml": "extends: ./app.base.yaml\n"
    });

    try {
      await loadClientInstanceConfigFromFile(join(root, "app.yaml"));
      throw new Error("Expected moved asset keys from the base file to be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) {
        throw error;
      }
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(JSON.stringify(error.details)).toContain("catalyst config push");
    }
  });
});
