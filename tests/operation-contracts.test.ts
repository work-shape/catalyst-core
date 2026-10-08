import { describe, expect, expectTypeOf, it } from "vitest";
import {
  asAgentRunId,
  asApiCredentialId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  asServicePrincipalId,
  asToolCallId,
  createPlatformId,
  operationCallFromToolRequest,
  toolRequestFromOperationCall,
  type AccessDecision,
  type AccessResource,
  type AccessStore,
  type ActorAccess,
  type AuthenticatedIdentity,
  type AuthenticatedServicePrincipal,
  type AuthenticatedUser,
  type Authorizer,
  type FirstPartyAuthScope,
  type OperationCall,
  type OperationDenial,
  type ISODateString,
  type ManagedArtifactRef,
  type StructuredResultPublication,
  type ToolDisplayOutput,
  type OperationOrigin,
  type OperationResult,
  type OperationRunId,
  type OperationScope,
  type PersistedAccess,
  type ToolExecutionRequest
} from "@vivd-catalyst/core";

const clientInstanceId = asClientInstanceId("instance");
const user: AuthenticatedUser = {
  id: "user",
  externalUserId: "external-user",
  displayLabel: "User",
  roles: ["user"],
  permissionRefs: [],
  clientInstanceId,
  authSource: "test"
};
const service: AuthenticatedServicePrincipal = {
  kind: "service",
  id: asServicePrincipalId("service"),
  credentialId: asApiCredentialId("credential"),
  displayLabel: "Release service",
  permissionRefs: [],
  permissions: ["config_assets.release"],
  clientInstanceId,
  authSource: "test",
  scopes: ["config_assets:release"]
};

