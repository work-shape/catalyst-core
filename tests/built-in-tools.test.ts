import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@vivd-catalyst/client-assembly";
import {
  clientInstanceConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig
} from "@vivd-catalyst/config-schema";
import { asClientInstanceId, isJsonObject, type ToolExecutionContext } from "@vivd-catalyst/core";
import { createShowViewTool, showViewTool } from "@vivd-catalyst/tool-execution";

describe("built-in platform tools", () => {
  it("stores the model's HTML alone and keeps it out of model-visible output", async () => {
    const result = await showViewTool.execute(
      {
        html: "<section><h1>Dashboard</h1></section>",
        mode: "inline",
        title: "Dashboard"
      },
      createToolContext()
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected show_view to succeed");
    }

    expect(JSON.stringify(result.output)).not.toContain("<section>");
    // Version 2: the head, the content policy and the runtime are composed by the interface
    // when the view is shown (tests/chat-ui-view-document.test.ts).
    expect(result.display).toMatchObject({
      kind: "html.rendered",
      version: 2,
      mode: "inline",
      data: {
        title: "Dashboard",
        html: "<section><h1>Dashboard</h1></section>"
      }
    });
  });

  it("strips a content policy the model wrote and nothing else", async () => {
    const result = await showViewTool.execute(
      {
        html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><title>Chart</title></head><body><script>window.chartReady = true;</script></body></html>`,
        mode: "inline"
      },
      createToolContext()
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected show_view to succeed");
    }
    expect(result.display?.data?.html).toBe(
      "<!doctype html><html><head><title>Chart</title></head><body><script>window.chartReady = true;</script></body></html>"
    );
  });

  it("tells the agent what a view may load", () => {
    const closed = createShowViewTool();
    const named = createShowViewTool({ allowedScriptSrc: ["https://cdn.jsdelivr.net"] });
    const open = createShowViewTool({ allowedScriptSrc: ["https:"] });

    for (const tool of [closed, named, open]) {
      expect(tool.description).toContain("Tailwind CSS and Lucide are loaded from the instance");
      expect(tool.description).toContain("Network fetches and external images are blocked.");
    }
    expect(closed.description).toContain("No other script file can be loaded");
    expect(named.description).toContain("only from: https://cdn.jsdelivr.net.");
    expect(open.description).toContain("from any HTTPS host");
  });

  it("names no outside host and no runtime switch in the tool's source", async () => {
    const source = await readFile("packages/tool-execution/src/built-in-tools.ts", "utf8");

    expect(source).not.toMatch(/cdn\.tailwindcss\.com|unpkg\.com|externalRuntime/u);
  });

  it("gives the layout and color guidance once, in the tool description", () => {
    const description = showViewTool.description;
    const htmlDescription = readHtmlSchemaDescription();

    for (const rule of [
      "must not frame itself",
      "md:p-6",
      "Start directly with the content",
      "no introductory heading or preamble",
      "no heading that repeats the title",
      "no max-width or centering container",
      "shadcn-style theme classes are available",
      "Only bordered cards carry inner padding",
      "gap-* or space-y-*",
      "never scrolls inside itself",
      "h-screen, min-h-screen, fixed height, or overflow-y-auto",
      "bg-background text-foreground",
      "text-success",
      "text-destructive",
      "bg-success/10",
      "border-warning/30 bg-warning/10",
      "Do not make the view monochrome",
      "Never use color as the only signal",
      "bg-white",
      "text-gray-*/text-slate-*",
      "!important",
      "success, warning, info",
      "chartPalette()",
      "text-chart-1",
      "text-chart-5",
      "bg-chart-2/20",
      "chartColors() returns a named object",
      "never index it like an array",
      "color('foreground')",
      'data-lucide="chart-column"'
    ]) {
      expect(description).toContain(rule);
      expect(description.split(rule)).toHaveLength(2);
      expect(htmlDescription).not.toContain(rule);
    }
    expect(htmlDescription).toContain("rules in the tool description");
    expect(wordCount(description) + wordCount(htmlDescription)).toBeLessThan(400);
  });
});

describe("views config", () => {
  it("allows no outside script host by default and shows the list in the safe config", () => {
    const config = parseClientInstanceConfig(baseConfig());

    expect(config.views.allowedScriptSrc).toEqual([]);
    expect(
      createSafeConfigView(config, emptyAssets(), resolveInstanceModules(config, []).snapshot).views
    ).toEqual({ allowedScriptSrc: [] });
  });

  it("normalizes the named hosts", () => {
    const config = parseClientInstanceConfig(
      baseConfig({
        views: { allowedScriptSrc: ["https://cdn.jsdelivr.net/", "https://cdn.jsdelivr.net", "*"] }
      })
    );

    expect(config.views.allowedScriptSrc).toEqual(["https://cdn.jsdelivr.net", "https:"]);
    expect(
      createSafeConfigView(config, emptyAssets(), resolveInstanceModules(config, []).snapshot).views
        .allowedScriptSrc
    ).toEqual(["https://cdn.jsdelivr.net", "https:"]);
  });

  it("rejects unsafe script sources", () => {
    for (const source of [
      "http://cdn.jsdelivr.net",
      "https://cdn.jsdelivr.net/npm/chart.js?leak=value",
      "https://*.example.test"
    ]) {
      expect(() =>
        parseClientInstanceConfig(baseConfig({ views: { allowedScriptSrc: [source] } }))
      ).toThrow();
    }
  });

  it("refuses every key in the tool's own config and names the new one", () => {
    for (const key of ["allowedScriptSrc", "anyOtherKey"]) {
      const parsed = clientInstanceConfigSchema.safeParse(
        baseConfig({ tools: [{ name: "show_view", enabled: true, config: { [key]: ["*"] } }] })
      );

      expect(parsed.error?.issues).toMatchObject([
        {
          path: ["tools", 0, "config", key],
          message: expect.stringContaining("'views.allowedScriptSrc'")
        }
      ]);
    }
  });
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    clientInstance: {
      id: "views-config-test",
      displayName: "Views Config Test",
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

function readHtmlSchemaDescription(): string {
  const properties = showViewTool.inputJsonSchema?.properties;
  if (!isJsonObject(properties)) {
    throw new Error("Expected show_view input JSON schema to include properties");
  }
  const html = properties.html;
  if (!isJsonObject(html) || typeof html.description !== "string") {
    throw new Error("Expected show_view input JSON schema to describe html");
  }
  return html.description;
}

function createToolContext(): ToolExecutionContext {
  const clientInstanceId = asClientInstanceId("built-in-tools-client");
  return {
    clientInstanceId,
    correlationId: "corr_built_in_tools",
    user: {
      id: "user-built-in-tools",
      externalUserId: "user-built-in-tools",
      displayLabel: "Built In Tools User",
      roles: ["user"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test"
    }
  };
}

function wordCount(text: string): number {
  return text.split(/\s+/u).filter(Boolean).length;
}
