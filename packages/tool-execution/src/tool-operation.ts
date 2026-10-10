import { ZodError, z } from "zod";
import {
  AGENT_TOOL_ACTION_PREFIX,
  AppError,
  PERMISSION_REF_ACTION_PREFIX,
  answerAsTool,
  isAppError,
  isAuthenticatedServicePrincipal,
  operationCallFromToolRequest,
  operationDenialError,
  toErrorEnvelope,
  toolRequestFromOperationCall,
  type ClientInstanceId,
  type JsonObject,
  type Logger,
  type OperationDefinition,
  type OperationDenial,
  type OperationEffect,
  type OperationExecutionContext,
  type OperationRegistry,
  type PolicyValue,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolHandlerFailureResult,
  type ToolOperationRunner,
  type ToolPermissionMode
} from "@vivd-catalyst/core";
import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import type { OperationOutcome, RunOperationDeps } from "./operation-execution";
import { runOperation } from "./run-operation";
import { toolFailureLogRecord } from "./tool-failure-log";
import type { ToolRegistry } from "./tool-registry";
import { failed } from "./tool-results";

/**
 * After how long a tool call that is still `running` counts as interrupted. No tool runs
 * longer: a command in an execution workspace, the longest of them, is cut off well before.
 * A call still running after it lost its process, and its run is failed as `interrupted`.
 */
export const TOOL_OPERATION_TIMEOUT_MS = 60 * 60 * 1000;

/** The approval kind of a call that waits for another person's approval. */
export const OPERATION_CALL_APPROVAL_KIND = "operation_call";

export interface ToolOperationOptions {
  clientInstanceId: ClientInstanceId;
  /** Receives the full error of a handler whose failure the model only sees as a reference. */
  logger?: Logger;
}

/** What a tool declares for the policy of its operation: its name, effect and default. */
export function toolOperationPolicy(
  tool: Pick<AnyToolDefinition, "name" | "effect" | "permission">
): { name: string; effect: OperationEffect; defaultPolicy: PolicyValue } {
  return {
    name: tool.name,
    effect: tool.effect,
    defaultPolicy: declaredPolicy(tool.permission?.mode)
  };
}

/** What a tool's mode is as the declared default policy of its operation. */
function declaredPolicy(mode: ToolPermissionMode | undefined): PolicyValue {
  switch (mode) {
    case "deny":
      return "deny";
    case "approval_required":
      return "approval";
    case "allow":
    case undefined:
      return "allow";
  }
}

/**
 * An agent tool as the operation it is registered as. Its name is the operation's name, its
 * mode the declared default policy, and its permission references the rights its own check
 * asks for: a reference `x` is the action `ref:x`, so a tool definition can never ask for a
 * registered action through that field.
 */
export function toolOperation(
  tool: AnyToolDefinition,
  options: ToolOperationOptions
): OperationDefinition {
  const requiredPermissionRefs = tool.permission?.requiredPermissionRefs ?? [];
  return {
    ...toolOperationPolicy(tool),
    action: null,
    authorize(_input, context) {
      for (const permissionRef of requiredPermissionRefs) {
        const action = `${PERMISSION_REF_ACTION_PREFIX}${permissionRef}`;
        const decision = context.access.authorize(action);
        if (!decision.allowed) {
          return { allowed: false, action, reason: decision.reason };
        }
      }
      return { allowed: true };
    },
    scope: null,
    auth: "user",
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? z.unknown(),
    resource: () => undefined,
    timeoutMs: TOOL_OPERATION_TIMEOUT_MS,
    async execute(input, context) {
      const { request, toolContext } = toolCallOf(tool, input, context, options);
      try {
        const result = await tool.execute(input, toolContext);
        const validated =
          result.status === "success" && tool.outputSchema
            ? { ...result, output: tool.outputSchema.parse(result.output) }
            : result;
        return answerAsTool(validated);
      } catch (error) {
        return answerAsTool(
          error instanceof ZodError
            ? validationFailure(error.issues)
            : thrownHandlerFailure(error, request, toolContext, options.logger)
        );
      }
    }
  };
}

/** Registers every tool of the instance as an operation. An operation's name is taken once. */
export function registerToolOperations(
  registry: OperationRegistry,
  tools: readonly AnyToolDefinition[],
  options: ToolOperationOptions
): void {
  for (const tool of tools) {
    registry.register(toolOperation(tool, options));
  }
}

