import {
  resolveFilePreviewCapability,
  type ArtifactPreviewJobRecord,
  type ManagedArtifactRecord,
  type PlatformStore
} from "@vivd-catalyst/core";

export type ArtifactPreviewJobStore = Pick<PlatformStore, "enqueueArtifactPreviewJob">;

export async function enqueueArtifactPreviewJobForPromotedArtifact(
  store: ArtifactPreviewJobStore,
  artifact: ManagedArtifactRecord
): Promise<ArtifactPreviewJobRecord | undefined> {
  const capability = resolveFilePreviewCapability(artifact);
  if (
    capability !== "office_document_pages" &&
    capability !== "office_presentation_pages"
  ) {
    return undefined;
  }
  return store.enqueueArtifactPreviewJob({
    clientInstanceId: artifact.clientInstanceId,
    conversationId: artifact.conversationId,
    sourceArtifactId: artifact.id,
    sourceChecksum: artifact.checksum,
    sourceMimeType: artifact.mimeType
  });
}
