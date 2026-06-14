import { describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  type DataSourceConfig,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { createBuiltInToolDefinitions, renderHtmlTool } from "@vivd-catalyst/tool-execution";

describe("built-in platform tools", () => {
  it("renders model-authored HTML through display without echoing HTML into model-visible output", async () => {
    const result = await renderHtmlTool.execute(
      {
        html: "<section><h1>Dashboard</h1></section>",
        mode: "inline",
        title: "Dashboard"
      },
      createToolContext()
    );

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected renderHtml to succeed");
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
    expect(result.display.data?.html).toContain("Content-Security-Policy");
    expect(result.display.data?.html).toContain("connect-src 'none'");
    expect(result.display.data?.html).toContain("<section><h1>Dashboard</h1></section>");
  });

  it("fails fast when an enabled data-source render tool references a missing secret", () => {
    expect(() =>
      createBuiltInToolDefinitions({
        dataSources: {
          reporting: createDataSource()
        },
        env: {}
      })
    ).toThrow(/Missing data source connection secret 'REPORTING_DATABASE_URL'/u);
  });

  it("creates one private render-view tool for an enabled data source", () => {
    const tools = createBuiltInToolDefinitions({
      dataSources: {
        reporting: createDataSource()
      },
      env: {
        REPORTING_DATABASE_URL: "postgres://readonly@example.test/reporting"
      }
    });

    expect(tools.map((tool) => tool.name)).toContain("data.reporting.render_view");
    expect(tools.find((tool) => tool.name === "data.reporting.render_view")?.description).toContain(
      "reporting"
    );
  });
});

function createDataSource(): DataSourceConfig {
  return {
    kind: "postgres",
    connectionRef: "env:REPORTING_DATABASE_URL",
    description: "reporting warehouse",
    sql: {
      dialect: "postgres",
      access: "read_only",
      statementTimeoutMs: 10000,
      maxRows: 5000,
      allowedSchemas: ["reporting"],
      schemaDescription: "Reporting views for aggregate workflow state."
    },
    tools: {
      renderView: {
        enabled: true,
        name: "data.reporting.render_view",
        modelVisibleOutput: "zero_data_ack"
      }
    }
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
