import { ZodError } from "zod";
import {
  type ApprovedToolExecutionRequest,
  type JsonObject,
  type ToolAuthorizationDecision,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolExecutionRequest,
  type ToolExecutionResult
} from "@vivd-catalyst/core";
import { auditActorFromUser, type AuditRecorder } from "@vivd-catalyst/core";
import type { ToolRegistry } from "./tool-registry";
import { failed, toPreview } from "./tool-results";

export interface InProcessToolExecutionOptions {
  registry: ToolRegistry;
  getAgentToolNames(agentName: string): readonly string[] | Promise<readonly string[]>;
  auditRecorder?: AuditRecorder;
}

export class InProcessToolExecution implements ToolExecution {
  private readonly registry: ToolRegistry;
  private readonly getAgentToolNames: (
    agentName: string
  ) => readonly string[] | Promise<readonly string[]>;
  private readonly auditRecorder?: AuditRecorder;

  constructor(options: InProcessToolExecutionOptions) {
    this.registry = options.registry;
    this.getAgentToolNames = options.getAgentToolNames;
    this.auditRecorder = options.auditRecorder;
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

    const missingPermission = tool.permission?.requiredPermissionRefs?.find(
      (permissionRef) => !context.user.permissionRefs.includes(permissionRef)
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
          reason:
            tool.permission.reason ?? `Tool '${request.toolName}' requires explicit approval`,
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

      await this.audit("tool.completed", validated.status === "success" ? "success" : "failed", request, context, {
        resultStatus: validated.status,
        ...toolAuditSummaryMetadata(validated.auditSummary)
      });
      return validated;
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
          : failed("handler_failed", error instanceof Error ? error.message : "Tool handler failed");

      await this.audit("tool.failed", "failed", request, context, {
        code: result.error.code
      });
      return result;
    }
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
