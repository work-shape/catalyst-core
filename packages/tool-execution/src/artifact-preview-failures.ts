import type { ArtifactPreviewFailureCode } from "@vivd-catalyst/core";

export interface ArtifactPreviewFailure {
  code: ArtifactPreviewFailureCode;
  retryable: boolean;
}

export function previewFailure(code: ArtifactPreviewFailureCode, retryable: boolean): ArtifactPreviewFailure {
  return { code, retryable };
}

export function normalizePreviewFailure(error: unknown): ArtifactPreviewFailure {
  if (isPreviewFailure(error)) {
    return error;
  }
  return previewFailure("internal_error", true);
}

function isPreviewFailure(error: unknown): error is ArtifactPreviewFailure {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    "retryable" in error &&
    typeof (error as { retryable?: unknown }).retryable === "boolean"
  );
}

export function previewFailureMessage(code: ArtifactPreviewFailureCode): string {
  switch (code) {
    case "unsupported_type":
      return "Artifact type is not supported for generated previews";
    case "source_missing":
      return "Source artifact is not available";
    case "source_too_large":
      return "Source artifact exceeds the preview size limit";
    case "page_limit_exceeded":
      return "Source artifact exceeds the preview page limit";
    case "conversion_timeout":
      return "Artifact conversion timed out";
    case "conversion_failed":
      return "Artifact conversion failed";
    case "rasterization_failed":
      return "Artifact rasterization failed";
    case "storage_failed":
      return "Preview artifact storage failed";
    case "stale_lease":
      return "Artifact preview job lease expired";
    case "internal_error":
      return "Artifact preview generation failed";
  }
}
