import {
  authorizeHeldRights,
  isBroadRight,
  operationDenialError,
  type AccessAdministrationStore,
  type ActorAccess,
  type ClientInstanceId,
  type DeniedAssets,
  type HeldRight,
  type OperationAuthorization,
  type RightsTransfer
} from "@vivd-catalyst/core";

/** What placing the denies reads: the assets of asset-scope rows. */
interface DenyPlacementOptions {
  clientInstanceId: ClientInstanceId;
  access: Pick<AccessAdministrationStore, "listGrantScopeAssets">;
}

/**
 * The assets of the call's denies on one asset that a right over a Namespace, a workspace or
 * the instance among these could reach, by id, deleted ones included: a deny outlives its
 * asset. Reads nothing where no such right is asked or the call holds no such deny.
 */
async function deniedAssetsOf(
  options: DenyPlacementOptions,
  access: ActorAccess,
  rights: readonly HeldRight[]
): Promise<DeniedAssets> {
  const assetIds = [
    ...new Set(
      rights
        .filter(isBroadRight)
        .flatMap((right) => access.denials(right.action))
        .flatMap((deny) =>
          deny.scopeKind === "asset" && deny.scopeId !== undefined ? [deny.scopeId] : []
        )
    )
  ];
  if (assetIds.length === 0) return new Map();
  const assets = await options.access.listGrantScopeAssets({
    clientInstanceId: options.clientInstanceId,
    assetIds
  });
  return new Map(assets.map((asset) => [asset.id, asset]));
}

/**
 * The rule of no escalation (`authorizeHeldRights`) with the call's denies placed: a right over
 * a Namespace, a workspace or the instance is refused where a deny of the call lies inside it.
 */
export async function authorizeHeldRightsWithin(
  options: DenyPlacementOptions,
  access: ActorAccess,
  rights: readonly HeldRight[],
  transfer: RightsTransfer
): Promise<OperationAuthorization> {
  return authorizeHeldRights(
    access,
    rights,
    transfer,
    await deniedAssetsOf(options, access, rights)
  );
}

/** `authorizeHeldRightsWithin` for a caller that refuses by throwing: `FORBIDDEN`. */
export async function requireHeldRightsWithin(
  options: DenyPlacementOptions,
  access: ActorAccess,
  rights: readonly HeldRight[],
  transfer: RightsTransfer
): Promise<void> {
  const decision = await authorizeHeldRightsWithin(options, access, rights, transfer);
  if (!decision.allowed) {
    throw operationDenialError({
      kind: "forbidden",
      action: decision.action,
      reason: decision.reason,
      ...(decision.message === undefined ? {} : { message: decision.message })
    });
  }
}
