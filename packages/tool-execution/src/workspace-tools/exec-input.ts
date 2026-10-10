import type { z } from "zod";
import type { WorkspaceCommandLimits, WorkspaceExpectedOutput } from "@vivd-catalyst/core";
import { validateWorkspaceShellCommand } from "../workspace-command-validation";
import type {
  expectedOutputInputSchema,
  workspaceExecInputSchema
} from "../workspace-tool-schemas";
import {
  normalizeWorkspaceDirectory,
  normalizeWorkspaceFilePath,
  validationFailed,
  type ValidationResult
} from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";

export function normalizeExecInput(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceExecInputSchema>
): ValidationResult<{
  command: string;
  cwd?: string;
  limits: WorkspaceCommandLimits;
  expectedOutputs: WorkspaceExpectedOutput[];
}> {
  const command = input.command.trim();
  if (command.length === 0) {
    return validationFailed("Workspace command cannot be blank");
  }
  if (command.includes("\0")) {
    return validationFailed("Workspace command cannot contain NUL bytes");
  }
  if (command.length > deps.limits.maxCommandLength) {
    return validationFailed("Workspace command is too long", {
      maxCommandLength: deps.limits.maxCommandLength
    });
  }
  const commandUsage = validateWorkspaceShellCommand(command);
  if (commandUsage.status === "failed") {
    return commandUsage;
  }
  const cwd = input.cwd ? normalizeWorkspaceDirectory(input.cwd, deps.limits) : undefined;
  if (cwd?.status === "failed") {
    return cwd;
  }
  const limits = resolveCommandLimits(deps, input.timeoutSeconds);
  if (limits.status === "failed") {
    return limits;
  }
  const expectedOutputs = normalizeExpectedOutputs(deps, input.expectedOutputs ?? []);
  if (expectedOutputs.status === "failed") {
    return expectedOutputs;
  }
  return {
    status: "success",
    value: {
      command,
      cwd: cwd?.value === "." ? undefined : cwd?.value,
      limits: limits.value,
      expectedOutputs: expectedOutputs.value
    }
  };
}

function resolveCommandLimits(
  deps: WorkspaceToolDependencies,
  timeoutSeconds: number | undefined
): ValidationResult<WorkspaceCommandLimits> {
  const resolvedTimeout = timeoutSeconds ?? deps.limits.defaultTimeoutSeconds;
  if (resolvedTimeout > deps.limits.maxTimeoutSeconds) {
    return validationFailed("Workspace command timeout exceeds the configured maximum", {
      timeoutSeconds: resolvedTimeout,
      maxTimeoutSeconds: deps.limits.maxTimeoutSeconds
    });
  }
  return {
    status: "success",
    value: {
      timeoutSeconds: resolvedTimeout,
      idleTimeoutSeconds: deps.limits.idleTimeoutSeconds,
      maxStdoutBytes: deps.limits.maxStdoutBytes,
      maxStderrBytes: deps.limits.maxStderrBytes,
      maxWorkspaceBytes: deps.limits.maxWorkspaceBytes
    }
  };
}

function normalizeExpectedOutputs(
  deps: WorkspaceToolDependencies,
  outputs: readonly z.infer<typeof expectedOutputInputSchema>[]
): ValidationResult<WorkspaceExpectedOutput[]> {
  if (outputs.length > deps.limits.maxExpectedOutputs) {
    return validationFailed("Too many expected workspace outputs", {
      maxExpectedOutputs: deps.limits.maxExpectedOutputs
    });
  }
  const seenPaths = new Set<string>();
  const normalized: WorkspaceExpectedOutput[] = [];
  for (const output of outputs) {
    const normalizedPath = normalizeWorkspaceFilePath(output.path, deps.limits);
    if (normalizedPath.status === "failed") {
      return normalizedPath;
    }
    if (seenPaths.has(normalizedPath.value)) {
      return validationFailed("Expected workspace output paths must be unique", {
        path: normalizedPath.value
      });
    }
    seenPaths.add(normalizedPath.value);
    normalized.push({
      path: normalizedPath.value,
      kind: output.kind,
      promote: output.promote ?? false
    });
  }
  return {
    status: "success",
    value: normalized
  };
}
