import type { z } from "zod";
import {
  type ClientInstanceId,
  type ExecutionWorkspaceId,
  type JsonObject,
  type ToolExecutionContext,
  type ToolHandlerResult,
  type WorkspaceCommand,
  type WorkspaceCommandLimits,
  type WorkspaceExpectedOutput,
  getRuntimeSubjectUserId,
  isAppError
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import type { WorkspaceCommandHandle, WorkspaceCommandResult } from "../workspace-command-client";
import {
  emitWorkspaceCommandTelemetry,
  recordWorkspaceCommandLifecycleAudit,
  workspaceCommandCountsMetadata,
  workspaceCommandTelemetryEvent
} from "../workspace-command-telemetry";
import {
  workspaceExecInputJsonSchema,
  workspaceExecInputSchema,
  workspaceExecOutputSchema
} from "../workspace-tool-schemas";
import {
  commandArtifacts,
  commandToExecOutput,
  failed,
  failedValidationResult,
  validateExpectedOutputResult,
  type ValidationResult
} from "../workspace-tool-results";
import type { WorkspaceToolDependencies, WorkspaceToolStore } from "./dependencies";
import { normalizeExecInput } from "./exec-input";
import { ensureWorkspace } from "./workspace";

export function workspaceExecTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.exec",
    description:
      "Run a bounded Bash command from /workspace in the conversation execution workspace. Each call starts in /workspace unless cwd is provided for that call; cwd, processes, and files outside /workspace do not persist. The standard project directories scripts, artifacts, previews, and tmp are available at the start of every command. Pass a complete shell command or multiline script. Files created or changed under /workspace persist across calls and stay internal until promoted. For multiline create-and-verify commands, put `set -e` on its own line before later commands so helpers do not run after a failed script. Run artifact helpers directly. Do not prefix helpers with `set -e`, and do not pass helper flags such as `--view`, `--spec`, `--out`, `--range`, `--page`, or `--sheet` to `cat`, `ls`, or `printf`.",
    inputSchema: workspaceExecInputSchema,
    outputSchema: workspaceExecOutputSchema,
    inputJsonSchema: workspaceExecInputJsonSchema,
    execute(input, context) {
      return execWorkspaceCommand(deps, input, context);
    }
  });
}

export async function execWorkspaceCommand(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceExecInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceExecOutputSchema>>> {
  const normalized = normalizeExecInput(deps, input);
  if (normalized.status === "failed") {
    return normalized.result;
  }
  const workspace = await ensureWorkspace(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }

  const queued = await enqueueCommand(deps, context, workspace.value.id, normalized.value);
  if (queued.status === "failed") {
    return queued.result;
  }
  await recordQueuedCommand(deps, context, queued.value.command);
  const resolvedBySource = await deps.commandResults?.resolveWorkspaceCommand({
    command: queued.value.command,
    context
  });
  if (resolvedBySource && resolvedBySource.id !== queued.value.command.id) {
    return failed("handler_failed", "Workspace command result source returned the wrong command");
  }
  const resultCommand = commandResultToToolResult(
    queued.value.command,
    await deps.commands.await(resolvedBySource ? { command: resolvedBySource } : queued.value, {
      signal: context.signal,
      deadline: context.deadline
    })
  );
  if (resultCommand.status === "failed") {
    return resultCommand.result;
  }
  const expectedOutputs = normalized.value.expectedOutputs;
  if (resultCommand.value.output) {
    const existingWorkspacePaths =
      expectedOutputs.length > 0
        ? new Set(
            (
              await deps.store.executionWorkspaces.listWorkspaceFiles({
                clientInstanceId: context.clientInstanceId,
                workspaceId: workspace.value.id
              })
            ).map((file) => file.path)
          )
        : new Set<string>();
    const expectedValidation = validateExpectedOutputResult(
      expectedOutputs,
      resultCommand.value.output,
      existingWorkspacePaths
    );
    if (expectedValidation) {
      return expectedValidation;
    }
  }

  const output = commandToExecOutput(resultCommand.value, workspace.value.id);
  const artifacts = commandArtifacts(resultCommand.value);
  return toolSuccess(output, {
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    auditSummary: {
      action: "workspace.exec",
      subject: resultCommand.value.id,
      metadata: {
        status: resultCommand.value.status,
        timeoutSeconds: resultCommand.value.limits.timeoutSeconds
      }
    }
  });
}

async function enqueueCommand(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext,
  workspaceId: ExecutionWorkspaceId,
  command: {
    command: string;
    cwd?: string;
    limits: WorkspaceCommandLimits;
    expectedOutputs: WorkspaceExpectedOutput[];
  }
): Promise<ValidationResult<WorkspaceCommandHandle>> {
  try {
    return {
      status: "success",
      value: await deps.commands.enqueue({
        clientInstanceId: context.clientInstanceId,
        workspaceId,
        ownerUserId: getRuntimeSubjectUserId(context),
        agentRunId: context.toolRequest?.agentRunId,
        toolCallId: context.toolRequest?.toolCallId,
        command: command.command,
        cwd: command.cwd,
        limits: command.limits,
        expectedOutputs: command.expectedOutputs
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

function commandResultToToolResult(
  queued: WorkspaceCommand,
  result: WorkspaceCommandResult
): ValidationResult<WorkspaceCommand> {
  switch (result.status) {
    case "settled":
      return { status: "success", value: result.command };
    case "missing":
      return failedValidationResult("Workspace command is no longer available", {
        commandId: queued.id
      });
    case "cancelled":
    case "timed_out":
      return {
        status: "failed",
        result: {
          status: result.status,
          error: {
            code: result.status,
            message: result.reason,
            details: {
              commandId: queued.id,
              status: result.command.status
            }
          }
        }
      };
    case "wait_limit":
      return failedValidationResult(result.reason, {
        commandId: queued.id,
        status: result.command.status,
        ...(result.waitMs !== undefined ? { waitMs: result.waitMs } : {})
      });
  }
}

async function recordQueuedCommand(
  deps: WorkspaceToolDependencies,
  context: ToolExecutionContext,
  command: WorkspaceCommand
): Promise<void> {
  const activeCounts = await readActiveCommandCounts(deps, context.clientInstanceId);
  await recordWorkspaceCommandLifecycleAudit({
    auditRecorder: deps.auditRecorder,
    type: "workspace_command.queued",
    status: "success",
    command,
    user: context.user,
    correlationId: context.correlationId,
    metadata: {
      timeoutSeconds: command.limits.timeoutSeconds,
      expectedOutputCount: command.expectedOutputs.length,
      promotedExpectedOutputCount: command.expectedOutputs.filter((output) => output.promote)
        .length,
      cwdProvided: command.cwd !== undefined,
      ...(activeCounts ? { activeCounts: workspaceCommandCountsMetadata(activeCounts) } : {})
    }
  });
  await emitWorkspaceCommandTelemetry(
    deps.telemetry,
    workspaceCommandTelemetryEvent("queued", command, {
      activeCounts
    })
  );
}

async function readActiveCommandCounts(
  deps: WorkspaceToolDependencies,
  clientInstanceId: ClientInstanceId
): Promise<
  | Awaited<ReturnType<WorkspaceToolStore["executionWorkspaces"]["countActiveWorkspaceCommands"]>>
  | undefined
> {
  try {
    return await deps.store.executionWorkspaces.countActiveWorkspaceCommands({
      clientInstanceId
    });
  } catch {
    return undefined;
  }
}
