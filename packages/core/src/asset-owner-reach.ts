import type { AppAudience } from "./app-audience";
import type { CollaborationWorkspaceKind } from "./collaboration-workspace";
import type { AgentAvailability } from "./config-assets";

/**
 * The owner of an asset as reach reads it. A Personal Workspace reaches its one owner ("Nur
 * ich"), a Shared Workspace its members ("Team"), the instance everyone ("Alle"). A workspace
 * of unknown kind reaches no further than a Personal Workspace.
 */
export type AssetOwnerReach =
  | { kind: "instance" }
  | {
      kind: "workspace";
      workspaceId: string;
      workspaceKind: CollaborationWorkspaceKind | undefined;
    };

/** What a source does with its owner's reach: name a target, or be offered to people. */
export type OwnerReachUse =
  | {
      kind: "reference";
      target: AssetOwnerReach;
      /** The source's kind trusts run-time grants for this target kind (instance Workflows). */
      acrossOwners?: boolean;
    }
  | { kind: "availability"; availability: AgentAvailability }
  | { kind: "app_audience"; audience: AppAudience };

/** Why a use goes beyond its owner's reach. */
export type OwnerReachRefusal =
  /** The source names an asset of an owner it may not rely on. */
  | "invalid_scope"
  /** An asset of a Personal Workspace is offered beyond its one owner. */
  | "owner_reach"
  /** An App of a Personal Workspace is published for the whole instance (MOVE-1). */
  | "app_instance_needs_shared_workspace";

/**
 * The one decision of who may rely on what (2026-10-28): something shared never relies on or
 * exposes something owned by a Personal Workspace. A source names assets of its own workspace
 * or the instance; an instance Workflow also names a Shared Workspace's assets, whose grants are
 * checked when it runs, never a Personal Workspace's. An asset of a Personal Workspace is
 * offered nowhere beyond its owner: availability selects nothing, and an App is at most for
 * its workspace. A Shared Workspace's asset offered in another workspace or to the whole
 * instance stays an instance admin's step and is not refused here.
 */
export function ownerReachRefusal(
  source: AssetOwnerReach,
  use: OwnerReachUse
): OwnerReachRefusal | undefined {
  switch (use.kind) {
    case "reference": {
      const { target } = use;
      if (target.kind === "instance") return undefined;
      if (source.kind === "workspace" && source.workspaceId === target.workspaceId)
        return undefined;
      if (source.kind === "instance" && use.acrossOwners && target.workspaceKind === "shared")
        return undefined;
      return "invalid_scope";
    }
    case "availability":
      return isPersonal(source) && !offersNowhere(use.availability) ? "owner_reach" : undefined;
    case "app_audience":
      return isPersonal(source) && use.audience === "instance"
        ? "app_instance_needs_shared_workspace"
        : undefined;
  }
}

/** A Personal Workspace, or a workspace of unknown kind. */
function isPersonal(owner: AssetOwnerReach): boolean {
  return owner.kind === "workspace" && owner.workspaceKind !== "shared";
}

function offersNowhere(availability: AgentAvailability): boolean {
  return (
    availability.mode === "selected" &&
    !availability.personalWorkspaces &&
    availability.collaborationWorkspaceIds.length === 0
  );
}
