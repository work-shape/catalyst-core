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

    expect(tags).toHaveLength(3);
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

    const tags = await plugin.transformIndexHtml?.();
    expect(tags?.map((tag) => tag.tag)).toEqual(["meta"]);
  });

  it("puts the content policy first, limiting images, media, fonts and connections", async () => {
    const root = await createClientFixture();
    const plugin = vivdCatalystChatUiPlugin({ clientConfigPath: "config/app.yaml" });
    plugin.configResolved({
      root,
      publicDir: false,
      command: "build",
      env: {},
      build: { outDir: "dist/client" }
    });

    const tags = await plugin.transformIndexHtml?.();
    const policy = contentPolicyOf(tags);

    expect(tags?.[0]?.attrs?.["http-equiv"]).toBe("Content-Security-Policy");
    expect(directive(policy, "img-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(directive(policy, "media-src")).toEqual(["'self'", "data:", "blob:"]);
    expect(directive(policy, "font-src")).toEqual(["'self'", "data:"]);
    expect(directive(policy, "connect-src")).toEqual(["'self'", "blob:", "data:"]);
    // Views and Apps have documents and policies of their own; scripts and frames stay open.
    expect(policy).not.toMatch(/script-src|style-src|frame-src|default-src/u);
  });

  it("adds a separate API, a remote logo host and Vite's socket in development", async () => {
    const root = await createClientFixture({ logoUrl: "https://brand.example.org/logo.svg" });
    const plugin = vivdCatalystChatUiPlugin({ clientConfigPath: "config/app.yaml" });
    plugin.configResolved({
      root,
      publicDir: false,
      command: "serve",
      env: { VITE_CHAT_API_PORT: "4101" },
      build: { outDir: "dist/client" }
    });

    const policy = contentPolicyOf(await plugin.transformIndexHtml?.());

    expect(directive(policy, "img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "http://*:4101",
      "https://*:4101",
      "https://brand.example.org"
    ]);
    expect(directive(policy, "connect-src")).toEqual(
      expect.arrayContaining(["http://*:4101", "ws:", "wss:"])
    );
    expect(directive(policy, "connect-src")).not.toContain("https://brand.example.org");
  });

  it("names an API on another origin by that origin", async () => {
    const root = await createClientFixture();
    const plugin = vivdCatalystChatUiPlugin({ clientConfigPath: "config/app.yaml" });
    plugin.configResolved({
      root,
      publicDir: false,
      command: "build",
      env: { VITE_CHAT_API_URL: "https://api.example.com/base", VITE_CHAT_API_PORT: "4101" },
      build: { outDir: "dist/client" }
    });

    const policy = contentPolicyOf(await plugin.transformIndexHtml?.());

    expect(directive(policy, "connect-src")).toEqual([
      "'self'",
      "blob:",
      "data:",
      "https://api.example.com"
    ]);
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
      "packages/chat-standalone/public/favicon.svg"
    ]) {
      expect(await readFile(platformFile(copy), "utf8"), copy).toBe(mark);
    }
  });

  it("gives the docs site its own variant of the mark, in the mark's colours only", async () => {
    const mark = await readFile(platformFile(defaultFavicon), "utf8");
    const docsMark = await readFile(platformFile("packages/docs/public/favicon.svg"), "utf8");
    const colours = (svg: string) => new Set(svg.match(/#[0-9a-f]{6}/giu));

    expect(docsMark).not.toBe(mark);
    expect(docsMark).toContain("@media (prefers-color-scheme:dark)");
    expect([...colours(docsMark)].filter((colour) => !colours(mark).has(colour))).toEqual([]);
  });
});

const defaultFavicon = "packages/chat-ui/assets/favicon.svg";

function contentPolicyOf(
  tags: ReadonlyArray<{ tag: string; attrs?: Record<string, string> }> | undefined
): string {
  return tags?.find((tag) => tag.tag === "meta")?.attrs?.content ?? "";
}

function directive(policy: string, name: string): string[] {
  const found = policy
    .split(";")
    .map((part) => part.trim().split(/\s+/u))
    .find(([directiveName]) => directiveName === name);
  return found ? found.slice(1) : [];
}

function platformFile(path: string): string {
  return fileURLToPath(new URL(`../${path}`, import.meta.url));
}

async function createClientFixture(ui: { logoUrl?: string } = {}): Promise<string> {
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
      ...(ui.logoUrl ? [`logoUrl: ${ui.logoUrl}`] : []),
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
