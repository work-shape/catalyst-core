import {
  resolveFilePreviewCapability,
  type ISODateString,
  type ManagedArtifactKind,
  type ManagedArtifactRecord,
  type PlatformStore,
  type WorkspaceCommandId,
  type WorkspaceFile
} from "@vivd-catalyst/core";
import { readPromotedFileArtifacts } from "./workspace-tool-results";

export type WorkspaceArtifactPromotionStore = Pick<
  PlatformStore,
  "createManagedArtifact" | "enqueueArtifactPreviewJob" | "upsertWorkspaceFile"
>;

export async function promoteWorkspaceFile(
  store: WorkspaceArtifactPromotionStore,
  input: {
    file: WorkspaceFile;
    kind: ManagedArtifactKind;
    filename: string;
    mimeType: string;
    commandId?: WorkspaceCommandId;
    now: () => ISODateString;
  }
): Promise<ManagedArtifactRecord> {
  const artifact = await store.createManagedArtifact({
    clientInstanceId: input.file.clientInstanceId,
    conversationId: input.file.conversationId,
    kind: input.kind,
    objectKey: input.file.objectKey,
    filename: input.filename,
    mimeType: input.mimeType,
    byteSize: input.file.byteSize,
    checksum: input.file.checksum,
    metadata: {
      source: "execution_workspace",
      workspaceId: input.file.workspaceId,
      workspacePath: input.file.path,
      ...(input.commandId ? { commandId: input.commandId } : {})
    }
  });
  const previewCapability = resolveFilePreviewCapability(artifact);
  if (
    previewCapability === "office_document_pages" ||
    previewCapability === "office_presentation_pages"
  ) {
    await store.enqueueArtifactPreviewJob({
      clientInstanceId: artifact.clientInstanceId,
      conversationId: artifact.conversationId,
      sourceArtifactId: artifact.id,
      sourceChecksum: artifact.checksum,
      sourceMimeType: artifact.mimeType
    });
  }
  await store.upsertWorkspaceFile({
    clientInstanceId: input.file.clientInstanceId,
    workspaceId: input.file.workspaceId,
    path: input.file.path,
    objectKey: input.file.objectKey,
    byteSize: input.file.byteSize,
    checksum: input.file.checksum,
    mimeType: input.file.mimeType,
    metadata: {
      ...input.file.metadata,
      promotedArtifacts: [
        ...(readPromotedFileArtifacts(input.file.metadata) ?? []).filter(
          (candidate) => candidate.artifactId !== artifact.id
        ),
        { artifactId: artifact.id, kind: artifact.kind, promotedAt: artifact.createdAt }
      ]
    },
    lastCommandId: input.commandId ?? input.file.lastCommandId,
    updatedAt: input.now()
  });
  return artifact;
}
