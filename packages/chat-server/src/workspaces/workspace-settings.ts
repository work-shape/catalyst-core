import {
  AppError,
  WORKSPACE_ACCENT_COLORS,
  type CollaborationWorkspace,
  type WorkspaceAccentColor
} from "@work-shape/catalyst-core";
import { type UpdateWorkspaceSettingsCommand } from "./workspace-service-types";

const MAX_WORKSPACE_NAME_LENGTH = 120;

const MAX_WORKSPACE_DESCRIPTION_LENGTH = 500;

const MAX_WORKSPACE_EMOJI_LENGTH = 32;

export function normalizeRequiredName(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new AppError("VALIDATION_FAILED", "Workspace name is required");
  if (normalized.length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Workspace name must be at most ${MAX_WORKSPACE_NAME_LENGTH} characters`
    );
  }
  return normalized;
}

export function normalizeDescription(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > MAX_WORKSPACE_DESCRIPTION_LENGTH) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Workspace description must be at most ${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters`
    );
  }
  return normalized || null;
}

export function normalizeEmoji(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const normalized = value.trim();
  if (normalized.length > MAX_WORKSPACE_EMOJI_LENGTH) {
    throw new AppError(
      "VALIDATION_FAILED",
      `Workspace emoji must be at most ${MAX_WORKSPACE_EMOJI_LENGTH} characters`
    );
  }
  return normalized || null;
}

export function validateAccentColor(
  value: WorkspaceAccentColor | null | undefined
): WorkspaceAccentColor | null {
  if (value === undefined || value === null) return null;
  if (!WORKSPACE_ACCENT_COLORS.includes(value)) {
    throw new AppError("VALIDATION_FAILED", "Workspace accent color is not available");
  }
  return value;
}

export function workspaceChangedFields(
  workspace: CollaborationWorkspace,
  update: UpdateWorkspaceSettingsCommand
): string[] {
  return (
    [
      "name",
      "description",
      "visibility",
      "defaultConversationVisibility",
      "emoji",
      "accentColor"
    ] as const
  ).filter((field) => update[field] !== undefined && update[field] !== workspace[field]);
}
