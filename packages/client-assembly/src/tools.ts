import { AppError } from "@vivd-catalyst/core";
import type { ClientInstanceConfig } from "@vivd-catalyst/config-schema";
import {
  isConfiguredToolDefinition,
  type AnyConfiguredToolDefinition,
  type AnyToolDefinition,
  type ToolAssemblyDefinition
} from "@vivd-catalyst/tool-sdk";

export function createToolDefinitions(input: {
  config: ClientInstanceConfig;
  tools: ToolAssemblyDefinition[];
}): AnyToolDefinition[] {
  const configuredTools = new Map(input.config.tools.map((tool) => [tool.name, tool.config]));

  return input.tools.map((tool) => {
    if (!isConfiguredToolDefinition(tool)) {
      return tool;
    }

    return createConfiguredToolDefinition(tool, configuredTools.get(tool.name) ?? {});
  });
}

function createConfiguredToolDefinition(
  tool: AnyConfiguredToolDefinition,
  config: Record<string, unknown>
): AnyToolDefinition {
  const parsed = tool.configSchema?.safeParse(config);
  if (parsed && !parsed.success) {
    throw new AppError("VALIDATION_FAILED", `Config for tool '${tool.name}' is invalid`, {
      issues: parsed.error.issues
    });
  }

  const definition = tool.create(parsed?.data ?? config);
  if (definition.name !== tool.name) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Configured tool '${tool.name}' created implementation '${definition.name}'`
    );
  }

  return definition;
}
