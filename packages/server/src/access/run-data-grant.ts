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
  apiAccess: Pick<ApiAccessStore, "findServicePrincipalByName">;
}

/**
 * Whether the call may give a person `workflow.read_run_data` on one Workflow (RIGHTS-1c, D4).
 * The rows of a run's datasets are what the Workflow's principal read, so reading them is
 * lending that principal's reading: the call holds every right of the principal its published
 * revision names and of the one its newest revision names, as a publish of either would ask.
 * A Workflow that names no principal, or one this instance does not have, lends nothing.
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
  const names = new Set(
    [workflow?.publishedConfig, workflow?.config].flatMap((config) => {
      const manifest = config?.["manifest"];
      const runAs =
        typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
          ? manifest["runAs"]
          : undefined;
      return typeof runAs === "string" && runAs !== "" ? [runAs] : [];
    })
  );
  for (const name of names) {
    const principal = await options.apiAccess.findServicePrincipalByName({
      clientInstanceId: options.clientInstanceId,
      name
    });
    if (!principal) continue;
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
