import type { AnyToolDefinition } from "@vivd-catalyst/tool-sdk";
import { workspaceApplyPatchTool } from "./apply-patch";
import type { WorkspaceCommandServiceOptions } from "./dependencies";
import { workspaceEditFileTool } from "./edit-file";
import { workspaceExecTool } from "./exec";
import { workspaceImportFilesTool } from "./import-files";
import { workspaceListFilesTool } from "./list-files";
import { workspacePreviewImagesTool } from "./preview-images";
import { workspacePromoteArtifactTool } from "./promote-artifact";
import { workspaceReadFileTool } from "./read-file";
import { WorkspaceCommandService } from "./service";
import { workspaceWriteFileTool } from "./write-file";

export {
  shapeWorkspaceCommandOutput,
  type WorkspaceRawCommandOutput
} from "../workspace-tool-results";
export type { WorkspaceCommandServiceLimits } from "../workspace-tool-schemas";
export type {
  WorkspaceCommandResultSource,
  WorkspaceCommandServiceOptions,
  WorkspaceSourceFileReader,
  WorkspaceToolStore
} from "./dependencies";
export {
  EXECUTION_WORKSPACE_ARTIFACT_METADATA_SOURCE,
  WORKSPACE_INSPECTION_ARTIFACT_PURPOSE,
  isWorkspaceInspectionArtifact
} from "./preview-images";
export { WorkspaceCommandService } from "./service";

export function createWorkspaceToolDefinitions(
  options: WorkspaceCommandServiceOptions | { service: WorkspaceCommandService }
): AnyToolDefinition[] {
  const service = "service" in options ? options.service : new WorkspaceCommandService(options);
  const deps = service.dependencies;

  return [
    workspaceExecTool(deps),
    workspaceListFilesTool(deps),
    workspaceImportFilesTool(deps),
    workspaceReadFileTool(deps),
    workspaceWriteFileTool(deps),
    workspaceEditFileTool(deps),
    workspaceApplyPatchTool(deps),
    workspacePromoteArtifactTool(deps),
    workspacePreviewImagesTool(deps)
  ];
}
