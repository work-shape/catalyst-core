import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { vivdCatalystChatUiPlugin } from "@vivd-catalyst/chat-ui/vite";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
  cleanupDirectories.length = 0;
});

describe("vivdCatalystChatUiPlugin", () => {
  it("injects client branding theme variables before the app loads", async () => {
    const root = await createClientFixture();
    const plugin = vivdCatalystChatUiPlugin({ clientConfigPath: "config/app.yaml" });
    plugin.configResolved({
      root,
      publicDir: false,
      build: {
        outDir: "dist/client"
      }
    });

    const tags = await plugin.transformIndexHtml?.();

    expect(tags).toHaveLength(2);
    const script = tags?.find((tag) => tag.tag === "script")?.children;
    const style = tags?.find((tag) => tag.tag === "style")?.children;
    expect(script).toContain("vivd-catalyst:theme");
    expect(script).toContain("defaultMode=\"system\"");
    expect(style).toContain(':root[data-vivd-theme="light"]');
    expect(style).toContain(':root[data-vivd-theme="dark"]');
    expect(style).toContain("--primary:#00a6e3;");
    expect(style).toContain("--background:#ffffff;");
    expect(style).toContain("--success:#047857;");
    expect(style).toContain("--warning:#b45309;");
    expect(style).toContain("--info:#0369a1;");
    expect(style).toContain("--chart-1:#0f766e;");
    expect(style).toContain("--success:#34d399;");
    expect(style).toContain("--warning:#fbbf24;");
    expect(style).toContain("--info:#38bdf8;");
    expect(style).toContain("--chart-1:#2dd4bf;");
    expect(style).toContain("--sidebar:#f7f9fb;");
    expect(style).toContain("html,body,#root{background:var(--background);color:var(--foreground);}");
  });

  it("skips the branding bootstrap when a default client config is not present", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-empty-client-"));
    cleanupDirectories.push(root);
    const plugin = vivdCatalystChatUiPlugin();
    plugin.configResolved({
      root,
      publicDir: false,
      build: {
        outDir: "dist/client"
      }
    });

    await expect(plugin.transformIndexHtml?.()).resolves.toBeUndefined();
  });
});

async function createClientFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-client-"));
  cleanupDirectories.push(root);
  await mkdir(join(root, "config"));
  await writeFile(
    join(root, "config", "app.yaml"),
    [
      "version: 1",
      "clientInstance:",
      "  id: test-client",
      "  displayName: Test Client",
      "  environment: development",
      "defaultAgentName: support",
      "agents:",
      "  - name: support",
      "    displayName: Support",
      "    instructions: Help with support requests.",
      "uiFile: ./ui.yaml",
      ""
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    join(root, "config", "ui.yaml"),
    [
      "clientName: Test Client",
      "title: Test Chat",
      "accentColor: \"#00a6e3\"",
      "defaultThemeMode: system",
      "theme:",
      "  accentColor: \"#00a6e3\"",
      "  accentStrongColor: \"#103258\"",
      "  backgroundColor: \"#f7f9fb\"",
      "  surfaceColor: \"#ffffff\"",
      "  textColor: \"#17252a\"",
      "  mutedTextColor: \"#5f6b76\"",
      "  borderColor: \"#dce2e7\"",
      "darkTheme:",
      "  accentColor: \"#00a6e3\"",
      "  accentStrongColor: \"#8adcf5\"",
      "  backgroundColor: \"#101615\"",
      "  surfaceColor: \"#171f1e\"",
      "  textColor: \"#eef7f6\"",
      "  mutedTextColor: \"#a5afad\"",
      "  borderColor: \"#2b3634\"",
      ""
    ].join("\n"),
    "utf8"
  );
  return root;
}
