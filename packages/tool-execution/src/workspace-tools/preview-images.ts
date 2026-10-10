import { posix as path } from "node:path";
import type { z } from "zod";
import {
  type SupportedImageMimeType,
  type ToolExecutionContext,
  type ToolHandlerResult,
  isAppError
} from "@vivd-catalyst/core";
import { defineTool, toolSuccess } from "@vivd-catalyst/tool-sdk";
import { resolveWorkspacePreviewImages } from "../workspace-preview-images";
import {
  workspacePreviewImagesInputJsonSchema,
  workspacePreviewImagesInputSchema,
  workspacePreviewImagesOutputSchema
} from "../workspace-tool-schemas";
import { failed, normalizeWorkspaceFilePath } from "../workspace-tool-results";
import type { WorkspaceToolDependencies } from "./dependencies";
import { resolveWorkspaceHandle } from "./workspace";

export const EXECUTION_WORKSPACE_ARTIFACT_METADATA_SOURCE = "execution_workspace";

export function workspacePreviewImagesTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.preview_images",
    description:
      "Load bounded rendered preview images into model-visible visual context without promoting preview files to the user. Use path/paths for rendered image files under /workspace/previews, or artifactId with page/slide/sheet/range selectors for managed DOCX/XLSX/PPTX/PDF artifacts. The result reports pending, failed, or unsupported when pixels are not actually attached. Loaded images stay in visual context for the current turn only; call the tool again in a later turn to see them again.",
    inputSchema: workspacePreviewImagesInputSchema,
    outputSchema: workspacePreviewImagesOutputSchema,
    inputJsonSchema: workspacePreviewImagesInputJsonSchema,
    execute(input, context) {
      return previewWorkspaceImages(deps, input, context);
    }
  });
}

export async function previewWorkspaceImages(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspacePreviewImagesInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspacePreviewImagesOutputSchema>>> {
  if (input.path || input.paths) {
    return previewWorkspaceImagePaths(deps, input, context);
  }
  return resolveWorkspacePreviewImages(input, context, {
    store: deps.store.files,
    maxImages: deps.limits.maxPreviewImages
  });
}

async function previewWorkspaceImagePaths(
  deps: WorkspaceToolDependencies,
  input: z.infer<typeof workspacePreviewImagesInputSchema>,
  context: ToolExecutionContext
): Promise<ToolHandlerResult<z.infer<typeof workspacePreviewImagesOutputSchema>>> {
  if (!deps.objectStore) {
    return failed("handler_failed", "Workspace preview image bytes are not available");
  }
  const rawPaths = input.paths ?? (input.path ? [input.path] : []);
  const maxImages = Math.min(
    input.maxImages ?? deps.limits.maxPreviewImages,
    deps.limits.maxPreviewImages
  );
  if (rawPaths.length > maxImages) {
    return failed("handler_failed", "workspace.preview_images path count exceeds maxImages", {
      pathCount: rawPaths.length,
      maxImages
    });
  }

  const normalizedPaths = [];
  const seenPaths = new Set<string>();
  for (const rawPath of rawPaths) {
    const normalizedPath = normalizeWorkspaceFilePath(rawPath, deps.limits);
    if (normalizedPath.status === "failed") {
      return normalizedPath.result;
    }
    if (seenPaths.has(normalizedPath.value)) {
      return failed("handler_failed", "workspace.preview_images paths must be unique", {
        path: normalizedPath.value
      });
    }
    seenPaths.add(normalizedPath.value);
    normalizedPaths.push(normalizedPath.value);
  }

  const workspace = await resolveWorkspaceHandle(deps, context);
  if (workspace.status === "failed") {
    return workspace.result;
  }
  const files = await deps.store.executionWorkspaces.listWorkspaceFiles({
    clientInstanceId: context.clientInstanceId,
    workspaceId: workspace.value.handle.id
  });
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const images: z.infer<typeof workspacePreviewImagesOutputSchema>["images"] = [];
  const artifacts = [];
  const warnings: z.infer<typeof workspacePreviewImagesOutputSchema>["warnings"] = [];

  for (const imagePath of normalizedPaths) {
    const file = filesByPath.get(imagePath);
    if (!file) {
      return failed("handler_failed", `Workspace preview image '${imagePath}' was not found`);
    }
    const mimeType = readPreviewImageMimeType(file.mimeType, file.path);
    if (!mimeType) {
      return failed("handler_failed", "Workspace preview image must be a supported image file", {
        path: file.path,
        ...(file.mimeType ? { mimeType: file.mimeType } : {}),
        supportedMimeTypes: ["image/png", "image/jpeg", "image/webp", "image/gif"]
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = await deps.objectStore.getObject(file.objectKey);
    } catch (error) {
      if (isAppError(error) && error.code !== "NOT_FOUND") {
        throw error;
      }
      return failed(
        "handler_failed",
        `Workspace preview image '${file.path}' is not available in durable storage. Recreate the preview before inspecting it.`,
        { path: file.path }
      );
    }
    if (bytes.byteLength !== file.byteSize) {
      return failed(
        "handler_failed",
        `Workspace preview image '${file.path}' does not match its stored metadata. Recreate the preview before inspecting it.`,
        {
          path: file.path,
          expectedByteSize: file.byteSize,
          actualByteSize: bytes.byteLength
        }
      );
    }
    const artifact = await deps.store.files.createManagedArtifact({
      clientInstanceId: context.clientInstanceId,
      conversationId: workspace.value.conversationId,
      kind: previewImageKind(mimeType),
      objectKey: file.objectKey,
      filename: path.basename(file.path),
      mimeType,
      byteSize: file.byteSize,
      checksum: file.checksum,
      metadata: {
        source: EXECUTION_WORKSPACE_ARTIFACT_METADATA_SOURCE,
        workspaceId: workspace.value.handle.id,
        workspacePath: file.path
      }
    });
    images.push({
      sourceArtifactId: artifact.id,
      imageArtifactId: artifact.id,
      mimeType,
      status: "ready"
    });
    artifacts.push({
      artifactId: artifact.id,
      kind: artifact.kind,
      filename: artifact.filename,
      mimeType,
      modelVisibility: {
        type: "image" as const,
        mimeType
      },
      metadata: {
        sourceArtifactId: artifact.id,
        status: "ready",
        workspacePath: file.path
      }
    });
  }

  return toolSuccess(
    {
      artifactId: images[0]?.imageArtifactId ?? "",
      status: "ready",
      maxImages,
      images,
      warnings
    },
    {
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      auditSummary: {
        action: "workspace.preview_images",
        subject: workspace.value.handle.id,
        metadata: {
          status: "ready",
          source: "workspace_path",
          imageCount: images.length,
          maxImages,
          warningCount: warnings.length
        }
      }
    }
  );
}

function readPreviewImageMimeType(
  mimeType: string | undefined,
  filePath: string
): SupportedImageMimeType | undefined {
  if (isSupportedPreviewImageMimeType(mimeType)) {
    return mimeType;
  }
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  return undefined;
}

function isSupportedPreviewImageMimeType(
  value: string | undefined
): value is SupportedImageMimeType {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
  );
}

function previewImageKind(mimeType: SupportedImageMimeType): string {
  switch (mimeType) {
    case "image/jpeg":
      return "image.jpeg";
    case "image/webp":
      return "image.webp";
    case "image/gif":
      return "image.gif";
    case "image/png":
      return "image.png";
  }
}
