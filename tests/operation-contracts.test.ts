import { describe, expect, it } from "vitest";
import {
  asAgentRunId,
  asApiCredentialId,
  asClientInstanceId,
  asCollaborationWorkspaceId,
  asConversationId,
  asServicePrincipalId,
  asToolCallId,
  operationCallFromToolRequest,
  toolRequestFromOperationCall,
  type AuthenticatedServicePrincipal,
  type AuthenticatedUser,
  type ToolExecutionRequest
} from "@work-shape/catalyst-core";

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

  it.each([null, undefined, 0])("preserves input %j without optional context", (input) => {
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
  });
});
