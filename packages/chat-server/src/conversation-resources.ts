import { posix } from "node:path";
import type {
  ConversationResourceListItem,
  ConversationResourceListResponse
} from "@vivd-catalyst/api-contract";
import {
  ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_REF,
  currentStructuredResults,
  isImageFileFormat,
  resolveFilePreviewCapability,
  type ChatMessage,
  type ClientInstanceId,
  type ConversationAttachment,
  type ConversationId,
  type ConversationStore,
  type ManagedArtifactRecord,
  type PlatformFileStore,
  type StructuredDataResourceRecord,
  type StructuredDataStore
} from "@vivd-catalyst/core";

type SourceFileResource = Extract<ConversationResourceListItem, { resourceType: "source_file" }>;
type GeneratedFileResource = Extract<
  ConversationResourceListItem,
  { resourceType: "generated_file" }
>;
type StructuredResultResource = Extract<
  ConversationResourceListItem,
  { resourceType: "structured_result" }
>;
type StructuredDataResource = Extract<
  ConversationResourceListItem,
  { resourceType: "structured_data" }
>;

export async function listConversationResources(input: {
  store: PlatformFileStore & Pick<ConversationStore, "listMessages"> & StructuredDataStore;
  clientInstanceId: ClientInstanceId;
  conversationId: ConversationId;
}): Promise<ConversationResourceListResponse> {
  const [attachments, artifacts, messages, structuredData] = await Promise.all([
    input.store.listSentConversationAttachments(input),
    input.store.listConversationManagedArtifacts(input),
    input.store.listMessages(input),
    input.store.listStructuredDataResources(input)
  ]);
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const resources: ConversationResourceListItem[] = [
    ...attachments.map((attachment) => sourceFileResource(attachment, artifactsById)),
    ...generatedFileResources(artifacts),
    ...structuredResultResources(messages),
    ...structuredDataResources(structuredData)
  ];
  resources.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return { resources };
}

function structuredDataResources(
  records: readonly StructuredDataResourceRecord[]
): StructuredDataResource[] {
  return records.map((record) => ({
    resourceType: "structured_data",
    resourceId: `structured_data:${record.id}`,
    title: record.title,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    preview: {
      kind: "structured_data",
      structuredDataResourceId: record.id
    }
  }));
}

function sourceFileResource(
  attachment: ConversationAttachment,
  artifactsById: ReadonlyMap<string, ManagedArtifactRecord>
): SourceFileResource {
  const previewCapability = resolveFilePreviewCapability(attachment);
  const previewArtifact =
    isImageFileFormat(attachment.format) || previewCapability === "native_pdf"
      ? undefined
      : attachmentPreviewSourceArtifact(attachment, artifactsById);
  return {
    resourceType: "source_file",
    resourceId: `source_file:${attachment.id}`,
    attachmentId: attachment.id,
    mimeType: attachment.mimeType,
    title: attachment.filename,
    createdAt: attachment.createdAt,
    updatedAt: attachment.updatedAt,
    preview: previewArtifact
      ? { kind: "artifact", artifactId: previewArtifact.id, mimeType: previewArtifact.mimeType }
      : { kind: "source_file", fileId: attachment.fileId },
    download: {
      kind: "source_file",
      fileId: attachment.fileId,
      filename: attachment.filename
    }
  };
}

function attachmentPreviewSourceArtifact(
  attachment: ConversationAttachment,
  artifactsById: ReadonlyMap<string, ManagedArtifactRecord>
): ManagedArtifactRecord | undefined {
  const capability = resolveFilePreviewCapability(attachment);
  if (capability !== "office_document_pages" && capability !== "office_presentation_pages") {
    return undefined;
  }
  const previewSourceId = attachment.artifactRefs[ATTACHMENT_PREVIEW_SOURCE_ARTIFACT_REF];
  const previewSource = previewSourceId ? artifactsById.get(previewSourceId) : undefined;
  if (previewSource?.status === "available") {
    return previewSource;
  }
  return undefined;
}

function generatedFileResources(
  artifacts: readonly ManagedArtifactRecord[]
): GeneratedFileResource[] {
  const newestByWorkspaceFile = new Map<string, ManagedArtifactRecord>();
  for (const artifact of artifacts) {
    const { source, workspaceId, workspacePath } = artifact.metadata;
    if (
      source !== "execution_workspace" ||
      typeof workspaceId !== "string" ||
      typeof workspacePath !== "string"
    ) {
      continue;
    }
    const key = JSON.stringify([workspaceId, workspacePath]);
    if (!newestByWorkspaceFile.has(key)) {
      newestByWorkspaceFile.set(key, artifact);
    }
  }
  return [...newestByWorkspaceFile.values()].map((artifact) => {
    const workspacePath = artifact.metadata.workspacePath as string;
    const filename = artifact.filename ?? posix.basename(workspacePath);
    return {
      resourceType: "generated_file",
      resourceId: `generated_file:${artifact.id}`,
      title: filename,
      createdAt: artifact.createdAt,
      updatedAt: artifact.createdAt,
      preview: { kind: "artifact", artifactId: artifact.id },
      download: { kind: "artifact", artifactId: artifact.id, filename }
    };
  });
}

function structuredResultResources(messages: readonly ChatMessage[]): StructuredResultResource[] {
  return currentStructuredResults(messages).map((resource) => ({
    resourceType: "structured_result",
    resourceId: `structured_result:${resource.key}`,
    key: resource.key,
    kind: resource.kind,
    schemaVersion: resource.schemaVersion,
    revision: resource.revision,
    title: resource.title,
    createdAt: resource.createdAt,
    updatedAt: resource.updatedAt,
    preview: {
      kind: "typed_display",
      display: {
        kind: resource.kind,
        version: resource.schemaVersion,
        mode: "side_panel",
        title: resource.title,
        data: resource.data
      }
    }
  }));
}
