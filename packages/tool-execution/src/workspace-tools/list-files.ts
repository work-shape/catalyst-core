import type { z } from "zod";
import type { ToolExecutionContext, ToolHandlerResult } from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import {
  workspaceListFilesInputSchema,
  workspaceListFilesOutputSchema
} from "../workspace-tool-schemas";
import { readPromotedFileArtifacts } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { ensureWorkspace } from "./workspace";

export function workspaceListFilesTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.list_files",
    description: "List internal files currently tracked in the conversation execution workspace.",
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
  const workspace = await ensureWorkspace(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.value.id
  });
  return toolSuccess(
    {
      workspaceId: workspace.value.id,
      files: files.map((file) => ({
        path: file.path,
        byteSize: file.byteSize,
        checksum: file.checksum,
        mimeType: file.mimeType,
        updatedAt: file.updatedAt,
        lastCommandId: file.lastCommandId,
        promotedArtifacts: readPromotedFileArtifacts(file.metadata)
      }))
    },
    {
      auditSummary: {
        action: "workspace.list_files",
        subject: workspace.value.id,
        metadata: {
          count: files.length
        }
      }
    }
  );
}
