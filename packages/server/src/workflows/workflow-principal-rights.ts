import { apiOperations, type WorkflowPrincipalRights } from "@work-shape/catalyst-api-contract";
import {
  AppError,
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  isAppError,
  isPrincipalGrantableAction,
  workflowNeededRightResource,
  type ActorAccess,
  type AuthenticatedUser,
  type WorkflowAccountRights,
  type WorkflowNeededRight,
  type WorkflowRightRefusal
} from "@work-shape/catalyst-core";
import { authorizePrincipalHolderWrite } from "../access/grant-holder-rules";
import { checkPrincipalGrant, grantAssetResource, maySeeAsset } from "../access/principal-grant";
import { accessResource } from "../assets/asset-access";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The operation whose rules a right offered here is asked by: the grant write's own. */
const GRANT_OPERATION = "permissions.grant";

/** The publish screen's read of what the accounts of a Workflow need. */
export function registerWorkflowPrincipalRightsRoutes(
  route: Route,
  options: ChatServerOptions
): void {
  route(apiOperations["workflows.principal_rights"], ({ user, access, params }) =>
    workflowPrincipalRights(options, { actor: user, access }, params.workflow)
  );
}

/**
 * What a publish of the Workflow's newest revision needs of the accounts it runs as, for whoever
 * may publish it. Each right an account lacks says whether the caller could give it as things
 * stand, asked by the grant write's own rules (`checkPrincipalGrant`) without writing; the
 * screen then gives it through that write, which asks every rule again. Where the caller may
 * give a right, it is told the ids the grant names, and otherwise no id at all. A child Workflow
 * the caller may not read is only counted, and an asset it may not read is not named.
 */
async function workflowPrincipalRights(
  options: ChatServerOptions,
  caller: { actor: AuthenticatedUser; access: ActorAccess },
  workflow: string
): Promise<WorkflowPrincipalRights> {
  const kind = options.configAssets.kinds.get(WORKFLOW_ASSET_KIND);
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: WORKFLOW_ASSET_KIND,
    name: workflow
  });
  caller.access.require(WORKFLOW_ACTIONS.publish, {
    kind: WORKFLOW_ASSET_KIND,
    name: workflow,
    ...(asset ? { assetId: asset.id } : {})
  });
  const accounts = asset?.status === "active" ? await kind?.principalRights?.(workflow) : undefined;
  if (!accounts) throw new AppError("NOT_FOUND", "Workflow not found");
  const administers = authorizePrincipalHolderWrite(
    caller.actor,
    caller.access,
    GRANT_OPERATION
  ).allowed;
  // A child the caller may not read is said only as a count of those that lack something.
  const shown: WorkflowAccountRights[] = [];
  let hiddenWorkflows = 0;
  for (const entry of accounts) {
    if (entry.revision === "draft" || (await mayRead(options, caller.access, entry.workflow)))
      shown.push(entry);
    else if (entry.account?.status !== "active" || entry.rights.some((right) => !right.held))
      hiddenWorkflows += 1;
  }
  return {
    administers,
    hiddenWorkflows,
    workflows: await Promise.all(
      shown.map(async (entry) => ({
        workflow: entry.workflow,
        revision: entry.revision,
        runAs: entry.runAs,
        account: entry.account
          ? { label: entry.account.label, status: entry.account.status }
          : { status: "unknown" as const },
        rights: await Promise.all(
          entry.rights.map(async ({ held, ...right }) => {
            // An asset the caller may not read is named by its kind alone and offered to no one.
            const visible = await maySeeNeeded(options, caller.access, right);
            const view = {
              action: right.action,
              asset: visible
                ? { kind: right.asset.kind, name: right.asset.name }
                : { kind: right.asset.kind },
              steps: right.steps,
              neededFor: right.neededFor,
              held
            };
            if (held) return view;
            if (!visible) return { ...view, refusal: "not_visible" as const };
            const outlook = await grantOutlook(options, caller, administers, entry, right);
            return { ...view, ...outlook };
          })
        )
      }))
    )
  };
}

/** Whether the caller may read the Workflow of the name, as its own page asks. */
async function mayRead(
  options: ChatServerOptions,
  access: ActorAccess,
  workflow: string
): Promise<boolean> {
  const asset = await options.configAssets.store.getConfigAsset({
    clientInstanceId: options.clientInstanceId,
    kind: WORKFLOW_ASSET_KIND,
    name: workflow
  });
  return maySeeAsset(
    access,
    asset
      ? accessResource(WORKFLOW_ASSET_KIND, workflow, asset.scope, asset.id)
      : { kind: WORKFLOW_ASSET_KIND, name: workflow }
  );
}

/**
 * Whether the caller may read the asset a needed right is on, decided on the resource the
 * grant write decides it on, with the workspace that owns the asset. An asset of the name that
 * does not exist is decided on its kind and name.
 */
async function maySeeNeeded(
  options: ChatServerOptions,
  access: ActorAccess,
  right: WorkflowNeededRight
): Promise<boolean> {
  const assetId = right.asset.assetId;
  const asset =
    assetId === undefined
      ? undefined
      : await options.stores.access.getGrantableAsset({
          clientInstanceId: options.clientInstanceId,
          assetId
        });
  return maySeeAsset(
    access,
    asset ? grantAssetResource(asset) : workflowNeededRightResource(right)
  );
}

/** Whether the caller could give the account the right now, and the grant it would write. */
async function grantOutlook(
  options: ChatServerOptions,
  caller: { actor: AuthenticatedUser; access: ActorAccess },
  administers: boolean,
  entry: WorkflowAccountRights,
  right: WorkflowNeededRight
): Promise<{ grant: { holderId: string; scopeId: string } } | { refusal: WorkflowRightRefusal }> {
  const account = entry.account;
  if (account?.status !== "active") return { refusal: "account_unavailable" };
  if (!isPrincipalGrantableAction(right.action)) return { refusal: "not_grantable" };
  // Whoever administers no account is told nothing more of the account or the asset.
  if (!administers) return { refusal: "not_administrator" };
  const scopeId = right.asset.assetId;
  if (scopeId === undefined) return { refusal: "asset_unavailable" };
  try {
    await checkPrincipalGrant(options, caller, GRANT_OPERATION, {
      holderId: account.id,
      action: right.action,
      effect: "allow",
      scopeKind: "asset",
      scopeId
    });
    return { grant: { holderId: account.id, scopeId } };
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { refusal: refusalOf(error) };
  }
}

function refusalOf(error: AppError): WorkflowRightRefusal {
  const details: unknown = error.details;
  const reason =
    typeof details === "object" && details !== null && "reason" in details
      ? details.reason
      : undefined;
  if (reason === "not_visible") return "not_visible";
  if (error.code === "FORBIDDEN") return "not_held";
  if (reason === "invalid_scope") return "asset_unavailable";
  if (reason === "unknown_holder") return "account_unavailable";
  return "not_grantable";
}