function toolCallOf(
  tool: AnyToolDefinition,
  input: unknown,
  context: OperationExecutionContext,
  options: ToolOperationOptions
): { request: ToolExecutionRequest; toolContext: ToolExecutionContext } {
  const { actor, origin } = context;
  if (origin.kind !== "agent" || isAuthenticatedServicePrincipal(actor)) {
    throw new AppError("FORBIDDEN", `'${tool.name}' is a tool of an agent that acts for a person`);
  }
  const request = toolRequestFromOperationCall({
    operation: tool.name,
    effect: tool.effect,
    input,
    actor,
    origin,
    correlationId: context.correlationId
  });
  return {
    request,
    toolContext: {
      user: actor,
      clientInstanceId: options.clientInstanceId,
      correlationId: context.correlationId,
      principal: actor.principal,
      subjectUserId: actor.subjectUserId,
      delegatedActor: actor.delegatedActor,
      scopes: actor.scopes,
      locale: context.runtime.locale,
      deadline: context.runtime.deadline,
      signal: context.runtime.signal,
      runFence: context.runtime.runFence,
      toolRequest: request,
      operationRun: {
        id: context.runId,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {})
      }
    }
  };
}

function validationFailure(
  issues: readonly { code?: string; path: readonly PropertyKey[]; message: string }[]
): ToolHandlerFailureResult {
  return failed("validation_failed", "Tool input or output failed validation", {
    issues: issues.map((issue) => ({
      code: issue.code ?? "invalid",
      path: issue.path.map(String).join("."),
      message: issue.message
    }))
  });
}

/**
 * What a thrown error may tell the model, by the rule of `toErrorEnvelope`: the message of an
 * `AppError` that exposes it. Any other error, a database driver's included, can carry SQL,
 * parameters or paths. The logger gets a record of it without those, and the model gets the
 * correlation id to quote.
 */
function thrownHandlerFailure(
  error: unknown,
  request: ToolExecutionRequest,
  context: ToolExecutionContext,
  logger: Logger | undefined
): ToolHandlerFailureResult {
  if (isAppError(error) && error.code !== "INTERNAL" && error.exposeMessage) {
    return failed("handler_failed", toErrorEnvelope(error, context.correlationId).error.message);
  }
  logger?.error(toolFailureLogRecord(error, request, context), "Tool handler failed");
  return internalFailure(context.correlationId);
}

function internalFailure(correlationId: string): ToolHandlerFailureResult {
  return failed(
    "handler_failed",
    `The tool failed with an internal error. Reference: ${correlationId}`,
    { correlationId }
  );
}

/** What the agent is told about the tool call it made. */
interface ToolCallNames {
  toolName: string;
  agentName: string;
  correlationId: string;
  /** The reason a tool's own definition gives for its mode, where it gives one. */
  policyReason?: string;
}

/**
 * Projects what a call came to back to the agent that made it as a tool call. A tool that ran
 * answers its own result unchanged. A call that was refused, held or cut off before the tool
 * ran answers in the words an agent has always read for it.
 */
export function toolResultFromOperationResult(
  outcome: OperationOutcome,
  names: ToolCallNames
): ToolExecutionResult {
  if (outcome.toolResult) {
    return outcome.toolResult;
  }
  const { result } = outcome;
  switch (result.status) {
    case "done":
      return {
        status: "success",
        output: result.output,
        ...(result.display ? { display: result.display } : {}),
        ...(result.structuredResult ? { structuredResult: result.structuredResult } : {}),
        ...(result.artifacts ? { artifacts: result.artifacts } : {})
      };
    case "denied":
      return failed("not_allowed", denialText(result.reason, names));
    case "pending_approval":
      return {
        status: "success",
        output: {
          requestId: result.approvalRequestId,
          status: "pending_approval",
          expiresAt: result.expiresAt,
          message:
            "This call has NOT run. It waits for a person's approval and runs once when it is approved. Do not repeat it; tell the user that it waits in the Inbox."
        },
        display: {
          kind: "catalyst.approval_request",
          version: 1,
          mode: "inline",
          data: { requestId: result.approvalRequestId, kind: OPERATION_CALL_APPROVAL_KIND }
        }
      };
    case "failed":
      return result.error.code === "INTERNAL"
        ? internalFailure(names.correlationId)
        : failed("handler_failed", result.error.message);
    case "expired":
    case "pending_confirmation":
      return internalFailure(names.correlationId);
  }
}

