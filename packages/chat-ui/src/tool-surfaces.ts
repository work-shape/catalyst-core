import {
  isToolDisplayPayload,
  type ToolDisplayPayload
} from "./domain-ui-widgets";

export const WORKSPACE_PROMOTED_SURFACES_DATA_TYPE = "data-workspace-promoted-surfaces";

export interface ToolSurfaceRef {
  surfaceId: string;
  display: ToolDisplayPayload;
  toolCallId?: string;
  toolName?: string;
  title?: string;
}

export interface WorkspacePromotedSurfacesData {
  kind: "workspace.promoted_surfaces";
  surfaces: ToolSurfaceRef[];
}

export function createWorkspacePromotedSurfacesData(
  surfaces: ToolSurfaceRef[]
): WorkspacePromotedSurfacesData {
  return {
    kind: "workspace.promoted_surfaces",
    surfaces: dedupeToolSurfaceRefs(surfaces)
  };
}

export function isWorkspacePromotedSurfacesData(
  value: unknown
): value is WorkspacePromotedSurfacesData {
  return readWorkspacePromotedSurfacesData(value) !== undefined;
}

export function readWorkspacePromotedSurfacesData(
  value: unknown
): WorkspacePromotedSurfacesData | undefined {
  const data = isRecord(value) ? value : undefined;
  if (data?.kind !== "workspace.promoted_surfaces") {
    return undefined;
  }
  const surfaces = readSurfaceArray(data.surfaces);
  return surfaces.length > 0
    ? {
        kind: "workspace.promoted_surfaces",
        surfaces
      }
    : undefined;
}

export function readToolSurfaceRefs(
  result: unknown,
  input: {
    toolCallId?: string;
    toolName?: string;
  } = {}
): ToolSurfaceRef[] {
  const container = isRecord(result) ? result : undefined;
  const display = isToolDisplayPayload(container?.display) ? container.display : undefined;
  if (!display) {
    return [];
  }
  const surface = sanitizeToolSurfaceRef({
    surfaceId: readDisplayId(display, input),
    display,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    title: readDisplayTitle(display)
  });
  return surface ? [surface] : [];
}

export function dedupeToolSurfaceRefs(surfaces: ToolSurfaceRef[]): ToolSurfaceRef[] {
  const seen = new Set<string>();
  const unique: ToolSurfaceRef[] = [];
  for (const surface of surfaces) {
    const sanitized = sanitizeToolSurfaceRef(surface);
    if (!sanitized || seen.has(sanitized.surfaceId)) {
      continue;
    }
    seen.add(sanitized.surfaceId);
    unique.push(sanitized);
  }
  return unique;
}

function readSurfaceArray(value: unknown): ToolSurfaceRef[] {
  const rawSurfaces = Array.isArray(value) ? value : [];
  return rawSurfaces.flatMap((surface): ToolSurfaceRef[] =>
    isRecord(surface) ? maybeOne(sanitizeToolSurfaceRef(surface)) : []
  );
}

function sanitizeToolSurfaceRef(surface: {
  surfaceId?: unknown;
  display?: unknown;
  toolCallId?: unknown;
  toolName?: unknown;
  title?: unknown;
}): ToolSurfaceRef | undefined {
  const surfaceId = readSafeIdentifier(surface.surfaceId);
  if (!surfaceId || !isToolDisplayPayload(surface.display)) {
    return undefined;
  }
  const ref: ToolSurfaceRef = {
    surfaceId,
    display: surface.display
  };
  const toolCallId = readSafeIdentifier(surface.toolCallId);
  if (toolCallId) {
    ref.toolCallId = toolCallId;
  }
  const toolName = readSafeToolName(surface.toolName);
  if (toolName) {
    ref.toolName = toolName;
  }
  const title = readDisplayLabel(surface.title);
  if (title) {
    ref.title = title;
  }
  return ref;
}

function readDisplayId(
  display: ToolDisplayPayload,
  input: {
    toolCallId?: string;
    toolName?: string;
  }
): string {
  const displayId = readSafeIdentifier(display.displayId);
  if (displayId) {
    return displayId;
  }
  if (input.toolCallId) {
    return `tool:${input.toolCallId}`;
  }
  const kind = readSafeToolName(display.kind);
  if (kind) {
    return `display:${kind}`;
  }
  return input.toolName ? `tool:${input.toolName}` : "tool:display";
}

function readDisplayTitle(display: ToolDisplayPayload): string | undefined {
  const title = readDisplayLabel(display.title);
  if (title) {
    return title;
  }
  const dataTitle = isRecord(display.data) ? readDisplayLabel(display.data.title) : undefined;
  if (dataTitle) {
    return dataTitle;
  }
  return readDisplayLabel(display.kind);
}

function readSafeIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 200 ? trimmed : undefined;
}

function readSafeToolName(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 200) {
    return undefined;
  }
  return /^[a-z0-9][a-z0-9_.:-]*$/iu.test(value) ? value : undefined;
}

function readDisplayLabel(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 160 ? trimmed : undefined;
}

function maybeOne<T>(value: T | undefined): T[] {
  return value === undefined ? [] : [value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
