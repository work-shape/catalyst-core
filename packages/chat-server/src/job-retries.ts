import { renderArtifactPreviewJob, type JobRetry } from "@vivd-catalyst/core";
import { deleteAccountJob, deleteWorkspaceJob, generateConversationTitleJob } from "./job-kinds";

/**
 * How ended jobs of the platform's own kinds are retried by hand. The scheduled kinds are
 * absent: they declare `manualRetry: false`.
 */
const platformJobRetries: readonly JobRetry[] = [
  // These read what they work on anew: a conversation without a title, a user or a workspace
  // still marked for deletion.
  { kind: generateConversationTitleJob },
  { kind: deleteAccountJob },
  { kind: deleteWorkspaceJob },
  {
    kind: renderArtifactPreviewJob,
    // The job that gave up wrote the failure onto the preview row, and a job that finds its
    // row finished renders nothing.
    restoreSubject: async (job, stores) =>
      job.subject !== undefined &&
      (await stores.files.restoreFailedArtifactPreviewJob({
        clientInstanceId: job.clientInstanceId,
        jobId: job.subject
      }))
  }
];

/** By kind name, the retries of the kinds whose ended jobs a person may retry. */
export function jobRetriesByKind(ofCapabilities: readonly JobRetry[] = []): Map<string, JobRetry> {
  return new Map(
    [...platformJobRetries, ...ofCapabilities]
      .filter((retry) => retry.kind.manualRetry !== false)
      .map((retry) => [retry.kind.kind, retry])
  );
}
