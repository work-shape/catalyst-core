import { AppError } from "@vivd-catalyst/core";

const REMOVED_KEY = "collaborationWorkspaces";

/**
 * The `enabled` switch under `ui.collaborationWorkspaces` turned workspaces on per instance until
 * they became part of every instance. For one transition release a config that still says
 * `enabled: true` loads as if the key were absent, so an instance keeps starting while its config
 * is cleaned up. Any other value asks for workspaces to be off, which no longer exists, and is
 * refused.
 *
 * Delete this file and its three callers in the release after the transition release.
 */
export function withoutRemovedWorkspaceSwitch(ui: unknown): unknown {
  if (!isRecord(ui) || !(REMOVED_KEY in ui)) {
    return ui;
  }
  const { [REMOVED_KEY]: removed, ...rest } = ui;
  if (!isEnabledSwitch(removed)) {
    throw new AppError(
      "VALIDATION_FAILED",
      "'ui.collaborationWorkspaces' was removed: workspaces are part of every instance and cannot be turned off. Remove the key from the config."
    );
  }
  return rest;
}

function isEnabledSwitch(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return keys.length === 1 && value.enabled === true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
