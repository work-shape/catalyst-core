import {
  type ConversationId,
  type ExecutionWorkspaceId,
  type ToolExecutionContext,
  type WorkspaceFile,
  getRuntimeSubjectUserId
} from "@vivd-catalyst/core";
import { failed, failedValidationResult, type ValidationResult } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";

/**
 * The workspace a tool works in, and what holds it. A tool addresses files and commands by
 * `workspaceId`. The conversation's Execution Workspace is the only holder today.
 */
export interface WorkspaceHandle {
  readonly workspaceId: ExecutionWorkspaceId;
  readonly holder: { readonly kind: "conversation"; readonly id: ConversationId };
}

export async function findWorkspaceFile(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext,
  filePath: string
): Promise<ValidationResult<{ file: WorkspaceFile; workspaceId: ExecutionWorkspaceId }>> {
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace;
  }
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.value.workspaceId
  });
  const file = files.find((candidate) => candidate.path === filePath);
  if (!file) {
    return {
      status: "failed",
      result: failed("handler_failed", `Workspace file '${filePath}' was not found`)
    };
  }
  return {
    status: "success",
    value: {
      file,
      workspaceId: workspace.value.workspaceId
    }
  };
}

/** Ensures the Execution Workspace of the tool call's conversation and returns its handle. */
export async function resolveWorkspaceHandle(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext
): Promise<ValidationResult<WorkspaceHandle>> {
  const conversationId = context.toolRequest?.conversationId;
  if (!conversationId) {
    return failedValidationResult("Workspace tools require an active tool request");
  }
  const workspace = await deps.store.executionWorkspaces.ensureExecutionWorkspace({
    clientInstanceId: context.clientInstanceId,
    conversationId,
    ownerUserId: getRuntimeSubjectUserId(context),
    now: deps.now()
  });
  return {
    status: "success",
    value: {
      workspaceId: workspace.id,
      holder: { kind: "conversation", id: workspace.conversationId }
    }
  };
}
