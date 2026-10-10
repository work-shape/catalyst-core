import type { z } from "zod";
import type { ToolExecutionContext, ToolHandlerResult } from "@vivd-catalyst/core";
import type {
  workspaceApplyPatchInputSchema,
  workspaceApplyPatchOutputSchema,
  workspaceExecInputSchema,
  workspaceExecOutputSchema,
  workspaceImportFilesInputSchema,
  workspaceImportFilesOutputSchema,
  workspaceListFilesInputSchema,
  workspaceListFilesOutputSchema,
  workspacePreviewImagesInputSchema,
  workspacePreviewImagesOutputSchema,
  workspacePromoteArtifactInputSchema,
  workspacePromoteArtifactOutputSchema,
  workspaceReadFileInputSchema,
  workspaceReadFileOutputSchema
} from "../workspace-tool-schemas";
import { applyWorkspacePatch } from "./apply-patch";
import {
  resolveWorkspaceToolDependencies,
  type WorkspaceCommandServiceOptions,
  type WorkspaceToolDependencies
} from "./dependencies";
import { execWorkspaceCommand } from "./exec";
import { importWorkspaceFiles } from "./import-files";
import { listWorkspaceFiles } from "./list-files";
import { previewWorkspaceImages } from "./preview-images";
import { promoteWorkspaceArtifact } from "./promote-artifact";
import { readWorkspaceFile } from "./read-file";

/** The workspace tools as one object, for callers that run a tool without the registry. */
export class WorkspaceCommandService {
  readonly dependencies: WorkspaceToolDependencies;

  constructor(options: WorkspaceCommandServiceOptions) {
    this.dependencies = resolveWorkspaceToolDependencies(options);
  }

  exec(
    input: z.infer<typeof workspaceExecInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceExecOutputSchema>>> {
    return execWorkspaceCommand(this.dependencies, input, context);
  }

  listFiles(
    input: z.infer<typeof workspaceListFilesInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceListFilesOutputSchema>>> {
    return listWorkspaceFiles(this.dependencies, input, context);
  }

  importFiles(
    input: z.infer<typeof workspaceImportFilesInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceImportFilesOutputSchema>>> {
    return importWorkspaceFiles(this.dependencies, input, context);
  }

  readFile(
    input: z.infer<typeof workspaceReadFileInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceReadFileOutputSchema>>> {
    return readWorkspaceFile(this.dependencies, input, context);
  }

  applyPatch(
    input: z.infer<typeof workspaceApplyPatchInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspaceApplyPatchOutputSchema>>> {
    return applyWorkspacePatch(this.dependencies, input, context);
  }

  promoteArtifact(
    input: z.infer<typeof workspacePromoteArtifactInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspacePromoteArtifactOutputSchema>>> {
    return promoteWorkspaceArtifact(this.dependencies, input, context);
  }

  previewImages(
    input: z.infer<typeof workspacePreviewImagesInputSchema>,
    context: ToolExecutionContext
  ): Promise<ToolHandlerResult<z.infer<typeof workspacePreviewImagesOutputSchema>>> {
    return previewWorkspaceImages(this.dependencies, input, context);
  }
}
