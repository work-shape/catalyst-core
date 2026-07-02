import type {
  ClientInstanceId,
  ManagedArtifactId,
  SupportedImageMimeType,
  ToolExecutionResult
} from "@vivd-catalyst/core";
import type { ModelContentPart } from "@vivd-catalyst/model-provider";

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
  clientInstanceId?: ClientInstanceId;
  artifactReader?: ModelContextArtifactReader;
}

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
    summary: parts.length > 0 ? createVisualArtifactSummary(result) : undefined
  };
}

async function readModelVisibleImages(
  result: ToolExecutionResult,
  options: ModelVisibleArtifactProjectionOptions
): Promise<ModelContentPart[]> {
  if (result.status !== "success" || !result.artifacts?.length || !options.clientInstanceId || !options.artifactReader) {
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
      if (!isSupportedImageMimeType(object.mimeType) || object.mimeType !== artifact.modelVisibility.mimeType) {
        continue;
      }
      images.push({
        type: "image",
        mimeType: object.mimeType,
        data: object.bytes
      });
    } catch (error) {
      console.warn(
        JSON.stringify({
          type: "model_context_projection.artifact_unavailable",
          artifactId: artifact.artifactId,
          error: error instanceof Error ? error.message : "Unknown artifact read error"
        })
      );
    }
  }
  return images;
}

function isSupportedImageMimeType(value: string): value is SupportedImageMimeType {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

function createVisualArtifactSummary(result: ToolExecutionResult): string | undefined {
  if (result.status !== "success" || !result.artifacts?.length) {
    return undefined;
  }
  const lines = result.artifacts
    .filter((artifact) => artifact.modelVisibility?.type === "image")
    .map((artifact) => {
      const metadata = artifact.metadata ?? {};
      const details = [
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
  return lines.length > 0 ? ["[Visual context loaded]", ...lines].join("\n") : undefined;
}
