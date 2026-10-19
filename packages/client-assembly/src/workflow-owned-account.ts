import { createHash } from "node:crypto";
import {
  AppError,
  WORKFLOW_ASSET_KIND,
  asUserId,
  isAuthenticatedServicePrincipal,
  isPrincipalGrantableAction,
  requireHeldRights,
  workflowNeededRightResource,
  type ActorAccess,
  type AuthenticatedIdentity,
  type ClientInstanceId,
  type PlatformStores,
  type WorkflowManifest,
  type WorkflowNeededRight
} from "@work-shape/catalyst-core";

/** AP-10: only use rights on existing, named assets become the Workflow's grants. */
export function checkWorkflowOwnRights(
  manifest: WorkflowManifest,
  rights: readonly WorkflowNeededRight[],
  caller: { actor: AuthenticatedIdentity; access: ActorAccess }
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
    if (right.asset.assetId === undefined)
      throw new AppError(
        "VALIDATION_FAILED",
        `The Workflow needs '${right.action}' on an existing asset`,
        {
          reason: "invalid_scope",
          action: right.action
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
  checkWorkflowOwnRights(manifest, rights, input);
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
