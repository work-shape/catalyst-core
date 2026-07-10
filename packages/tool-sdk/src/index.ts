import { z } from "zod";
import type {
  JsonObject,
  JsonValue,
  ToolExecutionErrorCode,
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

export type DefinedToolDefinition<TInput = unknown, TOutput = unknown> =
  ToolDefinition<TInput, TOutput> & { inputJsonSchema: JsonObject };
export type AnyToolDefinition = DefinedToolDefinition<unknown, unknown>;

export interface ConfiguredToolDefinition<TConfig = unknown> {
  name: string;
  configSchema?: z.ZodType<TConfig>;
  create(config: TConfig): AnyToolDefinition;
}

export type AnyConfiguredToolDefinition = ConfiguredToolDefinition<unknown>;
export type ToolAssemblyDefinition = AnyToolDefinition | AnyConfiguredToolDefinition;

export function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>
): DefinedToolDefinition<TInput, TOutput> {
  return {
    ...definition,
    inputJsonSchema: definition.inputJsonSchema ?? deriveInputJsonSchema(definition.inputSchema)
  };
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
  code: ToolExecutionErrorCode,
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

function deriveInputJsonSchema(schema: z.ZodType<unknown>): JsonObject {
  const jsonSchema = z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
    unrepresentable: "any"
  });
  return sanitizeJsonSchemaObject(jsonSchema);
}

function sanitizeJsonSchemaValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeJsonSchemaValue(item))
      .filter((item): item is JsonValue => item !== undefined);
  }
  if (isRecord(value)) {
    return sanitizeJsonSchemaObject(value);
  }
  return undefined;
}

function sanitizeJsonSchemaObject(input: Record<string, unknown>): JsonObject {
  const output: JsonObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "$schema" || key === "~standard") {
      continue;
    }
    const sanitizedValue = sanitizeJsonSchemaValue(value);
    if (sanitizedValue !== undefined) {
      output[key] = sanitizedValue;
    }
  }
  if (isObjectJsonSchema(output) && !("additionalProperties" in output)) {
    output.additionalProperties = false;
  }
  return output;
}

function isObjectJsonSchema(schema: JsonObject): boolean {
  if (schema.type === "object") {
    return true;
  }
  return Array.isArray(schema.type) && schema.type.includes("object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
