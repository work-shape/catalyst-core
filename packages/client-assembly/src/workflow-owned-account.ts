import { createHash } from "node:crypto";
import {
  AppError,
  WORKFLOW_ASSET_KIND,
  asUserId,
  isAuthenticatedServicePrincipal,
  isPrincipalGrantableAction,
  moduleOffError,
  requireHeldRights,
  workflowNeededRightResource,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type ModuleSnapshot,
  type PlatformStores,
  type WorkflowManifest,
  type WorkflowNeededRight
} from "@work-shape/catalyst-core";
import { kindOfAction, maySeeAsset, seeAssetAction } from "@work-shape/catalyst-server";

/** The modules of the instance, asked whether the kind of a right is switched off. */
export type WorkflowOwnRightsModules = Pick<ModuleSnapshot, "offModuleOf">;

/**
 * AP-10: only use rights on existing, named assets become the Workflow's grants, asked by the
 * rules of the grant write (`checkPrincipalGrant`): a use right of a kind whose module is on,
 * on an asset the publisher may read (`not_visible`) and holds the right on.
 */
export function checkWorkflowOwnRights(
  manifest: WorkflowManifest,
  rights: readonly WorkflowNeededRight[],
  caller: { actor: AuthenticatedIdentity; access: ActorAccess },
  modules?: WorkflowOwnRightsModules
): void {
  if (isAuthenticatedServicePrincipal(caller.actor))
    throw new AppError("FORBIDDEN", "A person publishes a Workflow", { reason: "user_only" });
  for (const right of rights) {
    if (!isPrincipalGrantableAction(right.action))
      throw new AppError(
        "VALIDATION_FAILED",
        `The Workflow account cannot hold '${right.action}'`,
        {
          reason: "action_not_grantable_to_principal",
          action: right.action
        }
      );
    const module = modules?.offModuleOf("kind", kindOfAction(right.action));
    if (module !== undefined) throw moduleOffError(module);
    if (right.asset.assetId === undefined)
      throw new AppError(
        "VALIDATION_FAILED",
        `The Workflow needs '${right.action}' on an existing asset`,
        {
          reason: "invalid_scope",
          action: right.action
        }
      );
    if (!maySeeAsset(caller.access, workflowNeededRightResource(right)))
      throw new AppError(
        "FORBIDDEN",
        "You may not read this resource, so you cannot give a right on it",
        {
          reason: "not_visible",
          action: seeAssetAction(right.asset.kind)
        }
      );
  }
  requireHeldRights(
    caller.access,
    rights.map((right) => ({
      action: right.action,
      resource: workflowNeededRightResource(right)
    })),
    { lends: { label: manifest.name } }
  );
}

/** Called inside the publish transaction: no identity or grant survives a refused publish. */
export async function publishWorkflowOwnAccount(
  stores: PlatformStores,
  input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    manifest: WorkflowManifest;
    rights: readonly WorkflowNeededRight[];
    actor: AuthenticatedIdentity;
    access: ActorAccess;
    modules?: WorkflowOwnRightsModules;
  }
): Promise<void> {
  const { clientInstanceId, assetId, manifest, rights } = input;
  const owner = { kind: WORKFLOW_ASSET_KIND, assetId };
  const existing = await stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner });
  if (manifest.runAs !== undefined) {
    if (existing)
      await stores.apiAccess.deleteServicePrincipal({
        clientInstanceId,
        servicePrincipalId: existing.id
      });
    return;
  }
  checkWorkflowOwnRights(manifest, rights, input, input.modules);
  const principal =
    existing ??
    (await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      owner,
      name: `wf-${createHash("sha256").update(assetId).digest("hex").slice(0, 48)}`,
      displayLabel: manifest.name
    }));
  const grants = await stores.access.listGrants({
    clientInstanceId,
    holderKind: "service_principal",
    holderId: principal.id
  });
  for (const grant of grants) {
    if (
      !rights.some(
        (right) =>
          right.action === grant.action &&
          right.asset.assetId === grant.scopeId &&
          grant.scopeKind === "asset" &&
          grant.effect === "allow"
      )
    )
      await stores.access.deleteGrant({ clientInstanceId, grantId: grant.id });
  }
  for (const right of rights) {
    if (
      grants.some(
        (grant) =>
          grant.action === right.action &&
          grant.scopeId === right.asset.assetId &&
          grant.scopeKind === "asset" &&
          grant.effect === "allow"
      )
    )
      continue;
    await stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action: right.action,
      effect: "allow",
      scopeKind: "asset",
      scopeId: right.asset.assetId,
      grantedBy: asUserId(input.actor.id)
    });
  }
  await stores.apiAccess.updateServicePrincipal({
    clientInstanceId,
    servicePrincipalId: principal.id,
    status: "active",
    displayLabel: manifest.name
  });
}
