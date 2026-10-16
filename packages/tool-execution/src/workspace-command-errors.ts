import {
  type JsonObject,
  type WorkspaceCommandError,
  type WorkspaceCommandFailureCategory
} from "@work-shape/catalyst-core";

export class WorkspaceRunnerFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly category: WorkspaceCommandFailureCategory,
    readonly details?: JsonObject
  ) {
    super(message);
  }
}

export function toWorkspaceCommandError(error: unknown): WorkspaceCommandError {
  if (error instanceof WorkspaceRunnerFailure) {
    return workspaceCommandError(error.code, error.message, error.category, error.details);
  }
  return workspaceCommandError(
    "WORKSPACE_COMMAND_RUNNER_ERROR",
    error instanceof Error ? error.message : "Workspace command runner failed",
    "internal_error"
  );
}

export function workspaceCommandError(
  code: string,
  message: string,
  category: WorkspaceCommandFailureCategory,
  details?: JsonObject
): WorkspaceCommandError {
  return {
    code,
    message,
    category,
    details
  };
}
