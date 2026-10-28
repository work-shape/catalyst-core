import type { AssetScope } from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";

/**
 * Whether a write of an asset that is there goes to its one shared draft, which a publish makes
 * live. Every agent has one. A skill has one where the instance or a Shared Workspace owns it
 * ("Alle", "Team"): an edit there would otherwise change every agent that uses it at once
 * (SKILL-DRAFT-1). A skill of a Personal Workspace ("Nur ich") is used by its owner alone and
 * stays live on save.
 */
export async function writesSharedDraft(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores">,
  kind: string,
  scope: AssetScope
): Promise<boolean> {
  if (kind === "agent") return true;
  if (kind !== "skill") return false;
  return !(await isPersonalScope(options, scope));
}

/** Whether a kind has a shared draft for any of its assets. */
export function hasSharedDrafts(kind: string): boolean {
  return kind === "agent" || kind === "skill";
}

/** Whether the owner is a Personal Workspace. A workspace that is not found is none. */
async function isPersonalScope(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores">,
  scope: AssetScope
): Promise<boolean> {
  if (scope.kind !== "workspace") return false;
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    scope.workspaceId
  );
  return workspace?.personalUserId != null;
}
