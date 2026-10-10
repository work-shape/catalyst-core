import {
  type ConversationId,
  type ExecutionWorkspaceId,
  type ToolExecutionContext,
  type WorkspaceFile,
  getRuntimeSubjectUserId
} from "@vivd-catalyst/core";
import { failed, failedValidationResult, type ValidationResult } from "../workspace-tool-results";
import type { WorkspaceToolDependencies, WorkspaceToolStore } from "./dependencies";

export async function findWorkspaceFile(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext,
  filePath: string
): Promise<
  ValidationResult<{
    file: WorkspaceFile;
    workspaceId: ExecutionWorkspaceId;
    conversationId: ConversationId;
  }>
> {
  const workspace = await ensureWorkspace(deps, context);
  if (workspace.status === "failed") {
    return workspace;
  }
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.value.id
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
      workspaceId: workspace.value.id,
      conversationId: workspace.value.conversationId
    }
  };
}

export async function ensureWorkspace(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext
): Promise<
  ValidationResult<
    Awaited<ReturnType<WorkspaceToolStore["executionWorkspaces"]["ensureExecutionWorkspace"]>>
  >
> {
  const conversationId = context.toolRequest?.conversationId;
  if (!conversationId) {
    return failedValidationResult("Workspace tools require an active tool request");
  }
  return {
    status: "success",
    value: await deps.store.executionWorkspaces.ensureExecutionWorkspace({
      clientInstanceId: context.clientInstanceId,
      conversationId,
      ownerUserId: getRuntimeSubjectUserId(context),
      now: deps.now()
    })
  };
}
