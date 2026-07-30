import { posix } from "node:path";
import type {
  ConversationResourceListItem,
  ConversationResourceListResponse
} from "@vivd-catalyst/api-contract";
import {
  detectArtifactPreviewSourceKind,
  isImageFileFormat,
  isJsonObject,
  readToolResultMetadata,
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

type SourceFileResource = Extract<
  ConversationResourceListItem,
  { resourceType: "source_file" }
>;
type GeneratedFileResource = Extract<
  ConversationResourceListItem,
  { resourceType: "generated_file" }
>;
type AnalysisResource = Extract<
  ConversationResourceListItem,
  { resourceType: "analysis" }
>;
type StructuredDataResource = Extract<
  ConversationResourceListItem,
  { resourceType: "structured_data" }
>;

export async function listConversationResources(input: {
  store: PlatformFileStore &
    Pick<ConversationStore, "listMessages"> &
    StructuredDataStore;
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
    ...analysisResources(messages),
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
  const previewArtifact = isImageFileFormat(attachment.format)
    ? undefined
    : userViewableArtifact(attachment, artifactsById);
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

function userViewableArtifact(
  attachment: ConversationAttachment,
  artifactsById: ReadonlyMap<string, ManagedArtifactRecord>
): ManagedArtifactRecord | undefined {
  const referenced = Object.values(attachment.artifactRefs).flatMap((id) => {
    const artifact = artifactsById.get(id);
    return artifact ? [artifact] : [];
  });
  return (
    referenced.find((artifact) => artifact.kind === "document.canonical_pdf") ??
    referenced.find((artifact) => detectArtifactPreviewSourceKind(artifact) !== undefined)
  );
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

function analysisResources(messages: readonly ChatMessage[]): AnalysisResource[] {
  const newestByKey = new Map<string, AnalysisResource>();
  for (const message of messages) {
    if (message.role !== "tool") {
      continue;
    }
    const result = readToolResultMetadata(message.metadata)?.result;
    if (!isJsonObject(result) || result.status !== "success" || !isJsonObject(result.display)) {
      continue;
    }
    const display = result.display;
    const resource = isJsonObject(display.resource) ? display.resource : undefined;
    if (
      resource?.category !== "analysis" ||
      typeof resource.key !== "string" ||
      resource.key.length === 0
    ) {
      continue;
    }
    const existing = newestByKey.get(resource.key);
    if (existing && existing.updatedAt > message.createdAt) {
      continue;
    }
    newestByKey.set(resource.key, {
      resourceType: "analysis",
      resourceId: `analysis:${resource.key}`,
      title: typeof display.title === "string" ? display.title : resource.key,
      createdAt: message.createdAt,
      updatedAt: message.createdAt,
      preview: { kind: "typed_display", display }
    });
  }
  return [...newestByKey.values()];
}
