import { type WorkspaceFile } from "@work-shape/catalyst-core";

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function workspaceFileMetadataForUpsert(
  metadata: WorkspaceFile["metadata"],
  existing: WorkspaceFile | undefined,
  nextObjectKey: string
): WorkspaceFile["metadata"] {
  if (!existing || existing.objectKey === nextObjectKey) {
    return preserveRetainedObjectKeys(metadata, existing?.metadata);
  }
  return workspaceFileMetadataWithRetainedObjectKey(
    preserveRetainedObjectKeys(metadata, existing.metadata),
    existing.objectKey
  );
}

export function workspaceFileMetadataWithRetainedObjectKey(
  metadata: WorkspaceFile["metadata"],
  objectKey: string
): WorkspaceFile["metadata"] {
  return {
    ...metadata,
    retainedObjectKeys: uniqueStrings([...retainedObjectKeys(metadata), objectKey])
  };
}

function preserveRetainedObjectKeys(
  metadata: WorkspaceFile["metadata"],
  existingMetadata: WorkspaceFile["metadata"] | undefined
): WorkspaceFile["metadata"] {
  const retained = retainedObjectKeys(existingMetadata);
  return retained.length > 0
    ? {
        ...metadata,
        retainedObjectKeys: uniqueStrings([...retainedObjectKeys(metadata), ...retained])
      }
    : metadata;
}

export function retainedObjectKeys(metadata: WorkspaceFile["metadata"] | undefined): string[] {
  const value = metadata?.retainedObjectKeys;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
