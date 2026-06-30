export const WORKSPACE_PROMOTED_ARTIFACTS_DATA_TYPE = "data-workspace-promoted-artifacts";

export interface ToolArtifactDownloadRef {
  artifactId: string;
  kind?: string;
  filename?: string;
  mimeType?: string;
}

export interface WorkspacePromotedArtifactsData {
  kind: "workspace.promoted_artifacts";
  artifacts: ToolArtifactDownloadRef[];
}

export function createWorkspacePromotedArtifactsData(
  artifacts: ToolArtifactDownloadRef[]
): WorkspacePromotedArtifactsData {
  return {
    kind: "workspace.promoted_artifacts",
    artifacts: dedupeToolArtifactRefs(artifacts)
  };
}

export function isWorkspacePromotedArtifactsData(
  value: unknown
): value is WorkspacePromotedArtifactsData {
  const data = isRecord(value) ? value : undefined;
  return data?.kind === "workspace.promoted_artifacts" && readArtifactArray(data.artifacts).length > 0;
}

export function readToolArtifactRefs(result: unknown): ToolArtifactDownloadRef[] {
  const container = isRecord(result) ? result : undefined;
  return readArtifactArray(container?.artifacts);
}

export function readSurfacedToolArtifactRefs(
  result: unknown,
  toolName: string
): ToolArtifactDownloadRef[] {
  if (toolName === "workspace.promote_artifact" || toolName === "workspace.exec") {
    return readToolArtifactRefs(result);
  }
  return [];
}

export function dedupeToolArtifactRefs(
  artifacts: ToolArtifactDownloadRef[]
): ToolArtifactDownloadRef[] {
  const seen = new Set<string>();
  const unique: ToolArtifactDownloadRef[] = [];
  for (const artifact of artifacts) {
    if (seen.has(artifact.artifactId)) {
      continue;
    }
    seen.add(artifact.artifactId);
    unique.push(artifact);
  }
  return unique;
}

function readArtifactArray(value: unknown): ToolArtifactDownloadRef[] {
  const rawArtifacts = Array.isArray(value) ? value : [];
  return rawArtifacts.flatMap((artifact): ToolArtifactDownloadRef[] => {
    if (!isRecord(artifact) || typeof artifact.artifactId !== "string") {
      return [];
    }
    const ref: ToolArtifactDownloadRef = {
      artifactId: artifact.artifactId
    };
    if (typeof artifact.kind === "string") {
      ref.kind = artifact.kind;
    }
    if (typeof artifact.filename === "string") {
      ref.filename = artifact.filename;
    }
    if (typeof artifact.mimeType === "string") {
      ref.mimeType = artifact.mimeType;
    }
    return [ref];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