function denialText(denial: OperationDenial, names: ToolCallNames): string {
  if (denial.kind === "forbidden") {
    if (denial.action.startsWith(AGENT_TOOL_ACTION_PREFIX)) {
      return `Agent '${names.agentName}' is not allowed to use '${names.toolName}'`;
    }
    if (denial.action.startsWith(PERMISSION_REF_ACTION_PREFIX)) {
      return `User is missing permission '${denial.action.slice(PERMISSION_REF_ACTION_PREFIX.length)}'`;
    }
  }
  if (denial.kind === "policy") {
    return names.policyReason ?? `Tool '${names.toolName}' is denied by policy`;
  }
  return operationDenialError(denial).message;
}

const forbiddenDetailsSchema = z.object({
  action: z.string(),
  reason: z.enum(["no_grant", "denied", "unknown_action", "holder_inactive"])
});
const issuesSchema = z.object({
  issues: z.array(
    z.object({
      code: z.string().optional(),
      path: z.array(z.union([z.string(), z.number()])),
      message: z.string()
    })
  )
});

/**
 * The one way an agent's tool call is executed: as a call of the operation the tool is, on the
 * path every operation takes. The tool registry says which tools this process has; a tool it
 * does not have, or one of a module that is off, is not registered for the agent.
 */
export function createToolOperationRunner(
  deps: RunOperationDeps,
  tools: ToolRegistry
): ToolOperationRunner {
  return async (request, context, options = {}) => {
    const tool = tools.get(request.toolName);
    const names: ToolCallNames = {
      toolName: request.toolName,
      agentName: request.agentName,
      correlationId: context.correlationId,
      policyReason: tool?.permission?.mode === "deny" ? tool.permission.reason : undefined
    };
    if (!tool) {
      return failed("not_allowed", `Tool '${request.toolName}' is not registered`);
    }
    try {
      const outcome = await runOperation(
        operationCallFromToolRequest({
          request,
          // The run acts for the person it was started for, with what that start was allowed.
          actor: {
            ...context.user,
            ...(context.principal ? { principal: context.principal } : {}),
            ...(context.subjectUserId ? { subjectUserId: context.subjectUserId } : {}),
            ...(context.delegatedActor ? { delegatedActor: context.delegatedActor } : {}),
            ...(context.scopes ? { scopes: context.scopes } : {})
          },
          operation: tool.name,
          effect: tool.effect,
          correlationId: context.correlationId
        }),
        deps,
        {
          locale: context.locale,
          deadline: context.deadline,
          signal: context.signal,
          runFence: context.runFence,
          unreadableInput: options.unreadableInput
        }
      );
      return toolResultFromOperationResult(outcome, names);
    } catch (error) {
      const refused = refusalBeforeRun(error, names);
      if (!refused) throw error;
      return refused;
    }
  };
}

/** What a call that was refused before it had a run answers, or nothing for any other error. */
function refusalBeforeRun(
  error: unknown,
  names: ToolCallNames
): ToolHandlerFailureResult | undefined {
  if (!isAppError(error)) {
    return undefined;
  }
  if (error.code === "NOT_FOUND") {
    return failed("not_allowed", `Tool '${names.toolName}' is not registered`);
  }
  if (error.code === "FORBIDDEN") {
    const details = forbiddenDetailsSchema.safeParse(error.details);
    return details.success
      ? failed("not_allowed", denialText({ kind: "forbidden", ...details.data }, names))
      : undefined;
  }
  if (error.code === "VALIDATION_FAILED") {
    const details = issuesSchema.safeParse(error.details);
    const issues = details.success ? details.data.issues : [];
    const unreadable = issues.length === 1 && issues[0]?.path.length === 0 ? issues[0] : undefined;
    // An input the model wrote that could not be read at all answers what the reader said.
    return unreadable && error.message === unreadable.message
      ? failed("validation_failed", unreadable.message, { issues: issueDetails(issues) })
      : validationFailure(issues);
  }
  return undefined;
}

function issueDetails(
  issues: readonly { code?: string; path: readonly PropertyKey[]; message: string }[]
): JsonObject[] {
  return issues.map((issue) => ({
    code: issue.code ?? "invalid",
    path: issue.path.map(String).join("."),
    message: issue.message
  }));
}
