import {
  type ManagedArtifactId,
  type ManagedArtifactRecord,
  SUPPORTED_IMAGE_MIME_TYPES,
  type SupportedImageMimeType,
  type ToolExecutionContext,
  type ToolHandlerResult,
  asManagedArtifactId,
  isAppError,
  readObjectBytes
} from "@work-shape/catalyst-core";
import { defineTool, toolSuccess } from "@work-shape/catalyst-tool-sdk";
import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import type { z } from "zod";
import { resolveWorkspacePreviewImages } from "../workspace-preview-images";
import { failed, normalizeWorkspaceFilePath } from "../workspace-tool-results";
import {
  workspacePreviewImagesInputJsonSchema,
  workspacePreviewImagesInputSchema,
  workspacePreviewImagesOutputSchema
} from "../workspace-tool-schemas";
import type { WorkspaceToolDependencies } from "./dependencies";
import { resolveWorkspaceHandle } from "./workspace";

export const EXECUTION_WORKSPACE_ARTIFACT_METADATA_SOURCE = "execution_workspace";

/**
 * The `purpose` of an artifact row that exists only so the model can look at a workspace image.
 * Such a row is the agent checking its own work, not a file for the person, so it is never
 * listed among the conversation's created files.
 */
export const WORKSPACE_INSPECTION_ARTIFACT_PURPOSE = "inspection";
const WORKSPACE_PREVIEW_ARTIFACT_ID_PREFIX = "art_workspace_preview_";

/**
 * Whether an artifact row was made by `workspace.preview_images` to show a workspace image to
 * the model. Rows stored before the purpose was recorded are known by their id, which only
 * that tool gives out.
 */
export function isWorkspaceInspectionArtifact(
  artifact: Pick<ManagedArtifactRecord, "id" | "metadata">
): boolean {
  return (
    artifact.metadata.purpose === WORKSPACE_INSPECTION_ARTIFACT_PURPOSE ||
    artifact.id.startsWith(WORKSPACE_PREVIEW_ARTIFACT_ID_PREFIX)
  );
}

export function workspacePreviewImagesTool(deps: WorkspaceToolDependencies) {
  return defineTool({
    name: "workspace.preview_images",
    title: { en: "Inspect artifact images", de: "Bilder von Dateien ansehen" },
    summary: {
      en: "Looks at pages and images of files it made, to check them.",
      de: "Sieht sich Seiten und Bilder selbst erstellter Dateien an, um sie zu prüfen."
    },
    group: "files",
    icon: "image",
    effect: "reading",
    description:
      "Load rendered preview images so you can see them, to check rendered output. They are never listed among the person's files: render checks under /workspace/previews and promote with workspace.promote_artifact only what the person should get. Give exactly one source: artifactId, path, or paths. Use path or paths for images under /workspace/previews, or artifactId with page, slide, sheet or range selectors for a managed DOCX, XLSX, PPTX or PDF. The result says pending, failed or unsupported when no pixels are attached. Images stay visible for this turn only.",
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
  const workspace = input.artifactId
    ? await deps.workspaces.resolveWorkspaceHandle(context)
    : undefined;
  return resolveWorkspacePreviewImages(input, context, {
    store: deps.store.files,
    maxImages: deps.limits.maxPreviewImages,
    conversationId: workspace?.conversationId
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
        supportedMimeTypes: [...SUPPORTED_IMAGE_MIME_TYPES]
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = await readObjectBytes(deps.objectStore, file.objectKey);
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
    const kind = previewImageKind(mimeType);
    // The id names the stored version of the file, so looking at an unchanged file again
    // finds the row of the first look by primary key instead of adding one per call.
    const artifact = await deps.store.files.ensureManagedArtifact({
      id: workspacePreviewImageArtifactId({
        clientInstanceId: context.clientInstanceId,
        conversationId: workspace.value.conversationId,
        workspaceId: workspace.value.handle.id,
        path: file.path,
        checksum: file.checksum,
        objectKey: file.objectKey,
        kind
      }),
      clientInstanceId: context.clientInstanceId,
      conversationId: workspace.value.conversationId,
      kind,
      objectKey: file.objectKey,
      filename: path.basename(file.path),
      mimeType,
      byteSize: file.byteSize,
      checksum: file.checksum,
      metadata: {
        source: EXECUTION_WORKSPACE_ARTIFACT_METADATA_SOURCE,
        purpose: WORKSPACE_INSPECTION_ARTIFACT_PURPOSE,
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

/**
 * The artifact id of one stored version of a workspace image. Workspace, path and checksum are
 * part of it, and so are the object key and the kind: an unchanged file keeps its id, a changed
 * file gets a new one, and so does a file stored again under a new object key, even with the
 * same bytes. Every field `ensureManagedArtifact` compares is in the id, so a row found under
 * it always describes the same bytes at the same place.
 */
function workspacePreviewImageArtifactId(version: {
  clientInstanceId: string;
  conversationId: string;
  workspaceId: string;
  path: string;
  checksum: string;
  objectKey: string;
  kind: string;
}): ManagedArtifactId {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        version.clientInstanceId,
        version.conversationId,
        version.workspaceId,
        version.path,
        version.checksum,
        version.objectKey,
        version.kind
      ])
    )
    .digest("hex");
  return asManagedArtifactId(`${WORKSPACE_PREVIEW_ARTIFACT_ID_PREFIX}${digest}`);
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
