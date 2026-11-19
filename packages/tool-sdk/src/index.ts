import type { z } from "zod";
import { deriveInputJsonSchema } from "./input-json-schema";
import type {
  ConversationId,
  JsonObject,
  OperationBeforeEvent,
  OperationAuth,
  OperationAuthorization,
  OperationChangeClass,
  OperationAuthorizeContext,
  OperationEffect,
  PolicyValue,
  ToolExecutionErrorCode,
  ToolHandlerResult,
  ToolPermissionPolicy,
  ToolPresentation,
  ToolRuntimeContext
} from "@work-shape/catalyst-core";

/**
 * A tool an agent can call. `title`, `summary`, `group` and `icon` are for people: the agent page
 * shows them, and the model never reads them.
 */
export interface ToolDefinition<TInput = unknown, TOutput = unknown> extends ToolPresentation {
  name: string;
  /** What the model reads: when to use the tool, what it takes and returns, and its limits. */
  description: string;
  /**
   * `changing` when the tool writes state that outlives the call and is visible outside the
   * model's own message, `reading` otherwise. Every call of the tool is an Operation Run with
   * this effect; a changing call is what a policy can hold for an approval.
   */
  effect: OperationEffect;
  /**
   * How far a changing tool reaches. Only a `reversible` change may be set to "Always allow" by
   * a person; one that declares none counts as `irreversible`.
   */
  changeClass?: OperationChangeClass;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  inputJsonSchema?: JsonObject;
  permission?: ToolPermissionPolicy;
  /**
   * Who may call the tool. `user`, the default: a person only, so a run whose principal is a
   * service principal is refused it. `principal`: a service principal too, for a tool that
   * reaches only what the run's own thread holds, such as its attachments.
   */
  auth?: OperationAuth;
  /**
   * Checks the exact parsed call before policy, guardrails and confirmation. May run again
   * when a held call resumes or for a bound principal; it must have no side effects.
   */
  authorize?(
    input: TInput,
    context: OperationAuthorizeContext
  ): OperationAuthorization | Promise<OperationAuthorization>;
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

export { deriveInputJsonSchema };
