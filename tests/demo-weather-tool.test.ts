import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  isJsonObject,
  type LocaleCode,
  type ToolExecutionContext,
  type ToolExecutionResult
} from "@work-shape/catalyst-core";
import { ToolRegistry } from "@work-shape/catalyst-tool-execution";
import { weatherForecastTool } from "../clients/demo/tools/weather-forecast";
import { createTestToolRunner } from "./support/tool-runner";

describe("demo weather forecast tool", () => {
  it("derives the configured model-facing input schema from the Zod schema", () => {
    const schema = weatherForecastTool.inputJsonSchema;
    const properties = schema.properties;
    if (!isJsonObject(properties)) {
      throw new Error("Expected weather tool input schema properties");
    }

    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["location"]
    });
    expect(schema).not.toHaveProperty("$schema");
    expect(properties.location).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 120,
      description: "City, region, or place name for the forecast."
    });
    expect(properties.days).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 5,
      default: 3,
      description: "Number of forecast days to return."
    });
    expect(properties.unit).toMatchObject({
      type: "string",
      enum: ["celsius", "fahrenheit"],
      default: "celsius"
    });
    expect(properties.startDate).toMatchObject({
      type: "string",
      pattern: "^\\d{4}-\\d{2}-\\d{2}$",
      description: "Optional ISO date for deterministic demos."
    });
    expect(schema.required).not.toContain("startDate");
  });

  it("returns a structured forecast with a weather display payload", async () => {
    const result = await runWeatherTool();
    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected weather tool to succeed");
    }

    expect(result.output).toMatchObject({
      location: "Oslo",
      unit: "celsius"
    });
    expect((result.output as { days: unknown[] }).days).toHaveLength(3);
    expect(result.display).toMatchObject({
      kind: "weather.forecast",
      version: 1,
      mode: "inline",
      data: {
        location: "Oslo"
      }
    });
  });

  it("localizes forecast summaries from the runtime locale", async () => {
    const result = await runWeatherTool("de");
    expect(result.status).toBe("success");
    if (result.status !== "success") {
      throw new Error("Expected weather tool to succeed");
    }

    expect(JSON.stringify(result.output)).toContain("Regenschutz");
    expect(JSON.stringify(result.display)).toContain("Regenschutz");
  });
});

async function runWeatherTool(locale?: LocaleCode): Promise<ToolExecutionResult> {
  const context = createToolContext(locale);
  const runTool = createTestToolRunner({
    registry: new ToolRegistry({ tools: [weatherForecastTool] }),
    getAgentToolNames: () => ["demo.weather_forecast"]
  });
  const request = {
    toolName: "demo.weather_forecast",
    toolCallId: asToolCallId("toolcall_weather"),
    agentRunId: asAgentRunId("run_weather"),
    conversationId: asConversationId("conv_weather"),
    agentName: "workflow_assistant",
    input: {
      location: "Oslo",
      days: 3,
      startDate: "2026-06-13"
    }
  };

  return runTool(request, context);
}

function createToolContext(locale?: LocaleCode): ToolExecutionContext {
  const clientInstanceId = asClientInstanceId("demo-local");
  return {
    clientInstanceId,
    locale,
    correlationId: "corr_weather",
    user: {
      id: "user-weather",
      externalUserId: "user-weather",
      displayLabel: "Weather User",
      roles: ["user"],
      permissionRefs: ["demo-tools"],
      clientInstanceId,
      authSource: "test"
    }
  };
}
