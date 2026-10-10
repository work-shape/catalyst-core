import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asExecutionWorkspaceId,
  asToolCallId,
  type ExecutionWorkspace,
  type ExecutionWorkspaceMetadataStore,
  type ToolExecutionContext
} from "@vivd-catalyst/core";
import { createExecutionWorkspaceHandleResolver } from "@vivd-catalyst/tool-execution";
import { describe, expect, it, vi } from "vitest";

function createFixture() {
  const now = "2026-10-10T10:00:00.000Z";
  const context: ToolExecutionContext = {
    clientInstanceId: asClientInstanceId("workspace_resolver"),
    correlationId: "workspace_resolver",
    user: {
      id: "owner",
      externalUserId: "external_owner",
      displayLabel: "Owner",
      roles: [],
      permissionRefs: [],
      clientInstanceId: asClientInstanceId("workspace_resolver"),
      authSource: "test"
    }
  };
  const workspace: ExecutionWorkspace = {
    id: asExecutionWorkspaceId("workspace_record"),
    clientInstanceId: context.clientInstanceId,
    conversationId: asConversationId("record_conversation"),
    ownerUserId: "owner",
    status: "active",
    createdAt: now,
    updatedAt: now
  };
  const ensure = vi
    .fn<ExecutionWorkspaceMetadataStore["ensureExecutionWorkspace"]>()
    .mockResolvedValue(workspace);
  const resolver = createExecutionWorkspaceHandleResolver({
    store: {
      ensureExecutionWorkspace: ensure,
      getExecutionWorkspace: async () => undefined,
      getExecutionWorkspaceForConversation: async () => undefined
    },
    now: () => now
  });
  return { resolver, ensure, workspace, context, now };
}

describe("the Execution Workspace handle resolver", () => {
  it("resolves the handle and attribution from the workspace record", async () => {
    const { resolver, ensure, workspace, context, now } = createFixture();
    const requestConversationId = asConversationId("request_conversation");

    await expect(
      resolver.resolveWorkspaceHandle({
        ...context,
        toolRequest: {
          toolName: "workspace.list_files",
          toolCallId: asToolCallId("workspace_resolver_call"),
          agentRunId: asAgentRunId("workspace_resolver_run"),
          conversationId: requestConversationId,
          agentName: "workspace_agent",
          input: {}
        }
      })
    ).resolves.toEqual({
      handle: { kind: "execution_workspace", id: workspace.id },
      conversationId: workspace.conversationId
    });
    expect(ensure).toHaveBeenCalledExactlyOnceWith({
      clientInstanceId: context.clientInstanceId,
      conversationId: requestConversationId,
      ownerUserId: workspace.ownerUserId,
      now
    });
  });

  it("does not ensure a workspace for a call without a tool request", async () => {
    const { resolver, ensure, context } = createFixture();

    await expect(resolver.resolveWorkspaceHandle(context)).resolves.toBeUndefined();
    expect(ensure).not.toHaveBeenCalled();
  });
});
