import type {
  ConversationId,
  ExecutionWorkspaceId,
  ResolvedWorkspaceHandle,
  ToolExecutionContext,
  WorkspaceHandle,
  WorkspaceFile
} from "@vivd-catalyst/core";
import { failed, failedValidationResult, type ValidationResult } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";

export async function findWorkspaceFile(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext,
  filePath: string
): Promise<ValidationResult<{ file: WorkspaceFile; handle: WorkspaceHandle }>> {
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace;
  }
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.value.handle.id
  });
  const file = files.find((candidate) => candidate.path === filePath);
  if (!file) {
    return workspaceFileNotFound(filePath);
  }
  return {
    status: "success",
    value: {
      file,
      handle: workspace.value.handle
    }
  };
}

/**
 * The conversation's Execution Workspace for a reading tool: looked up, never created.
 * `workspaceId` is absent when the conversation has none yet.
 */
export async function findExistingWorkspace(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext
): Promise<
  ValidationResult<{ conversationId: ConversationId; workspaceId?: ExecutionWorkspaceId }>
> {
  const conversationId = context.toolRequest?.conversationId;
  if (!conversationId) {
    return failedValidationResult(
      "Workspace tools work only inside a conversation. Call this tool from an agent run of a conversation."
    );
  }
  const workspace = await deps.store.executionWorkspaces.getExecutionWorkspaceForConversation({
    clientInstanceId: context.clientInstanceId,
    conversationId
  });
  return {
    status: "success",
    value: { conversationId, ...(workspace ? { workspaceId: workspace.id } : {}) }
  };
}

/** Finds a file for a reading tool. A conversation without a workspace has no such file. */
export async function findExistingWorkspaceFile(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext,
  filePath: string
): Promise<ValidationResult<{ file: WorkspaceFile; workspaceId: ExecutionWorkspaceId }>> {
  const workspace = await findExistingWorkspace(deps, context);
  if (workspace.status === "failed") {
    return workspace;
  }
  const { workspaceId } = workspace.value;
  if (!workspaceId) {
    return workspaceFileNotFound(filePath);
  }
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId
  });
  const file = files.find((candidate) => candidate.path === filePath);
  return file
    ? { status: "success", value: { file, workspaceId } }
    : workspaceFileNotFound(filePath);
}

function workspaceFileNotFound(filePath: string): ValidationResult<never> {
  return {
    status: "failed",
    result: failed(
      "handler_failed",
      `Workspace file '${filePath}' was not found. Call workspace.list_files to see the paths that exist.`,
      { path: filePath }
    )
  };
}

/** Resolves the workspace handle or returns the tool's missing request failure. */
export async function resolveWorkspaceHandle(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext
): Promise<ValidationResult<ResolvedWorkspaceHandle>> {
  const workspace = await deps.workspaces.resolveWorkspaceHandle(context);
  if (!workspace) {
    return failedValidationResult("Workspace tools require an active tool request");
  }
  return {
    status: "success",
    value: workspace
  };
}
