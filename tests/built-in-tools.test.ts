import { describe, expect, it } from "vitest";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  clientInstanceConfigSchema,
  createSafeConfigView,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import { asClientInstanceId, type ToolExecutionContext } from "@work-shape/catalyst-core";
import { showViewTool } from "@work-shape/catalyst-tool-execution";

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
