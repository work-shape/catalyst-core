import { posix as path } from "node:path";
import type { z } from "zod";
import type { ToolExecutionContext, ToolHandlerResult } from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { promoteWorkspaceFile } from "../workspace-artifact-promotion";
import {
  workspacePromoteArtifactInputSchema,
  workspacePromoteArtifactOutputSchema
} from "../workspace-tool-schemas";
import { normalizeWorkspaceFilePath } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { findWorkspaceFile } from "./workspace";

export function workspacePromoteArtifactTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.promote_artifact",
    description:
      "Promote a final workspace file to a managed artifact. Catalyst automatically displays promoted artifacts as clickable download cards below the assistant response.",
    inputSchema: workspacePromoteArtifactInputSchema,
    outputSchema: workspacePromoteArtifactOutputSchema,
    execute(input, context) {
      return promoteWorkspaceArtifact(deps, input, context);
    }
  });
}

export async function promoteWorkspaceArtifact(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspacePromoteArtifactInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspacePromoteArtifactOutputSchema>>> {
  const normalizedPath = normalizeWorkspaceFilePath(input.path, deps.limits);
  if (normalizedPath.status === "failed") {
    return normalizedPath.result;
  }
  const file = await findWorkspaceFile(deps, context, normalizedPath.value);
  if (file.status === "failed") {
    return file.result;
  }
  const filename = input.filename ?? path.basename(file.value.file.path);
  const mimeType = input.mimeType ?? file.value.file.mimeType ?? "application/octet-stream";
  const artifact = await promoteWorkspaceFile(deps.store, {
    file: file.value.file,
    kind: input.kind,
    filename,
    mimeType,
    now: deps.now
  });

  const output = {
    artifactId: artifact.id,
    path: file.value.file.path,
    kind: artifact.kind,
    filename,
    mimeType,
    byteSize: file.value.file.byteSize,
    checksum: file.value.file.checksum
  };
  return toolSuccess(output, {
    artifacts: [
      {
        artifactId: artifact.id,
        kind: artifact.kind,
        filename,
        mimeType,
        metadata: {
          source: "execution_workspace",
          workspaceId: file.value.workspaceId,
          workspacePath: file.value.file.path,
          byteSize: file.value.file.byteSize,
          checksum: file.value.file.checksum
        }
      }
    ],
    auditSummary: {
      action: "workspace.promote_artifact",
      subject: artifact.id,
      metadata: {
        path: file.value.file.path,
        kind: artifact.kind
      }
    }
  });
}
