import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { asClientInstanceId, type ToolExecutionContext } from "@vivd-catalyst/core";
import { showViewTool, showViewToolDefinition } from "@vivd-catalyst/tool-execution";

describe("built-in platform tools", () => {
  it("renders model-authored HTML through display without echoing HTML into model-visible output", async () => {
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
    expect(result.display).toMatchObject({
      kind: "html.rendered",
      version: 1,
      mode: "inline",
      data: {
        title: "Dashboard"
      }
    });
    expect(result.display.data?.html).toContain("cdn.tailwindcss.com");
    expect(result.display.data?.html).toContain("lucide.min.js");
    expect(result.display.data?.html).toContain("vivdCatalystTheme");
    expect(result.display.data?.html).toContain("Content-Security-Policy");
    expect(result.display.data?.html).toContain("connect-src 'none'");
    expect(result.display.data?.html).toContain("<section><h1>Dashboard</h1></section>");
  });

  it("allows external HTTPS scripts by default for chart CDNs", async () => {
    const result = await showViewTool.execute(
      {
        html: '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script><canvas id="chart"></canvas>',
        mode: "inline"
      },
      createToolContext()
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected show_view to succeed");
    }

    expect(readCsp(result.display.data?.html)).toContain("script-src https://cdn.tailwindcss.com https://unpkg.com https:");
    expect(showViewTool.description).toContain("External HTTPS script sources are configured");
  });

  it("can be configured to keep third-party chart CDNs out of the HTML display CSP", async () => {
    const configuredTool = showViewToolDefinition.create({
      allowedScriptSrc: []
    });

    const result = await configuredTool.execute(
      {
        html: '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script><canvas id="chart"></canvas>',
        mode: "inline"
      },
      createToolContext()
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected show_view to succeed");
    }

    const scriptSrc = readCspDirective(result.display.data?.html, "script-src");
    expect(scriptSrc).toContain("https://cdn.tailwindcss.com");
    expect(scriptSrc).toContain("https://unpkg.com");
    expect(scriptSrc).not.toContain("https:");
    expect(configuredTool.description).toContain("No additional charting CDNs are configured");
  });

  it("adds configured script sources to the HTML display CSP", async () => {
    const configuredTool = showViewToolDefinition.create({
      allowedScriptSrc: ["https://cdn.jsdelivr.net"]
    });

    const result = await configuredTool.execute(
      {
        html: '<script src="https://cdn.jsdelivr.net/npm/chart.js"></script><canvas id="chart"></canvas>',
        mode: "inline"
      },
      createToolContext()
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected configured show_view to succeed");
    }

    expect(readCsp(result.display.data?.html)).toContain(
      "script-src https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net"
    );
    expect(configuredTool.description).toContain("https://cdn.jsdelivr.net");
  });

  it("maps the wildcard script source setting to HTTPS scripts", async () => {
    const parsedConfig = showViewToolDefinition.configSchema?.safeParse({
      allowedScriptSrc: ["*"]
    });
    expect(parsedConfig?.success).toBe(true);
    if (!parsedConfig?.success) {
      throw new Error("Expected wildcard config to parse");
    }
    const configuredTool = showViewToolDefinition.create(parsedConfig.data);

    const result = await configuredTool.execute(
      {
        html: '<script src="https://cdn.example.test/chart.js"></script><canvas id="chart"></canvas>',
        mode: "inline"
      },
      createToolContext()
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected wildcard configured show_view to succeed");
    }

    expect(readCsp(result.display.data?.html)).toContain("https:");
    expect(configuredTool.description).toContain("External HTTPS script sources are configured");
  });

  it("strips model-authored CSP tags and hashes model-authored inline scripts", async () => {
    const inlineScript = "window.chartReady = true;";
    const result = await showViewTool.execute(
      {
        html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"><title>Chart</title></head><body><script>${inlineScript}</script></body></html>`,
        mode: "inline"
      },
      createToolContext()
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected show_view to succeed");
    }

    const html = result.display.data?.html ?? "";
    const csp = readCsp(html);
    const scriptSrc = readCspDirective(html, "script-src");
    expect(countOccurrences(html, "Content-Security-Policy")).toBe(1);
    expect(csp).not.toContain("script-src 'none'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(csp).toContain(scriptHashSource(inlineScript));
  });

  it("rejects unsafe configured script sources", () => {
    expect(showViewToolDefinition.configSchema?.safeParse({
      allowedScriptSrc: ["http://cdn.jsdelivr.net"]
    }).success).toBe(false);

    expect(showViewToolDefinition.configSchema?.safeParse({
      allowedScriptSrc: ["https://cdn.jsdelivr.net/npm/chart.js?leak=value"]
    }).success).toBe(false);
  });
});

function readCsp(html: string | undefined): string {
  const match = html?.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/u);
  if (!match?.[1]) {
    throw new Error("Expected rendered HTML to include a CSP meta tag");
  }
  return match[1];
}

function readCspDirective(html: string | undefined, directiveName: string): string[] {
  const csp = readCsp(html);
  const directive = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${directiveName} `));
  if (!directive) {
    throw new Error(`Expected rendered HTML CSP to include ${directiveName}`);
  }
  return directive.split(/\s+/u).slice(1);
}

function countOccurrences(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}

function scriptHashSource(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
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
