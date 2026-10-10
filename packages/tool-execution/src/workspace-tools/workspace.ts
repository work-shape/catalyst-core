import {
  type ConversationId,
  type ExecutionWorkspaceId,
  type ToolExecutionContext,
  type WorkspaceHandle,
  type WorkspaceFile,
  getRuntimeSubjectUserId
} from "@vivd-catalyst/core";
import { failed, failedValidationResult, type ValidationResult } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";

/** The handle a tool addresses, with the conversation its workspace record names. */
interface ResolvedWorkspace {
  readonly handle: WorkspaceHandle;
  /** Attribution for the rows and objects a tool writes; never the address. */
  readonly conversationId: ConversationId;
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
      workspaceId: workspace.value.handle.id
    }
  };
}

/** Ensures the Execution Workspace of the tool call's conversation and returns its handle. */
export async function resolveWorkspaceHandle(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext
): Promise<ValidationResult<ResolvedWorkspace>> {
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
      handle: { kind: "execution_workspace", id: workspace.id },
      conversationId: workspace.conversationId
    }
  };
}
