import { ZodError } from "zod";
import {
  PERMISSION_REF_ACTION_PREFIX,
  createAuthorizer,
  isAppError,
  toErrorEnvelope,
  type Authorizer,
  type ApprovedToolExecutionRequest,
  type JsonObject,
  type Logger,
  type ModelUsageRecorder,
  type ToolAuthorizationDecision,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolExecutionResult,
  type ToolHandlerFailureResult
} from "@vivd-catalyst/core";
import {
  auditActorFromUser,
  getRuntimeSubjectUserId,
  type AuditRecorder
} from "@vivd-catalyst/core";
import type { ToolRegistry } from "./tool-registry";
import { toolFailureLogRecord } from "./tool-failure-log";
import { failed, toPreview } from "./tool-results";

export interface InProcessToolExecutionOptions {
  registry: ToolRegistry;
  getAgentToolNames(agentName: string): readonly string[] | Promise<readonly string[]>;
  auditRecorder?: AuditRecorder;
  usageRecorder?: ModelUsageRecorder;
  /** Receives the full error of a handler whose failure the model only sees as a reference. */
  logger?: Logger;
  /**
   * Answers the rights of the user a tool call runs for, loaded once per call. Without one the
   * user's own record is the only source, which is all a `permissionRefs` check reads.
   */
  authorizer?: Authorizer;
}

export class InProcessToolExecution implements ToolExecution {
  private readonly registry: ToolRegistry;
  private readonly getAgentToolNames: (
    agentName: string
  ) => readonly string[] | Promise<readonly string[]>;
  private readonly auditRecorder?: AuditRecorder;
  private readonly usageRecorder?: ModelUsageRecorder;
  private readonly logger?: Logger;
  private readonly authorizer: Authorizer;

  constructor(options: InProcessToolExecutionOptions) {
    this.registry = options.registry;
    this.getAgentToolNames = options.getAgentToolNames;
    this.auditRecorder = options.auditRecorder;
    this.usageRecorder = options.usageRecorder;
    this.logger = options.logger;
    this.authorizer = options.authorizer ?? createAuthorizer();
  }

  async authorize(
    request: ToolExecutionRequest,
    context: ToolExecutionContext
  ): Promise<ToolAuthorizationDecision> {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return this.auditAuthorizationDecision(
        { status: "denied", reason: `Tool '${request.toolName}' is not registered` },
        request,
        context
      );
    }

    const agentToolNames = await this.getAgentToolNames(request.agentName);
    if (!agentToolNames.includes(request.toolName)) {
      return this.auditAuthorizationDecision(
        {
          status: "denied",
          reason: `Agent '${request.agentName}' is not allowed to use '${request.toolName}'`
        },
        request,
        context
      );
    }

    // A tool's reference `x` is the action `ref:x`, so a tool definition can never ask for a
    // registered action through this field.
    const requiredPermissionRefs = tool.permission?.requiredPermissionRefs ?? [];
    const access =
      requiredPermissionRefs.length > 0 ? await this.authorizer.forActor(context.user) : undefined;
    const missingPermission = requiredPermissionRefs.find(
      (permissionRef) =>
        !access?.authorize(`${PERMISSION_REF_ACTION_PREFIX}${permissionRef}`).allowed
    );
    if (missingPermission) {
      return this.auditAuthorizationDecision(
        {
          status: "denied",
          reason: `User is missing permission '${missingPermission}'`
        },
        request,
        context
      );
    }

    if (tool.permission?.mode === "deny") {
      return this.auditAuthorizationDecision(
        {
          status: "denied",
          reason: tool.permission.reason ?? `Tool '${request.toolName}' is denied by policy`
        },
        request,
        context
      );
    }

    if (tool.permission?.mode === "approval_required" && !context.permissionDecision?.approved) {
      return this.auditAuthorizationDecision(
        {
          status: "requires_approval",
          reason: tool.permission.reason ?? `Tool '${request.toolName}' requires explicit approval`,
          preview: toPreview(request.input)
        },
        request,
        context
      );
    }

