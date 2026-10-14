import {
  LEGACY_PERMISSION_ACTIONS,
  authorizeHeldRights,
  isAuthenticatedServicePrincipal,
  isSuperadmin,
  legacyKeysHeld,
  type AccessAdministrationStore,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type GrantScopeAsset,
  type HeldRight,
  type OperationAuthorization,
  type ServicePrincipalRecord
} from "@vivd-catalyst/core";

/** What the rights of a service principal are read from: its grant rows and their assets. */
export interface PrincipalRightsOptions {
  clientInstanceId: ClientInstanceId;
  access: Pick<AccessAdministrationStore, "loadPersistedAccess" | "listGrantScopeAssets">;
}

/**
 * The legacy key whose one action, `assets.release`, no role holds. A service principal that
 * holds it releases config; whoever makes one is a superadmin, by name, not by the rule, and
 * no Workflow runs as one (`requireWorkflowRunAs`).
 */
export const RELEASE_KEY = "config_assets.release";

/**
 * Every right a service principal acts with, as whoever gives or lends them must hold them:
 * each legacy key it holds as the key, each other instance-wide allow as its action, and each
 * allow in a Namespace, a workspace or on one asset on that resource, with the asset's kind,
 * name and owner. A deny is left out: holding one lends nothing.
 */
export async function principalRights(
  options: PrincipalRightsOptions,
  principalId: string
): Promise<HeldRight[]> {
  const { grants } = await options.access.loadPersistedAccess({
    clientInstanceId: options.clientInstanceId,
    holder: { kind: "service_principal", id: principalId }
  });
  const rows = grants.filter(
    (row) => row.holderKind === "service_principal" && row.holderId === principalId
  );
  const keys = legacyKeysHeld(rows);
  const keyActions = new Set<string>(keys.flatMap((key) => LEGACY_PERMISSION_ACTIONS[key]));
  const allows = rows.filter((row) => row.effect === "allow");
  const assetIds = allows.flatMap((row) =>
    row.scopeKind === "asset" && row.scopeId !== undefined ? [row.scopeId] : []
  );
  const assets = new Map(
    (assetIds.length === 0
      ? []
      : await options.access.listGrantScopeAssets({
          clientInstanceId: options.clientInstanceId,
          assetIds
        })
    ).map((asset) => [asset.id, asset])
  );
  return [
    ...keys.map((key): HeldRight => ({ action: key })),
    ...allows.flatMap((row): HeldRight[] => {
      if (row.scopeKind === "asset" && row.scopeId !== undefined) {
        const asset = assets.get(row.scopeId);
        // A row whose asset the store no longer knows is decided on its id alone.
        return [
          asset
            ? assetRight(row.action, asset)
            : { action: row.action, resource: { assetId: row.scopeId } }
        ];
      }
      // A principal is given a right on one asset only (`grantToPrincipal`). A row at another
      // scope, which no write makes, is asked of the whole instance: the strictest reading.
      return keyActions.has(row.action) ? [] : [{ action: row.action }];
    })
  ];
}

/** A right on one asset, as the evaluator decides it: by kind, name, id and owner. */
export function assetRight(
  action: string,
  asset: Pick<GrantScopeAsset, "id" | "kind" | "name" | "workspaceId">
): HeldRight {
  return {
    action,
    resource: {
      kind: asset.kind,
      name: asset.name,
      assetId: asset.id,
      ...(asset.workspaceId === undefined ? {} : { workspaceId: asset.workspaceId })
    }
  };
}

/**
 * Whether the caller may give these rights to a service principal, or lend them to it by
 * enabling it or issuing it a key: the rule of no escalation, with one named exception. The
 * release key is given by a superadmin alone, since no person holds `assets.release`.
 */
export function authorizeGivingToPrincipal(
  caller: { actor: AuthenticatedIdentity; access: ActorAccess },
  principal: Pick<ServicePrincipalRecord, "displayLabel">,
  rights: readonly HeldRight[]
): OperationAuthorization {
  const { actor } = caller;
  const superadmin = !isAuthenticatedServicePrincipal(actor) && isSuperadmin(actor);
  if (rights.some((right) => right.action === RELEASE_KEY) && !superadmin) {
    return {
      allowed: false,
      action: RELEASE_KEY,
      reason: "no_grant",
      message: `Only a superadmin gives a service principal '${RELEASE_KEY}', lends it by enabling the principal or issues it a key`
    };
  }
  return authorizeHeldRights(
    caller.access,
    rights.filter((right) => right.action !== RELEASE_KEY),
    { lends: { label: principal.displayLabel } }
  );
}
