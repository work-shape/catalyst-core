import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { vivdCatalystChatUiPlugin } from "@vivd-catalyst/chat-ui/vite";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories.map((directory) => rm(directory, { recursive: true, force: true }))
  );
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
    expect(script).toContain('defaultMode="system"');
    expect(style).toContain(':root[data-vivd-theme="light"]');
    expect(style).toContain(':root[data-vivd-theme="dark"]');
    expect(style).toContain("--primary:#00a6e3;");
    expect(style).toContain("--primary-foreground:#111111;");
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
    expect(style).toContain("--state-selected:color-mix(in srgb, #00a6e3 12%, transparent);");
    expect(style).toContain("--popover:color-mix(in srgb, #eef7f6 6%, #171f1e);");
    expect(style).toContain(
      "html,body,#root{background:var(--background);color:var(--foreground);}"
    );
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

  it("does not add a platform favicon unless a fallback is explicitly configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-no-favicon-client-"));
    cleanupDirectories.push(root);
    const plugin = vivdCatalystChatUiPlugin();
    plugin.configResolved({
      root,
      publicDir: false,
      build: {
        outDir: "dist/client"
      }
    });

    plugin.closeBundle();

    await expect(access(join(root, "dist/client/favicon.svg"))).rejects.toThrow();
  });

  it("serves the Catalyst mark as the default favicon", async () => {
    const root = await mkdtemp(join(tmpdir(), "vivd-catalyst-default-favicon-client-"));
    cleanupDirectories.push(root);
    const plugin = vivdCatalystChatUiPlugin({ faviconPath: platformFile(defaultFavicon) });
    plugin.configResolved({
      root,
      publicDir: false,
      build: {
        outDir: "dist/client"
      }
    });

    plugin.closeBundle();

    const served = await readFile(join(root, "dist/client/favicon.svg"), "utf8");
    expect(served).toContain('aria-label="Workshape Catalyst"');
    // The orange field with the small dark square at the bottom right, switching by itself.
    expect(served).toContain('<rect class="s" width="32" height="32"/>');
    expect(served).toContain('<rect class="b" x="18" y="18" width="12" height="12"/>');
    expect(served).toContain("@media (prefers-color-scheme:dark)");
    expect(served).not.toContain("<path");
  });

  it("keeps one mark in every place the platform ships its own favicon", async () => {
    const mark = await readFile(platformFile(defaultFavicon), "utf8");

    for (const copy of [
      "clients/demo/public/favicon.svg",
      "packages/chat-standalone/public/favicon.svg",
      "packages/docs/public/favicon.svg"
    ]) {
      expect(await readFile(platformFile(copy), "utf8"), copy).toBe(mark);
    }
  });
});

const defaultFavicon = "packages/chat-ui/assets/favicon.svg";

function platformFile(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

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
      "infrastructure:",
      "  models:",
      "    local:",
      "      provider: deterministic",
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
      'accentColor: "#00a6e3"',
      "defaultThemeMode: system",
      "theme:",
      '  accentColor: "#00a6e3"',
      '  accentStrongColor: "#103258"',
      '  backgroundColor: "#f7f9fb"',
      '  surfaceColor: "#ffffff"',
      '  textColor: "#17252a"',
      '  mutedTextColor: "#5f6b76"',
      '  borderColor: "#dce2e7"',
      "darkTheme:",
      '  accentColor: "#00a6e3"',
      '  accentStrongColor: "#8adcf5"',
      '  backgroundColor: "#101615"',
      '  surfaceColor: "#171f1e"',
      '  textColor: "#eef7f6"',
      '  mutedTextColor: "#a5afad"',
      '  borderColor: "#2b3634"',
      ""
    ].join("\n"),
    "utf8"
  );
  return root;
}