describe("operation contracts", () => {
  it.each([
    { name: "user", actor: user },
    { name: "service principal", actor: service }
  ])("round-trips every tool request field with a $name actor", ({ actor }) => {
    const request: ToolExecutionRequest = {
      toolName: "configuration.read",
      toolCallId: asToolCallId("call"),
      agentRunId: asAgentRunId("run"),
      conversationId: asConversationId("conversation"),
      agentName: "builder",
      input: { names: ["agent"], nested: { enabled: true }, missing: undefined }
    };
    const original = structuredClone(request);
    const call = operationCallFromToolRequest({
      request,
      actor,
      operation: "assets.get",
      effect: "reading",
      correlationId: "correlation",
      workspaceId: asCollaborationWorkspaceId("workspace"),
      idempotencyKey: "idempotency"
    });

    expect(call.actor).toBe(actor);
    expect(call.input).toBe(request.input);
    expect(call.operation).toBe("assets.get");
    expect(call.effect).toBe("reading");
    expect(call.correlationId).toBe("correlation");
    expect(call.workspaceId).toBe("workspace");
    expect(call.idempotencyKey).toBe("idempotency");
    if (call.origin.kind !== "agent") {
      throw new Error("A tool request must project to an agent origin");
    }
    expect(toolRequestFromOperationCall({ ...call, origin: call.origin })).toStrictEqual(request);
    expect(request).toStrictEqual(original);
  });

  it.each([null, undefined, false, 0, "", [1, 2]])(
    "preserves input %j without optional context",
    (input) => {
      const request: ToolExecutionRequest = {
        toolName: "configuration.read",
        toolCallId: asToolCallId("call"),
        agentRunId: asAgentRunId("run"),
        conversationId: asConversationId("conversation"),
        agentName: "builder",
        input
      };
      const call = operationCallFromToolRequest({
        request,
        actor: user,
        operation: "assets.get",
        effect: "reading",
        correlationId: "correlation"
      });
      expect(call).not.toHaveProperty("workspaceId");
      expect(call).not.toHaveProperty("idempotencyKey");
      if (call.origin.kind !== "agent") throw new Error("Expected agent origin");
      expect(toolRequestFromOperationCall({ ...call, origin: call.origin })).toStrictEqual(request);
    }
  );

  it("accepts all seven origins at the shared call boundary", () => {
    const origins = [
      {
        kind: "agent",
        agentRunId: asAgentRunId("run"),
        conversationId: asConversationId("conversation"),
        agentName: "builder",
        toolCallId: asToolCallId("call"),
        toolName: "configuration.read"
      },
      { kind: "user" },
      { kind: "cli" },
      { kind: "mcp", clientName: "client" },
      {
        kind: "app",
        appRevisionId: "revision",
        actionName: "save",
        pageSessionId: "session",
        conversationId: asConversationId("conversation")
      },
      { kind: "workflow", workflowRunId: "workflow-run", stepRunId: "step-run" },
      { kind: "schedule", scheduleId: "schedule" }
    ] satisfies OperationOrigin[];
    const calls: OperationCall<{ name: string }>[] = origins.map((origin) => ({
      operation: "assets.get",
      effect: "reading",
      input: { name: "agent" },
      actor: service,
      origin,
      correlationId: "correlation"
    }));
    expect(calls.map((call) => call.origin.kind)).toEqual([
      "agent",
      "user",
      "cli",
      "mcp",
      "app",
      "workflow",
      "schedule"
    ]);
  });

  it("projects an independently constructed agent origin with every field intact", () => {
    const origin: Extract<OperationOrigin, { kind: "agent" }> = {
      kind: "agent",
      agentRunId: asAgentRunId("independent-run"),
      conversationId: asConversationId("independent-conversation"),
      agentName: "independent-agent",
      toolCallId: asToolCallId("independent-call"),
      toolName: "independent.tool"
    };
    const input = { nested: { value: 0 } };
    const call: OperationCall & { origin: typeof origin } = {
      operation: "assets.get",
      effect: "reading",
      input,
      actor: service,
      origin,
      correlationId: "correlation"
    };
    const original = structuredClone(call);
    const request = toolRequestFromOperationCall(call);
    expect(request).toStrictEqual({
      agentRunId: origin.agentRunId,
      conversationId: origin.conversationId,
      agentName: origin.agentName,
      toolCallId: origin.toolCallId,
      toolName: origin.toolName,
      input
    });
    expect(request.input).toBe(input);
    expect(call).toStrictEqual(original);
  });

  it("keeps omitted optional origin fields absent", () => {
    const mcp: Extract<OperationOrigin, { kind: "mcp" }> = { kind: "mcp" };
    const app: Extract<OperationOrigin, { kind: "app" }> = {
      kind: "app",
      appRevisionId: "revision",
      actionName: "save",
      pageSessionId: "session"
    };
    const calls: OperationCall[] = [mcp, app].map((origin) => ({
      operation: "assets.get",
      effect: "reading",
      input: {},
      actor: user,
      origin,
      correlationId: "correlation"
    }));
    expect(calls.map((call) => call.origin)).toStrictEqual([
      { kind: "mcp" },
      { kind: "app", appRevisionId: "revision", actionName: "save", pageSessionId: "session" }
    ]);
    expect(calls[0]?.origin).not.toHaveProperty("clientName");
    expect(calls[1]?.origin).not.toHaveProperty("conversationId");
  });

  it("constructs every result and denial variant with the ruled fields", () => {
    const forbidden: Extract<OperationDenial, { kind: "forbidden" }> = {
      kind: "forbidden",
      action: "assets.get",
      reason: "no_grant"
    };
    const policy: Extract<OperationDenial, { kind: "policy" }> = {
      kind: "policy",
      operation: "assets.get"
    };
    const guardrail: Extract<OperationDenial, { kind: "guardrail" }> = {
      kind: "guardrail",
      guardrailId: "guardrail",
      message: "Blocked"
    };
    const declined: Extract<OperationDenial, { kind: "declined" }> = {
      kind: "declined",
      by: "reviewer",
      comment: "Declined"
    };
    const guardrailWithoutMessage: Extract<OperationDenial, { kind: "guardrail" }> = {
      kind: "guardrail",
      guardrailId: "guardrail"
    };
    const declinedWithoutComment: Extract<OperationDenial, { kind: "declined" }> = {
      kind: "declined",
      by: "reviewer"
    };
    const runId = createPlatformId<"OperationRunId">("operation");
    const done: Extract<OperationResult<string>, { status: "done" }> = {
      status: "done",
      runId,
      output: "output",
      display: { kind: "text", version: 1 },
      structuredResult: { key: "key", kind: "result", schemaVersion: 1, title: "Result", data: {} },
      artifacts: []
    };
    const doneWithoutOptionalFields: Extract<OperationResult<string>, { status: "done" }> = {
      status: "done",
      runId,
      output: "output"
    };
    const pendingConfirmation: Extract<OperationResult, { status: "pending_confirmation" }> = {
      status: "pending_confirmation",
      runId,
      expiresAt: "2026-10-08T12:00:00Z",
      preview: { name: "agent" },
      inputHash: "hash"
    };
    const pendingApproval: Extract<OperationResult, { status: "pending_approval" }> = {
      status: "pending_approval",
      runId,
      approvalRequestId: "approval",
      expiresAt: "2026-10-08T12:00:00Z"
    };
    const denied: Extract<OperationResult, { status: "denied" }> = {
      status: "denied",
      runId,
      reason: forbidden
    };
    const failed: Extract<OperationResult, { status: "failed" }> = {
      status: "failed",
      runId,
      error: { code: "ERROR", message: "Failed", details: { retry: false } }
    };
    const failedWithoutDetails: Extract<OperationResult, { status: "failed" }> = {
      status: "failed",
      runId,
      error: { code: "ERROR", message: "Failed" }
    };
    const expired: Extract<OperationResult, { status: "expired" }> = { status: "expired", runId };
    expect(
      [done, pendingConfirmation, pendingApproval, denied, failed, expired].map(
        (result) => result.status
      )
    ).toEqual(["done", "pending_confirmation", "pending_approval", "denied", "failed", "expired"]);
    expect([forbidden, policy, guardrail, declined].map((reason) => reason.kind)).toEqual([
      "forbidden",
      "policy",
      "guardrail",
      "declined"
    ]);
    expect(doneWithoutOptionalFields).toStrictEqual({ status: "done", runId, output: "output" });
    expect(failedWithoutDetails.error).not.toHaveProperty("details");
    expect(guardrailWithoutMessage).not.toHaveProperty("message");
    expect(declinedWithoutComment).not.toHaveProperty("comment");

    // Exact equality also rejects added fields and altered optionality.
    expectTypeOf<OperationDenial>().toEqualTypeOf<
      | {
          kind: "forbidden";
          action: string;
          reason: "no_grant" | "denied" | "unknown_action" | "holder_inactive";
        }
      | { kind: "policy"; operation: string }
      | { kind: "guardrail"; guardrailId: string; message?: string }
      | { kind: "declined"; by: string; comment?: string }
    >();
    expectTypeOf<OperationResult<string>>().toEqualTypeOf<
      | {
          status: "done";
          runId: OperationRunId;
          output: string;
          display?: ToolDisplayOutput;
          structuredResult?: StructuredResultPublication;
          artifacts?: ManagedArtifactRef[];
        }
      | {
          status: "pending_confirmation";
          runId: OperationRunId;
          expiresAt: ISODateString;
          preview: unknown;
          inputHash: string;
        }
      | {
          status: "pending_approval";
          runId: OperationRunId;
          approvalRequestId: string;
          expiresAt: ISODateString;
        }
      | { status: "denied"; runId: OperationRunId; reason: OperationDenial }
      | {
          status: "failed";
          runId: OperationRunId;
          error: { code: string; message: string; details?: Record<string, unknown> };
        }
      | { status: "expired"; runId: OperationRunId }
    >();
  });

  it("pins the result and authorization type boundaries", () => {
    expectTypeOf<OperationCall["actor"]>().toEqualTypeOf<AuthenticatedIdentity>();
    expectTypeOf<OperationResult["runId"]>().toEqualTypeOf<OperationRunId>();
    expectTypeOf<OperationResult["status"]>().toEqualTypeOf<
      "done" | "pending_confirmation" | "pending_approval" | "denied" | "failed" | "expired"
    >();
    expectTypeOf<OperationScope>().toEqualTypeOf<Exclude<FirstPartyAuthScope, "*">>();
    expectTypeOf<Authorizer["forActor"]>().parameter(0).toEqualTypeOf<AuthenticatedIdentity>();
    expectTypeOf<Authorizer["forActor"]>().returns.toEqualTypeOf<Promise<ActorAccess>>();
    expectTypeOf<ActorAccess["authorize"]>().parameters.toEqualTypeOf<
      [action: string, resource?: AccessResource]
    >();
    expectTypeOf<ActorAccess["authorize"]>().returns.toEqualTypeOf<AccessDecision>();
    expectTypeOf<AccessStore["loadPersistedAccess"]>().returns.toEqualTypeOf<
      Promise<PersistedAccess>
    >();
  });
});
