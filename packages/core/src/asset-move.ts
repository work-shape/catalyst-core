import type { AssetOwnerRung } from "@work-shape/catalyst-asset-schemas";
import type { AssetOwnerReach } from "./asset-owner-reach";

export type {
  AssetMoveEditors,
  AssetMovePath,
  AssetMoveStatus,
  AssetMoveUsers,
  AssetOwnerRung
} from "@work-shape/catalyst-asset-schemas";

const RUNG_ORDER: Record<AssetOwnerRung, number> = { personal: 0, team: 1, everyone: 2 };

/**
 * The rung of an owner on the ladder an asset is shared up (SHARE-1, 2026-10-28). A workspace of
 * unknown kind stands on the lowest rung, as owner reach reads it.
 */
export function assetOwnerRung(owner: AssetOwnerReach): AssetOwnerRung {
  if (owner.kind === "instance") return "everyone";
  return owner.workspaceKind === "shared" ? "team" : "personal";
}

/** Why a move is not a step up the ladder. */
export type AssetMoveLadderRefusal =
  /** The asset already belongs to the owner it is moved to. */
  | "move_same_place"
  /** The owner it is moved to is on a lower rung: sharing is never taken back by a move. */
  | "move_down"
  /** The owner it is moved to is on the same rung: another Personal or Shared Workspace. */
  | "move_sideways";

/**
 * The one decision of where an asset may be moved to (SHARE-1): only up, Nur ich → Team → Alle,
 * never down and never sideways. Whether the kind may be owned there, what comes along and who
 * decides are asked elsewhere; this answers the ladder alone.
 */
export function assetMoveLadderRefusal(
  from: AssetOwnerReach,
  to: AssetOwnerReach
): AssetMoveLadderRefusal | undefined {
  if (
    from.kind === to.kind &&
    (from.kind === "instance" || (to.kind === "workspace" && from.workspaceId === to.workspaceId))
  ) {
    return "move_same_place";
  }
  const step = RUNG_ORDER[assetOwnerRung(to)] - RUNG_ORDER[assetOwnerRung(from)];
  if (step < 0) return "move_down";
  if (step === 0) return "move_sideways";
  return undefined;
}
