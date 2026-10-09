import type {
  ClientInstanceId,
  ManagedArtifactId,
  ManagedArtifactRef,
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
// Stands where images a tool loaded were: in a result of an earlier run, or in a request that had
// no room for them.
const VISUAL_CONTEXT_NOT_LOADED_HEADER =
  "[Visual context not loaded: older images are not kept in model context. To see one again, repeat the tool call that produced it with the values below.]";

type ModelImagePart = Extract<ModelContentPart, { type: "image" }>;

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

/**
 * The same content without the given images. A line in their place says what was left out: for
 * an image a tool loaded, the values to load it again with; for an image the user attached, that
 * it was too large, since no tool call brings it back.
 */
export function omitModelVisibleImages(
  content: ModelContent,
  omitted: ReadonlySet<ModelImagePart>
): ModelContent {
  if (typeof content === "string" || omitted.size === 0) {
    return content;
  }
  const images = content.filter(
    (part): part is ModelImagePart => part.type === "image" && omitted.has(part)
  );
  if (images.length === 0) {
    return content;
  }
  let text = content
    .filter((part): part is Extract<ModelContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
  const reloadable = images.flatMap((image) =>
    image.source?.kind === "tool_result" ? [image.source.label] : []
  );
  const notes: string[] = [];
  if (reloadable.length > 0) {
    // The summary of loaded images is the end of the text; take the omitted ones out of it.
    for (const label of reloadable) {
      text = text.replace(`\n- ${label}`, "");
    }
    if (text.endsWith(VISUAL_CONTEXT_LOADED_HEADER)) {
      text = text.slice(0, -VISUAL_CONTEXT_LOADED_HEADER.length).trimEnd();
    }
    notes.push(
      [VISUAL_CONTEXT_NOT_LOADED_HEADER, ...reloadable.map((label) => `- ${label}`)].join("\n")
    );
  }
  const other = images.filter((image) => image.source?.kind !== "tool_result");
  if (other.length > 0) {
    const names = other.flatMap((image) => (image.source ? [image.source.label] : []));
    notes.push(
      `[${other.length === 1 ? "1 image was" : `${other.length} images were`} too large to include in the model input and ${other.length === 1 ? "was" : "were"} left out${names.length > 0 ? `: ${names.join(", ")}` : ""}.]`
    );
  }
  const remaining = content.filter((part) => part.type === "image" && !omitted.has(part));
  const projectedText = [text, ...notes].filter((value) => value.length > 0).join("\n\n");
  return remaining.length > 0
    ? [{ type: "text", text: projectedText }, ...remaining]
    : projectedText;
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
        data: object.bytes,
        source: { kind: "tool_result", label: describeImageArtifact(artifact) }
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
    .map((artifact) => `- ${describeImageArtifact(artifact)}`);
  return lines.length > 0 ? [header, ...lines].join("\n") : undefined;
}

/**
 * One image of a tool result in the values its tool takes: the file and page of a document page,
 * the source artifact with its page, slide, sheet or range for a preview, or the workspace path.
 */
function describeImageArtifact(artifact: ManagedArtifactRef): string {
  const metadata = artifact.metadata ?? {};
  // A preview is asked for by the artifact it was rendered from, never by its own id.
  const artifactId =
    typeof metadata.sourceArtifactId === "string" ? metadata.sourceArtifactId : artifact.artifactId;
  return [
    typeof metadata.fileId === "string" ? `fileId: ${metadata.fileId}` : undefined,
    `artifactId: ${artifactId}`,
    typeof metadata.workspacePath === "string" ? `path: ${metadata.workspacePath}` : undefined,
    `mimeType: ${artifact.modelVisibility?.mimeType ?? artifact.mimeType ?? "image/png"}`,
    typeof metadata.pageNumber === "number" ? `page: ${metadata.pageNumber}` : undefined,
    typeof metadata.slideNumber === "number" ? `slide: ${metadata.slideNumber}` : undefined,
    typeof metadata.sheet === "string" ? `sheet: ${metadata.sheet}` : undefined,
    typeof metadata.range === "string" ? `range: ${metadata.range}` : undefined,
    typeof metadata.width === "number" && typeof metadata.height === "number"
      ? `size: ${metadata.width}x${metadata.height}`
      : undefined,
    typeof metadata.dpi === "number" ? `dpi: ${metadata.dpi}` : undefined
  ]
    .filter((value): value is string => value !== undefined)
    .join(", ");
}
