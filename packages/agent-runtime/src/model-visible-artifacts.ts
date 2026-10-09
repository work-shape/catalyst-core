import type {
  ClientInstanceId,
  ManagedArtifactId,
  SupportedImageMimeType,
  ToolExecutionResult
} from "@vivd-catalyst/core";
import type { ModelContent, ModelContentPart } from "@vivd-catalyst/model-provider";

export interface ModelContextArtifactReader {
  readArtifact(input: {
    clientInstanceId: ClientInstanceId;
    artifactId: ManagedArtifactId;
  }): Promise<{
    bytes: Uint8Array;
    mimeType: string;
  }>;
}

export interface ModelVisibleArtifactProjectionOptions {
  logger?: import("@vivd-catalyst/core").Logger;
  clientInstanceId?: ClientInstanceId;
  artifactReader?: ModelContextArtifactReader;
}

const VISUAL_CONTEXT_LOADED_HEADER = "[Visual context loaded]";
// Stands where images were: a tool result of an earlier run, or one a request had no room for.
const VISUAL_CONTEXT_NOT_LOADED_HEADER =
  "[Visual context not loaded: older images are not kept in model context. To see one again, repeat the tool call that produced it with the values below.]";
const ATTACHED_IMAGES_NOT_LOADED_NOTE =
  "[Attached images not loaded: older images are not kept in model context. Ask for the image again if it is needed.]";

export interface ModelVisibleArtifactProjection {
  parts: ModelContentPart[];
  summary?: string;
}

export async function projectModelVisibleArtifacts(
  result: ToolExecutionResult,
  options: ModelVisibleArtifactProjectionOptions
): Promise<ModelVisibleArtifactProjection> {
  const parts = await readModelVisibleImages(result, options);
  return {
    parts,
    summary:
      parts.length > 0
        ? createVisualArtifactSummary(result, VISUAL_CONTEXT_LOADED_HEADER)
        : undefined
  };
}

/**
 * What a tool result of an earlier run shows in place of its images: which document, page,
 * slide or range each one was, so the model can ask for it again. Reads no image bytes.
 */
export function summarizeModelVisibleArtifactsNotLoaded(
  result: ToolExecutionResult
): string | undefined {
  return createVisualArtifactSummary(result, VISUAL_CONTEXT_NOT_LOADED_HEADER);
}

/** The same content without its images, saying in their place that they are not loaded. */
export function withoutModelVisibleImages(content: ModelContent): ModelContent {
  if (typeof content === "string" || !content.some((part) => part.type === "image")) {
    return content;
  }
  const text = content
    .filter((part): part is Extract<ModelContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  if (text.includes(VISUAL_CONTEXT_LOADED_HEADER)) {
    return text.replace(VISUAL_CONTEXT_LOADED_HEADER, VISUAL_CONTEXT_NOT_LOADED_HEADER);
  }
  return text ? `${text}\n\n${ATTACHED_IMAGES_NOT_LOADED_NOTE}` : ATTACHED_IMAGES_NOT_LOADED_NOTE;
}

async function readModelVisibleImages(
  result: ToolExecutionResult,
  options: ModelVisibleArtifactProjectionOptions
): Promise<ModelContentPart[]> {
  if (
    result.status !== "success" ||
    !result.artifacts?.length ||
    !options.clientInstanceId ||
    !options.artifactReader
  ) {
    return [];
  }
  const images: ModelContentPart[] = [];
  for (const artifact of result.artifacts) {
    if (artifact.modelVisibility?.type !== "image") {
      continue;
    }
    try {
      const object = await options.artifactReader.readArtifact({
        clientInstanceId: options.clientInstanceId,
        artifactId: artifact.artifactId
      });
      if (
        !isSupportedImageMimeType(object.mimeType) ||
        object.mimeType !== artifact.modelVisibility.mimeType
      ) {
        continue;
      }
      images.push({
        type: "image",
        mimeType: object.mimeType,
        data: object.bytes
      });
    } catch (error) {
      options.logger?.warn(
        {
          type: "model_context_projection.artifact_unavailable",
          artifactId: artifact.artifactId,
          error: error instanceof Error ? error.message : "Unknown artifact read error"
        },
        "Model context image unavailable"
      );
    }
  }
  return images;
}

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return (
    value === "image/png" ||
    value === "image/jpeg" ||
    value === "image/webp" ||
    value === "image/gif"
  );
}

function createVisualArtifactSummary(
  result: ToolExecutionResult,
  header: string
): string | undefined {
  if (result.status !== "success" || !result.artifacts?.length) {
    return undefined;
  }
  const lines = result.artifacts
    .filter((artifact) => artifact.modelVisibility?.type === "image")
    .map((artifact) => {
      const metadata = artifact.metadata ?? {};
      const details = [
        typeof metadata.fileId === "string" ? `fileId: ${metadata.fileId}` : undefined,
        `artifactId: ${artifact.artifactId}`,
        `mimeType: ${artifact.modelVisibility?.mimeType ?? artifact.mimeType ?? "image/png"}`,
        typeof metadata.pageNumber === "number" ? `page: ${metadata.pageNumber}` : undefined,
        typeof metadata.slideNumber === "number" ? `slide: ${metadata.slideNumber}` : undefined,
        typeof metadata.sheet === "string" ? `sheet: ${metadata.sheet}` : undefined,
        typeof metadata.range === "string" ? `range: ${metadata.range}` : undefined,
        typeof metadata.width === "number" && typeof metadata.height === "number"
          ? `size: ${metadata.width}x${metadata.height}`
          : undefined,
        typeof metadata.dpi === "number" ? `dpi: ${metadata.dpi}` : undefined
      ].filter((value): value is string => value !== undefined);
      return `- ${details.join(", ")}`;
    });
  return lines.length > 0 ? [header, ...lines].join("\n") : undefined;
}
