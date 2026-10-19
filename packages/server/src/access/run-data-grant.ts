import {
  WORKFLOW_ASSET_KIND,
  type ActorAccess,
  type ApiAccessStore,
  type ConfigAssetStore,
  type OperationAuthorization
} from "@work-shape/catalyst-core";
import { authorizeHeldRightsWithin } from "./held-rights-within";
import { principalRights, type PrincipalRightsOptions } from "./principal-rights";

/** The right whose rows copy what a Workflow's principal reads (D4). */
export const READ_RUN_DATA_ACTION = "workflow.read_run_data";

/** What the check reads: the Workflow's revisions, the principals by name and their rows. */
export interface RunDataGrantOptions extends PrincipalRightsOptions {
  configAssets: Pick<ConfigAssetStore, "getConfigAsset">;
  apiAccess: Pick<ApiAccessStore, "findServicePrincipalByName" | "findServicePrincipalByOwner">;
}

/**
 * Whether the call may give a person `workflow.read_run_data` on one Workflow (RIGHTS-1c, D4).
 * The rows of a run's datasets are what the Workflow's principal read, so reading them is
 * lending that principal's reading: the call holds every right of the principal its published
 * revision names and of the one its newest revision names, as a publish of either would ask.
 * A Workflow-owned principal is checked by owner, including when runAs is omitted.
 */
export async function authorizeRunDataGrant(
  options: RunDataGrantOptions,
  access: ActorAccess,
  workflowName: string
): Promise<OperationAuthorization> {
  const workflow = await options.configAssets.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: WORKFLOW_ASSET_KIND,
    name: workflowName
  });
  let needsOwnAccount = false;
  const names = new Set(
    [workflow?.publishedConfig, workflow?.config].flatMap((config) => {
      const manifest = config?.["manifest"];
      const runAs =
        typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
          ? manifest["runAs"]
          : undefined;
      if (
        typeof manifest === "object" &&
        manifest !== null &&
        !Array.isArray(manifest) &&
        runAs === undefined
      )
        needsOwnAccount = true;
      return typeof runAs === "string" && runAs !== "" ? [runAs] : [];
    })
  );
  const principals = [];
  const owned = workflow
    ? await options.apiAccess.findServicePrincipalByOwner({
        clientInstanceId: options.clientInstanceId,
        owner: { kind: WORKFLOW_ASSET_KIND, assetId: workflow.id }
      })
    : undefined;
  // Withdrawal keeps history but removes the identity. It cannot silently make that
  // history lendable without checking a principal's rights.
  if (needsOwnAccount && !owned)
    return { allowed: false, action: READ_RUN_DATA_ACTION, reason: "no_grant" };
  if (owned) principals.push(owned);
  for (const name of names) {
    const principal = await options.apiAccess.findServicePrincipalByName({
      clientInstanceId: options.clientInstanceId,
      name
    });
    if (principal) principals.push(principal);
  }
  for (const principal of principals) {
    const decision = await authorizeHeldRightsWithin(
      options,
      access,
      await principalRights(options, principal.id),
      { lends: { label: principal.displayLabel } }
    );
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}
