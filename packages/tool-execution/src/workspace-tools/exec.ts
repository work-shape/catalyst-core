import type { z } from "zod";
import type {
  ClientInstanceId,
  ToolExecutionContext,
  ToolHandlerResult,
  WorkspaceCommand
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
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
  validateExpectedOutputResult
} from "../workspace-tool-results";
import { enqueueCommand, resolveCommandResult } from "./command-queue";
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

  const command = await enqueueCommand(deps, context, workspace.value.id, normalized.value);
  if (command.status === "failed") {
    return command.result;
  }
  await recordQueuedCommand(deps, context, command.value);
  const resolvedBySource = await deps.commandResults?.resolveWorkspaceCommand({
    command: command.value,
    context
  });
  if (resolvedBySource && resolvedBySource.id !== command.value.id) {
    return failed("handler_failed", "Workspace command result source returned the wrong command");
  }
  const resultCommand = await resolveCommandResult(
    deps,
    resolvedBySource ?? command.value,
    context
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
