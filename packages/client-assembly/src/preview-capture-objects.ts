import type { ClientInstanceManagedObjectReaderContribution } from "@work-shape/catalyst-capability-sdk";
import {
  AppError,
  PREVIEW_CAPTURE_ARTIFACT_SOURCE,
  previewCaptureObjectPrefix,
  readObjectBytes,
  type ClientInstanceId,
  type ObjectStorage,
  type PlatformFileStore
} from "@work-shape/catalyst-core";

/**
 * Reads the pictures runs took of a conversation's previews (PREVIEW-SEE-1) from the `files`
 * store: for the model of the run that took one, and for the run's work. Every other artifact
 * is left to the other readers.
 */
export function createPreviewCaptureObjectReader(input: {
  clientInstanceId: ClientInstanceId;
  files: Pick<PlatformFileStore, "getManagedArtifact">;
  /** The `files` object store of the instance. */
  objects: Pick<ObjectStorage, "get">;
}): ClientInstanceManagedObjectReaderContribution {
  return {
    name: "preview-captures",
    async readArtifact(readInput) {
      const artifact = await input.files.getManagedArtifact({
        clientInstanceId: input.clientInstanceId,
        artifactId: readInput.artifactId
      });
      if (
        !artifact ||
        artifact.status !== "available" ||
        artifact.metadata.source !== PREVIEW_CAPTURE_ARTIFACT_SOURCE ||
        !artifact.objectKey.startsWith(previewCaptureObjectPrefix(artifact.conversationId))
      ) {
        throw new AppError("NOT_FOUND", "Managed artifact is not available");
      }
      return {
        bytes: await readObjectBytes(input.objects, artifact.objectKey),
        mimeType: artifact.mimeType
      };
    },
    async readFile() {
      throw new AppError("NOT_FOUND", "A picture of a preview is no file");
    }
  };
}
