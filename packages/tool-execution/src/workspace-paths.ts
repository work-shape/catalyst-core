import { resolve, sep } from "node:path";
import { posix as posixPath } from "node:path";
import type { JsonObject } from "@vivd-catalyst/core";

export interface WorkspacePathLimits {
  maxPathLength: number;
}

export type WorkspacePathValidationResult<T> =
  | {
      status: "success";
      value: T;
    }
  | {
      status: "failed";
      message: string;
      details?: JsonObject;
    };

export function normalizeWorkspaceFilePath(
  value: string,
  limits: WorkspacePathLimits
): WorkspacePathValidationResult<string> {
  const normalized = normalizeWorkspacePath(value, limits);
  if (normalized.status === "failed") {
    return normalized;
  }
  if (normalized.value === ".") {
    return workspacePathFailed("Workspace file path must name a file");
  }
  if (value.endsWith("/")) {
    return workspacePathFailed("Workspace file path must not end with a slash", { path: value });
  }
  return normalized;
}

export function normalizeWorkspaceDirectory(
  value: string,
  limits: WorkspacePathLimits
): WorkspacePathValidationResult<string> {
  return normalizeWorkspacePath(value, limits);
}

export function resolveWorkspaceFilesystemPath(
  workspaceDirectory: string,
  workspacePath: string,
  limits: WorkspacePathLimits
): WorkspacePathValidationResult<string> {
  const normalized = normalizeWorkspaceDirectory(workspacePath, limits);
  if (normalized.status === "failed") {
    return normalized;
  }
  const workspaceRoot = resolve(workspaceDirectory);
  const target = normalized.value === "."
    ? workspaceRoot
    : resolve(workspaceRoot, ...normalized.value.split("/"));
  if (target !== workspaceRoot && !target.startsWith(`${workspaceRoot}${sep}`)) {
    return workspacePathFailed("Workspace path cannot traverse outside the workspace", {
      path: workspacePath
    });
  }
  return {
    status: "success",
    value: target
  };
}

function normalizeWorkspacePath(
  value: string,
  limits: WorkspacePathLimits
): WorkspacePathValidationResult<string> {
  const trimmedInput = value.trim();
  const trimmed = trimmedInput === "/workspace"
    ? "."
    : trimmedInput.startsWith("/workspace/")
      ? trimmedInput.slice("/workspace/".length)
      : trimmedInput;
  if (trimmed.length === 0) {
    return workspacePathFailed("Workspace path cannot be blank");
  }
  if (trimmed.length > limits.maxPathLength) {
    return workspacePathFailed("Workspace path is too long", {
      maxPathLength: limits.maxPathLength
    });
  }
  if (trimmed.includes("\0")) {
    return workspacePathFailed("Workspace path cannot contain NUL bytes");
  }
  if (trimmed.startsWith("/") || trimmed.startsWith("\\") || /^[A-Za-z]:/u.test(trimmed)) {
    return workspacePathFailed("Workspace path must be relative", { path: value });
  }
  if (trimmed.includes("\\")) {
    return workspacePathFailed("Workspace path must use forward slashes", { path: value });
  }
  const normalized = posixPath.normalize(trimmed);
  if (normalized === ".." || normalized.startsWith("../")) {
    return workspacePathFailed("Workspace path cannot traverse outside the workspace", {
      path: value
    });
  }
  return {
    status: "success",
    value: normalized
  };
}

function workspacePathFailed(
  message: string,
  details?: JsonObject
): WorkspacePathValidationResult<never> {
  return {
    status: "failed",
    message,
    details
  };
}
