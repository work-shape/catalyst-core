import type { z } from "zod";
import type { ToolExecutionContext, ToolHandlerResult } from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import {
  workspaceListFilesInputSchema,
  workspaceListFilesOutputSchema
} from "../workspace-tool-schemas";
import { readPromotedFileArtifacts } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { findExistingWorkspace } from "./workspace";
import { listProjectFolderFiles } from "./project-folder";

export function workspaceListFilesTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.list_files",
    title: { en: "List workspace files", de: "Dateien auflisten" },
    summary: {
      en: "Lists the files the conversation holds.",
      de: "Listet die Dateien auf, die die Unterhaltung enthält."
    },
    group: "files",
    icon: "files",
    effect: "reading",
    description:
      "List the files tracked in this conversation's execution workspace, each with path, size and checksum. These are the internal working files of the conversation, not Collaboration Workspace assets. The list is empty until a tool has put a file there. Read a text file with workspace.read_file; search or look into directories with a command in workspace.exec.",
    inputSchema: workspaceListFilesInputSchema,
    outputSchema: workspaceListFilesOutputSchema,
    execute(input, context) {
      return listWorkspaceFiles(deps, input, context);
    }
  });
}

export async function listWorkspaceFiles(
  deps: WorkspaceToolDependencies,
  _input: z.infer<typeof workspaceListFilesInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspaceListFilesOutputSchema>>> {
  const workspace = await findExistingWorkspace(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }
  const { conversationId, workspaceId } = workspace.value;
  // A conversation without a workspace has no files. Listing is a read and creates none.
  const files = workspaceId
    ? await deps.store.executionWorkspaces.listWorkspaceFiles({
        clientInstanceId: context.clientInstanceId,
        workspaceId
      })
    : [];
  // The chat's project folder, where it is in a project (PRJ-2), under `project/`.
  const projectFiles = await listProjectFolderFiles(deps, context);
  return toolSuccess(
    {
      ...(workspaceId ? { workspaceId } : {}),
      files: [
        ...files.map((file) => ({
          path: file.path,
          byteSize: file.byteSize,
          checksum: file.checksum,
          mimeType: file.mimeType,
          updatedAt: file.updatedAt,
          lastCommandId: file.lastCommandId,
          promotedArtifacts: readPromotedFileArtifacts(file.metadata)
        })),
        ...projectFiles
      ]
    },
    {
      auditSummary: {
        action: "workspace.list_files",
        subject: workspaceId ?? conversationId,
        metadata: {
          count: files.length,
          ...(projectFiles.length > 0 ? { projectCount: projectFiles.length } : {})
        }
      }
    }
  );
}
