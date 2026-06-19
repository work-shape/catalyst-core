import { describe, expect, it } from "vitest";
import { asClientInstanceId, type ToolExecutionContext } from "@vivd-catalyst/core";
import { showViewTool } from "@vivd-catalyst/tool-execution";

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
    expect(result.display.data?.html).toContain("Content-Security-Policy");
    expect(result.display.data?.html).toContain("connect-src 'none'");
    expect(result.display.data?.html).toContain("<section><h1>Dashboard</h1></section>");
  });
});

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
