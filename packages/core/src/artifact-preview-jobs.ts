import { z } from "zod";
import { defineJobKind, subjectDedupeKey } from "./jobs";

// The lease of a preview render and of the copy on its row. A worker that dies is noticed
// after this long, and the row shows as in progress until then.
const ARTIFACT_PREVIEW_LEASE_MS = 5 * 60 * 1000;
// The wait before the second and last attempt of a preview that failed for a passing reason.
const ARTIFACT_PREVIEW_RETRY_DELAY_MS = 30 * 1000;

/**
 * Renders the preview images of one row of `artifact_preview_jobs`. The row stays the record
 * the interface reads; the job is the only claim on it. Enqueued by the files store in the
 * transaction that writes the row and served by the preview worker.
 */
export const renderArtifactPreviewJob = defineJobKind({
  kind: "artifact_preview.render",
  payloadSchema: z.object({ previewJobId: z.string().min(1) }),
  maxAttempts: 2,
  backoff: { baseMs: ARTIFACT_PREVIEW_RETRY_DELAY_MS, maxMs: ARTIFACT_PREVIEW_RETRY_DELAY_MS },
  leaseMs: ARTIFACT_PREVIEW_LEASE_MS,
  concurrency: {}
});

export function artifactPreviewJobDedupeKey(previewJobId: string): string {
  return subjectDedupeKey(renderArtifactPreviewJob.kind, previewJobId);
}
