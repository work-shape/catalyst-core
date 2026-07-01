import {
  detectArtifactPreviewSourceKind,
  type ArtifactPreviewJobRecord,
  type ManagedArtifactRecord,
  type PlatformStore
} from "@vivd-catalyst/core";

export type ArtifactPreviewJobStore = Pick<PlatformStore, "enqueueArtifactPreviewJob">;

export async function enqueueArtifactPreviewJobForPromotedArtifact(
  store: ArtifactPreviewJobStore,
  artifact: ManagedArtifactRecord
): Promise<ArtifactPreviewJobRecord | undefined> {
  if (!detectArtifactPreviewSourceKind(artifact)) {
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
