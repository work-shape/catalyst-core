import { z } from "zod";
import type {
  ConversationId,
  JsonObject,
  JsonValue,
  OperationBeforeEvent,
  OperationEffect,
  PolicyValue,
  ToolExecutionErrorCode,
  ToolHandlerResult,
  ToolPermissionPolicy,
  ToolRuntimeContext
} from "@vivd-catalyst/core";

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  /**
   * `changing` when the tool writes state that outlives the call and is visible outside the
   * model's own message, `reading` otherwise. Every call of the tool is an Operation Run with
   * this effect; a changing call is what a policy can hold for an approval.
   */
  effect: OperationEffect;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  inputJsonSchema?: JsonObject;
  permission?: ToolPermissionPolicy;
  /**
   * A policy value no call from one conversation is looser than, whatever the tool's own mode
   * says: a tool that stands for another operation answers here what that operation's policy
   * asks for what the conversation reaches, and for what the call's input names where it names
   * the asset. Nothing where the conversation adds no floor.
   */
  policyFloor?(
    call: { conversationId: ConversationId },
    input: TInput
  ): PolicyValue | undefined | Promise<PolicyValue | undefined>;
  /**
   * The before-events of a call beside `operation.before_call`: a tool that saves an asset
   * names `asset.before_write` for it, so the guardrails on asset writes answer an agent's save
   * as they answer a person's.
   */
  beforeEvents?(
    input: TInput,
    call: { conversationId: ConversationId }
  ): readonly OperationBeforeEvent[] | Promise<readonly OperationBeforeEvent[]>;
  /** See `heldInputKeys` of an operation: what its before-events may hold beside the input. */
  heldInputKeys?: readonly string[];
  execute(
    input: TInput,
    context: ToolRuntimeContext
  ): Promise<ToolHandlerResult<TOutput>> | ToolHandlerResult<TOutput>;
}

export type DefinedToolDefinition<TInput = unknown, TOutput = unknown> = ToolDefinition<
  TInput,
  TOutput
> & { inputJsonSchema: JsonObject };
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
  options: Omit<
    Extract<ToolHandlerResult<TOutput>, { status: "success" }>,
    "status" | "output"
  > = {}
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
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
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
