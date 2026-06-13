import { z } from "zod";
import type {
  JsonObject,
  ToolHandlerResult,
  ToolPermissionPolicy,
  ToolRuntimeContext
} from "@vivd-catalyst/core";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  inputJsonSchema?: JsonObject;
  permission?: ToolPermissionPolicy;
  execute(
    input: TInput,
    context: ToolRuntimeContext
  ): Promise<ToolHandlerResult<TOutput>> | ToolHandlerResult<TOutput>;
}

export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

export interface ConfiguredToolDefinition<TConfig = unknown> {
  name: string;
  configSchema?: z.ZodType<TConfig>;
  create(config: TConfig): AnyToolDefinition;
}

export type AnyConfiguredToolDefinition = ConfiguredToolDefinition<unknown>;
export type ToolAssemblyDefinition = AnyToolDefinition | AnyConfiguredToolDefinition;

export function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  return definition;
}

export function defineConfiguredTool<TConfig>(
  definition: ConfiguredToolDefinition<TConfig>
): ConfiguredToolDefinition<TConfig> {
  return definition;
}

export function isConfiguredToolDefinition(
  definition: ToolAssemblyDefinition
): definition is AnyConfiguredToolDefinition {
  return "create" in definition && typeof definition.create === "function";
}

export function toolSuccess<TOutput>(
  output: TOutput,
  options: Omit<Extract<ToolHandlerResult<TOutput>, { status: "success" }>, "status" | "output"> = {}
): ToolHandlerResult<TOutput> {
  return {
    status: "success",
    output,
    ...options
  };
}

export function toolFailed(
  code: Extract<ToolHandlerResult, { status: "failed" }>["error"]["code"],
  message: string
): ToolHandlerResult<never> {
  return {
    status: "failed",
    error: {
      code,
      message
    }
  };
}
