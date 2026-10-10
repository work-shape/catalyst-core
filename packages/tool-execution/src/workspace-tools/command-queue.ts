import {
  type ExecutionWorkspaceId,
  type JsonObject,
  type ToolExecutionContext,
  type WorkspaceCommand,
  type WorkspaceCommandLimits,
  type WorkspaceExpectedOutput,
  getRuntimeSubjectUserId,
  isAppError
} from "@vivd-catalyst/core";
import { failed, failedValidationResult, type ValidationResult } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";

export async function enqueueCommand(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext,
  workspaceId: ExecutionWorkspaceId,
  command: {
    command: string;
    cwd?: string;
    limits: WorkspaceCommandLimits;
    expectedOutputs: WorkspaceExpectedOutput[];
  }
): Promise<ValidationResult<WorkspaceCommand>> {
  try {
    return {
      status: "success",
      value: await deps.store.executionWorkspaces.enqueueWorkspaceCommand({
        clientInstanceId: context.clientInstanceId,
        workspaceId,
        ownerUserId: getRuntimeSubjectUserId(context),
        agentRunId: context.toolRequest?.agentRunId,
        toolCallId: context.toolRequest?.toolCallId,
        command: command.command,
        cwd: command.cwd,
        limits: command.limits,
        expectedOutputs: command.expectedOutputs,
        queuedAt: deps.now()
      })
    };
  } catch (error) {
    if (isAppError(error) && error.code === "CONFLICT") {
      return {
        status: "failed",
        result: failed("handler_failed", error.message, error.details as JsonObject | undefined)
      };
    }
    throw error;
  }
}

export async function resolveCommandResult(
  deps: WorkspaceToolDependencies,
  command: WorkspaceCommand,
  context: ToolExecutionContext
): Promise<ValidationResult<WorkspaceCommand>> {
  if (isTerminalWorkspaceCommand(command)) {
    return { status: "success", value: command };
  }

  if (deps.execResultWaitMs !== undefined && deps.execResultWaitMs <= 0) {
    return { status: "success", value: command };
  }

  const waitDeadlineMs =
    deps.execResultWaitMs === undefined ? undefined : Date.now() + deps.execResultWaitMs;
  const contextDeadlineMs = context.deadline?.getTime();
  let current = command;
  while (true) {
    if (context.signal?.aborted) {
      return cancelWaitingCommand(
        deps,
        command,
        "Workspace command was cancelled with its agent run",
        "cancelled"
      );
    }
    if (contextDeadlineMs !== undefined && Date.now() >= contextDeadlineMs) {
      return cancelWaitingCommand(
        deps,
        command,
        "Workspace command exceeded the tool execution deadline",
        "timed_out"
      );
    }
    if (waitDeadlineMs !== undefined && Date.now() >= waitDeadlineMs) {
      break;
    }
    const nextDeadlineMs = earliestDefined(waitDeadlineMs, contextDeadlineMs);
    await sleep(
      nextDeadlineMs === undefined
        ? deps.execResultPollIntervalMs
        : Math.min(deps.execResultPollIntervalMs, Math.max(1, nextDeadlineMs - Date.now())),
      context.signal
    );
    if (context.signal?.aborted) {
      continue;
    }
    const latest = await deps.store.executionWorkspaces.getWorkspaceCommand({
      clientInstanceId: command.clientInstanceId,
      commandId: command.id
    });
    if (!latest) {
      return failedValidationResult("Workspace command is no longer available", {
        commandId: command.id
      });
    }
    current = latest;
    if (isTerminalWorkspaceCommand(current)) {
      return { status: "success", value: current };
    }
  }

  const cancelled = await requestCommandCancellation(
    deps,
    command,
    "Workspace command did not complete before the tool wait limit"
  );
  if (cancelled.status === "completed" || cancelled.status === "failed") {
    return { status: "success", value: cancelled };
  }
  return failedValidationResult("Workspace command did not complete before the tool wait limit", {
    commandId: command.id,
    status: cancelled.status,
    ...(deps.execResultWaitMs !== undefined ? { waitMs: deps.execResultWaitMs } : {})
  });
}

async function cancelWaitingCommand(
  deps: WorkspaceToolDependencies,
  command: WorkspaceCommand,
  reason: string,
  resultStatus: "cancelled" | "timed_out"
): Promise<ValidationResult<WorkspaceCommand>> {
  const cancelled = await requestCommandCancellation(deps, command, reason);
  if (cancelled.status === "completed" || cancelled.status === "failed") {
    return { status: "success", value: cancelled };
  }
  return {
    status: "failed",
    result: {
      status: resultStatus,
      error: {
        code: resultStatus,
        message: reason,
        details: {
          commandId: command.id,
          status: cancelled.status
        }
      }
    }
  };
}

async function requestCommandCancellation(
  deps: WorkspaceToolDependencies,
  command: WorkspaceCommand,
  reason: string
): Promise<WorkspaceCommand> {
  try {
    return await deps.store.executionWorkspaces.requestWorkspaceCommandCancellation({
      clientInstanceId: command.clientInstanceId,
      commandId: command.id,
      reason,
      requestedAt: deps.now()
    });
  } catch (error) {
    if (isAppError(error) && error.code === "CONFLICT") {
      const latest = await deps.store.executionWorkspaces.getWorkspaceCommand({
        clientInstanceId: command.clientInstanceId,
        commandId: command.id
      });
      if (latest && isTerminalWorkspaceCommand(latest)) {
        return latest;
      }
    }
    throw error;
  }
}

function isTerminalWorkspaceCommand(command: WorkspaceCommand): boolean {
  return (
    command.status === "completed" || command.status === "failed" || command.status === "cancelled"
  );
}

function earliestDefined(left: number | undefined, right: number | undefined): number | undefined {
  if (left === undefined) {
    return right;
  }
  if (right === undefined) {
    return left;
  }
  return Math.min(left, right);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    }
  });
}
