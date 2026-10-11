import { AppError, type ModuleSnapshot, type ToolDescriptor } from "@vivd-catalyst/core";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";

export interface ToolRegistryOptions {
  tools: AnyToolDefinition[];
  enabledToolNames?: Set<string>;
  /**
   * Which modules are on. A tool of a module that is off is not in the registry: the model is
   * not offered it and a call that names it finds nothing, whatever an agent still lists.
   */
  modules?: ModuleSnapshot;
}

/**
 * The prefixes of tools that exist as data, not as release code. A tool of the release may not
 * take such a name: it would stand in for an operation that rights and a policy of its own
 * guard.
 *
 * Local until `core/src/data-tools.ts` exists (C1 slice K). Then both come from core.
 */
export const DATA_TOOL_PREFIXES = ["connection."] as const;

export function isDataToolName(name: string): boolean {
  return DATA_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export class ToolRegistry {
  private readonly toolsByName = new Map<string, AnyToolDefinition>();
  private readonly enabledToolNames?: Set<string>;
  private readonly modules?: ModuleSnapshot;

  constructor(options: ToolRegistryOptions) {
    this.enabledToolNames = options.enabledToolNames;
    this.modules = options.modules;
    for (const tool of options.tools) {
      assertValidToolName(tool.name);
      assertReleaseToolName(tool.name);
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
    if (this.modules?.offModuleOf("tool", toolName) !== undefined) {
      return undefined;
    }
    return this.toolsByName.get(toolName);
  }

  /** The tools this instance has: enabled, and of no module that is off. */
  list(): AnyToolDefinition[] {
    return [...this.toolsByName.keys()].flatMap((toolName) => this.get(toolName) ?? []);
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

function assertReleaseToolName(name: string): void {
  const prefix = DATA_TOOL_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (prefix !== undefined) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Tool name '${name}' starts with '${prefix}', which names tools that come from data. Give the tool another name.`
    );
  }
}

function assertValidToolName(name: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(name)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Tool name '${name}' must start with a letter and contain only letters, numbers, dots, underscores, or hyphens`
    );
  }
}
