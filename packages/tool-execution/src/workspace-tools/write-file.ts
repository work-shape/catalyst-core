import type { z } from "zod";
import type { ToolExecutionContext, ToolHandlerResult } from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  WORKSPACE_WRITE_FILE_MAX_BYTES,
  workspaceWriteFileInputJsonSchema,
  workspaceWriteFileInputSchema,
  workspaceWriteFileOutputSchema
} from "../workspace-file-write-schemas";
import { failed } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import {
  checkPathFitsWorkspace,
  checkWorkspaceRoom,
  resolveTextFilePath,
  storeTextFile
} from "./stored-text-file";
import { resolveWorkspaceHandle } from "./workspace";
import {
  projectFolderTarget,
  projectInstructionsFloor,
  writeProjectFolderFile
} from "./project-folder";

export function workspaceWriteFileTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.write_file",
    title: { en: "Write workspace file", de: "Datei schreiben" },
    summary: {
      en: "Creates or replaces a text file in the conversation.",
      de: "Legt eine Textdatei in der Unterhaltung an oder ersetzt sie."
    },
    group: "files",
    icon: "text",
    effect: "changing",
    // Runs on the agent's own call. Without a mode the instance default for changes would apply.
    permission: { mode: "allow" },
    // The project's instructions enter every run of everyone in the project (PRJ-3): the agent
    // changes them only with the person's click, whatever a setting says.
    policyFloor: (_call, input) => projectInstructionsFloor(deps, input.path),
    description: `Create a text file in /workspace or replace its whole content, at most ${WORKSPACE_WRITE_FILE_MAX_BYTES / 1024} KiB. Parent folders are created. To change part of a file use workspace.edit_file. Search, move, delete and scripts stay with workspace.exec.`,
    inputSchema: workspaceWriteFileInputSchema,
    inputJsonSchema: workspaceWriteFileInputJsonSchema,
    outputSchema: workspaceWriteFileOutputSchema,
    execute(input, context) {
      return writeWorkspaceFile(deps, input, context);
    }
  });
}

export async function writeWorkspaceFile(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspaceWriteFileInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceWriteFileOutputSchema>>> {
  const project = await projectFolderTarget(deps, context, input.path);
  if (project) return writeProjectFolderFile(project, input, context);
  const { fileStore } = deps;
  if (!fileStore) {
    return failed(
      "handler_failed",
      "This instance has no storage for workspace files, so workspace.write_file cannot run. Tell the person this is a problem of the platform, not of their input, and name nobody as the one to fix it."
    );
  }
  const path = resolveTextFilePath(input.path, deps.limits);
  if (path.status === "failed") {
    return path.result;
  }
  if (input.content.includes("\0")) {
    return failed(
      "validation_failed",
      "The content holds a NUL character, and workspace.write_file writes text only. Create a binary file with a command in workspace.exec.",
      { path: path.value }
    );
  }
  const bytes = new TextEncoder().encode(input.content);
  if (bytes.byteLength > WORKSPACE_WRITE_FILE_MAX_BYTES) {
    return failed(
      "validation_failed",
      `The content has ${bytes.byteLength} bytes and workspace.write_file takes at most ${WORKSPACE_WRITE_FILE_MAX_BYTES} (WORKSPACE_WRITE_FILE_MAX_BYTES). Nothing was written. Write the file with a command in workspace.exec, or split it into several files.`,
      { path: path.value, byteSize: bytes.byteLength, maxBytes: WORKSPACE_WRITE_FILE_MAX_BYTES }
    );
  }
  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.value.handle.id
  });
  const fits = checkPathFitsWorkspace(files, path.value);
  if (fits.status === "failed") {
    return fits.result;
  }
  const room = checkWorkspaceRoom(deps, files, path.value, bytes.byteLength);
  if (room.status === "failed") {
    return room.result;
  }

  const existing = files.find((file) => file.path === path.value);
  const file = await storeTextFile({ ...deps, fileStore }, context, {
    toolName: "workspace.write_file",
    workspace: workspace.value,
    path: path.value,
    bytes,
    existing
  });
  const created = existing === undefined;
  return toolSuccess(
    { path: file.path, byteSize: file.byteSize, created },
    {
      // Names and sizes. The content is in no audit event and no Operation Run.
      auditSummary: {
        action: "workspace.write_file",
        subject: file.path,
        metadata: { byteSize: file.byteSize, checksum: file.checksum, created }
      }
    }
  );
}
