import type {
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
    return {
      status: "failed",
      result: failed("handler_failed", `Workspace file '${filePath}' was not found`)
    };
  }
  return {
    status: "success",
    value: {
      file,
      handle: workspace.value.handle
    }
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
