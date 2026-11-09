import type { AssetScope } from "@work-shape/catalyst-core";
import type { AssetWorkflowOptions } from "../types";

/**
 * Whether a write of an asset that is there goes to its one shared draft, which a publish makes
 * live. Every agent has one. A skill has none: a save is live, or files a request where its
 * writer may not make it live (SKILL-LIVE-1).
 */
export function writesSharedDraft(kind: string): boolean {
  return kind === "agent";
}

/**
 * Whether a kind may hold a shared draft for one of its assets. A skill's can be there from
 * before SKILL-LIVE-1: it is still read, published and discarded, and no new one is written.
 */
export function hasSharedDrafts(kind: string): boolean {
  return kind === "agent" || kind === "skill";
}

/**
 * Whether going live takes `skill.publish`: everywhere but in a Personal Workspace ("Nur ich"),
 * whose skill its owner alone uses. A workspace that is not found is none.
 */
export async function skillLiveNeedsPublish(
  options: Pick<AssetWorkflowOptions, "clientInstanceId" | "stores">,
  scope: AssetScope
): Promise<boolean> {
  if (scope.kind !== "workspace") return true;
  const workspace = await options.stores.workspaces.getWorkspace(
    options.clientInstanceId,
    scope.workspaceId
  );
  return workspace?.personalUserId == null;
}
