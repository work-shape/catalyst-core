import { AppError, type ToolDescriptor } from "@vivd-stage/core";
import type { AnyToolDefinition } from "@vivd-stage/tool-sdk";

export interface ToolRegistryOptions {
  tools: AnyToolDefinition[];
  enabledToolNames?: Set<string>;
}

export class ToolRegistry {
  private readonly toolsByName = new Map<string, AnyToolDefinition>();
  private readonly enabledToolNames?: Set<string>;

  constructor(options: ToolRegistryOptions) {
    this.enabledToolNames = options.enabledToolNames;
    for (const tool of options.tools) {
      assertValidToolName(tool.name);
      if (this.toolsByName.has(tool.name)) {
        throw new AppError("CONFLICT", `Duplicate tool definition '${tool.name}'`);
      }
      this.toolsByName.set(tool.name, tool);
    }
  }

  get(toolName: string): AnyToolDefinition | undefined {
    if (this.enabledToolNames && !this.enabledToolNames.has(toolName)) {
      return undefined;
    }
    return this.toolsByName.get(toolName);
  }

  listDescriptorsForAgent(toolNames: readonly string[]): ToolDescriptor[] {
    return toolNames
      .map((toolName) => this.get(toolName))
      .filter((tool): tool is AnyToolDefinition => Boolean(tool))
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputJsonSchema: tool.inputJsonSchema,
        permission: tool.permission
      }));
  }

  has(toolName: string): boolean {
    return Boolean(this.get(toolName));
  }
}

function assertValidToolName(name: string): void {
  if (!/^[a-z][a-z0-9_.-]*$/u.test(name)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Tool name '${name}' must start with a lowercase letter and contain only lowercase letters, numbers, dots, underscores, or hyphens`
    );
  }
}
