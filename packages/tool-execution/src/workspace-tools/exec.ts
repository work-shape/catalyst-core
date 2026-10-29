import type { z } from "zod";
import {
  isJsonObject,
  type ClientInstanceId,
  type JsonObject,
  type PlatformToolFailureReason,
  type ToolExecutionContext,
  type ToolHandlerResult,
  type WorkspaceCommand,
  type WorkspaceCommandLimits,
  type WorkspaceExpectedOutput,
  type WorkspaceHandle,
  getRuntimeSubjectUserId,
  registerOperationStopResult,
  isAppError
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { runSkillMounts } from "../run-skills";
import { SKILL_MOUNT_FAILED_CODE } from "../skill-folder-cache";
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
import { resolveWorkspaceHandle } from "./workspace";

export function workspaceExecTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.exec",
    title: { en: "Run workspace command", de: "Befehl ausführen" },
    summary: {
      en: "Runs commands and scripts on the conversation's files, for example to calculate or convert.",
      de: "Führt Befehle und Skripte auf den Dateien der Unterhaltung aus, etwa um zu rechnen oder umzuwandeln."
    },
    group: "files",
    icon: "code",
    effect: "changing",
    // Runs on the agent's own call. Without a mode the instance default for changes would apply.
    permission: { mode: "allow" },
    description:
      "Run a bounded Bash command from /workspace in the conversation execution workspace. The sandbox has no outbound network or DNS access: commands cannot reach public websites, APIs, or private services, or download packages. For documentation or other remote content, use an available web tool; if none is available, ask for an upload and use workspace.import_files. This isolation is deliberate; retrying a network request here will not enable access. Each call starts in /workspace unless cwd is provided for that call; cwd, processes, and files outside /workspace do not persist. The standard project directories scripts, artifacts, previews, and tmp are available at the start of every command. Pass a complete shell command or multiline script. Files created or changed under /workspace persist across calls and stay internal until promoted. In a chat with a project, /workspace/project is a writable snapshot of its folder. Changes and deletions there become project file versions after the command. projectFileChanges reports them, including conflict copies when another writer changed the same file; read both copies and merge them into the file. For multiline create-and-verify commands, put `set -e` on its own line before later commands so helpers do not run after a failed script. The folders of this agent's skills are mounted read-only at /skills/<name>/; run a skill's scripts from there and write outputs under /workspace. Run artifact helpers directly. Do not prefix helpers with `set -e`, and do not pass helper flags such as `--view`, `--spec`, `--out`, `--range`, `--page`, or `--sheet` to `cat`, `ls`, or `printf`.",
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
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }

  const queued = await enqueueCommand(deps, context, workspace.value.handle, normalized.value);
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
  const waiting = deps.commands
    .await(resolvedBySource ? { command: resolvedBySource } : queued.value, {
      signal: context.signal,
      deadline: context.deadline
    })
    .then((result) => commandResultToToolResult(queued.value.command, result));
  registerOperationStopResult(
    context.signal,
    waiting.then((result) => (result.status === "failed" ? result.result : undefined))
  );
  const resultCommand = await waiting;
  if (resultCommand.status === "failed") {
    return resultCommand.result;
  }
  const skillMountFailure = skillMountFailureResult(resultCommand.value);
  if (skillMountFailure) {
    return skillMountFailure;
  }
  const platformFailure = platformFailureResult(resultCommand.value);
  if (platformFailure) {
    return platformFailure;
  }
  const expectedOutputs = normalized.value.expectedOutputs;
  if (resultCommand.value.output) {
    const existingWorkspacePaths =
      expectedOutputs.length > 0
        ? new Set(
            (
              await deps.store.executionWorkspaces.listWorkspaceFiles({
                clientInstanceId: context.clientInstanceId,
                workspaceId: workspace.value.handle.id
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

  const output = commandToExecOutput(resultCommand.value, workspace.value.handle.id);
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
  handle: WorkspaceHandle,
  command: {
    command: string;
    cwd?: string;
    limits: WorkspaceCommandLimits;
    expectedOutputs: WorkspaceExpectedOutput[];
  }
): Promise<ValidationResult<WorkspaceCommandHandle>> {
  // Fixed now: a skill saved while the command waits is mounted by the next command.
  const skillMounts = deps.skills ? await runSkillMounts(deps.skills, context) : [];
  try {
    return {
      status: "success",
      value: await deps.commands.enqueue(handle, {
        clientInstanceId: context.clientInstanceId,
        ownerUserId: getRuntimeSubjectUserId(context),
        agentRunId: context.toolRequest?.agentRunId,
        toolCallId: context.toolRequest?.toolCallId,
        command: command.command,
        cwd: command.cwd,
        limits: command.limits,
        expectedOutputs: command.expectedOutputs,
        ...(skillMounts.length > 0 ? { skillMounts } : {})
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

/**
 * What the agent is told of a command that did not run because a skill's folder could not be
 * made ready: the skill's name and what it can do, never the worker's cause or a path.
 */
function skillMountFailureResult(
  command: WorkspaceCommand
): ToolHandlerResult<z.infer<typeof workspaceExecOutputSchema>> | undefined {
  if (command.status !== "failed" || command.error?.code !== SKILL_MOUNT_FAILED_CODE) {
    return undefined;
  }
  const details = command.error.details;
  const skill = isJsonObject(details) ? details.skill : undefined;
  const name = typeof skill === "string" ? skill : undefined;
  return failed(
    "handler_failed",
    `The skill ${name ? `'${name}' ` : ""}could not be made available for this command, so it did not run; try again or continue without it.`,
    {
      commandId: command.id,
      reason: "skill_mount_failed",
      ...(name ? { skill: name } : {})
    }
  );
}

/**
 * The reasons of a command the platform failed to run, as the agent reads them in
 * `details.reason` (`PLATFORM_TOOL_FAILURE_REASONS`). The conversation reads the same reason
 * to offer a report to the operator.
 */
type WorkspacePlatformFailureReason = PlatformToolFailureReason;

/** The codes of a command that failed for the platform, not for what it ran. */
const PLATFORM_FAILURE_REASONS: Partial<Record<string, WorkspacePlatformFailureReason>> = {
  WORKSPACE_COMMAND_SPAWN_FAILED: "sandbox_unavailable",
  WORKSPACE_COMMAND_WORKER_LOST: "platform_error",
  WORKSPACE_COMMAND_RUNNER_ERROR: "platform_error"
};

/**
 * What the agent is told of a command the platform could not run. It never carries the
 * worker's cause, which names images, registries and hosts: that is in the command's row for
 * the operator. It tells the agent that the failure is the platform's, not the person's input,
 * to suggest trying again later, gives the time and the command's id to pass on, and names
 * nobody as the one to fix it.
 */
function workspacePlatformFailure(input: {
  reason: WorkspacePlatformFailureReason;
  commandId: string;
  at: string;
}): ToolHandlerResult<never> {
  const what =
    input.reason === "sandbox_unavailable"
      ? "the platform's sandbox for commands could not start"
      : input.reason === "no_worker"
        ? "code execution is unavailable on the platform right now"
        : "the platform failed while running it";
  return failed(
    "handler_failed",
    `The command did not run because ${what}. This is a technical problem of the platform, not of the person's input, and nothing they or anyone on their instance has to fix. Tell the person so in plain words, suggest trying again later, and give the time (${input.at}) and the command id (${input.commandId}) so they can pass them on. Do not name any person, administrator or contact as the one to fix it. Offer to continue another way without running commands if there is one. Do not repeat the command in this reply.`,
    { commandId: input.commandId, reason: input.reason, at: input.at }
  );
}

function platformFailureResult(
  command: WorkspaceCommand
): ToolHandlerResult<z.infer<typeof workspaceExecOutputSchema>> | undefined {
  if (command.status !== "failed" || !command.error) return undefined;
  const reason = PLATFORM_FAILURE_REASONS[command.error.code];
  if (!reason) return undefined;
  return workspacePlatformFailure({
    reason,
    commandId: command.id,
    at: command.completedAt ?? command.updatedAt
  });
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
    case "no_worker":
      return {
        status: "failed",
        result: workspacePlatformFailure({
          reason: "no_worker",
          commandId: queued.id,
          at: result.command.updatedAt
        })
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