    return this.auditAuthorizationDecision(
      { status: "allowed", reason: tool.permission?.reason },
      request,
      context
    );
  }

  async execute(
    request: ApprovedToolExecutionRequest,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const tool = this.registry.get(request.toolName);
    if (!tool) {
      return failed("tool_not_found", `Tool '${request.toolName}' is not registered`);
    }

    await this.audit("tool.started", "success", request, context);
    try {
      const input = tool.inputSchema.parse(request.input);
      const result = await tool.execute(input, { ...context, toolRequest: request });
      const validated =
        result.status === "success" && tool.outputSchema
          ? {
              ...result,
              output: tool.outputSchema.parse(result.output)
            }
          : result;

      const publicResult = await this.recordAndRemoveModelUsage(validated, request, context);

      await this.audit(
        "tool.completed",
        publicResult.status === "success" ? "success" : "failed",
        request,
        context,
        {
          resultStatus: publicResult.status,
          ...toolAuditSummaryMetadata(publicResult.auditSummary)
        }
      );
      return publicResult;
    } catch (error) {
      const result =
        error instanceof ZodError
          ? failed("validation_failed", "Tool input or output failed validation", {
              issues: error.issues.map((issue) => ({
                code: issue.code,
                path: issue.path.join("."),
                message: issue.message
              }))
            })
          : this.thrownHandlerFailure(error, request, context);

      await this.audit("tool.failed", "failed", request, context, {
        code: result.error.code
      });
      return result;
    }
  }

  /**
   * What a thrown error may tell the model, by the rule of `toErrorEnvelope`: the message of an
   * `AppError` that exposes it. Any other error, a database driver's included, can carry SQL,
   * parameters or paths. The logger gets a record of it without those, and the model gets the
   * correlation id to quote.
   */
  private thrownHandlerFailure(
    error: unknown,
    request: ToolExecutionRequest,
    context: ToolExecutionContext
  ): ToolHandlerFailureResult {
    if (isAppError(error) && error.code !== "INTERNAL" && error.exposeMessage) {
      return failed("handler_failed", toErrorEnvelope(error, context.correlationId).error.message);
    }
    this.logger?.error(toolFailureLogRecord(error, request, context), "Tool handler failed");
    return failed(
      "handler_failed",
      `The tool failed with an internal error. Reference: ${context.correlationId}`,
      { correlationId: context.correlationId }
    );
  }

  private async recordAndRemoveModelUsage(
    result: ToolExecutionResult,
    request: ToolExecutionRequest,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    if (result.status !== "success" || !result.modelUsage) {
      return result;
    }
    const usageRecorder = this.usageRecorder;
    if (!usageRecorder) {
      throw new Error("Tool-reported model usage requires a configured usage recorder");
    }
    const { modelUsage, ...publicResult } = result;
    await Promise.all(
      modelUsage.map((usage) =>
        usageRecorder.recordModelUsage({
          clientInstanceId: context.clientInstanceId,
          attribution: {
            kind: "agent_run",
            conversationId: request.conversationId,
            runId: request.agentRunId,
            agentName: request.agentName,
            userId: getRuntimeSubjectUserId(context)
          },
          providerId: usage.providerId,
          model: usage.model,
          inputTokens: usage.inputTokens,
          ...(usage.cachedInputTokens !== undefined
            ? { cachedInputTokens: usage.cachedInputTokens }
            : {}),
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          source: usage.source,
          ...(usage.webSearchCallCount !== undefined
            ? { webSearchCallCount: usage.webSearchCallCount }
            : {}),
          correlationId: context.correlationId
        })
      )
    );
    return publicResult;
  }

  private async audit(
    type: string,
    status: "success" | "failed" | "denied",
    request: ToolExecutionRequest,
    context: ToolExecutionContext,
    metadata: JsonObject = {}
  ): Promise<void> {
    await this.auditRecorder?.record({
      type,
      status,
      actor: auditActorFromUser(context.user),
      subject: request.toolName,
      correlationId: context.correlationId,
      metadata: {
        ...metadata,
        agentName: request.agentName,
        conversationId: request.conversationId,
        toolCallId: request.toolCallId
      }
    });
  }

  private async auditAuthorizationDecision(
    decision: ToolAuthorizationDecision,
    request: ToolExecutionRequest,
    context: ToolExecutionContext
  ): Promise<ToolAuthorizationDecision> {
    await this.audit(
      "tool.authorization_checked",
      decision.status === "allowed" ? "success" : "denied",
      request,
      context,
      {
        authorizationStatus: decision.status,
        ...(decision.reason ? { reason: decision.reason } : {})
      }
    );
    return decision;
  }
}

function toolAuditSummaryMetadata(
  summary: ToolExecutionResult["auditSummary"] | undefined
): JsonObject {
  if (!summary) {
    return {};
  }
  return {
    auditAction: summary.action,
    ...(summary.subject ? { auditSubject: summary.subject } : {}),
    ...(summary.metadata ? { auditMetadata: summary.metadata } : {})
  };
}
