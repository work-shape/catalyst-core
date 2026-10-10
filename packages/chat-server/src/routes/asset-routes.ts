import { apiOperations } from "@vivd-catalyst/api-contract";
import { asCollaborationWorkspaceId, type OperationResource } from "@vivd-catalyst/core";
import { readDefinitionName } from "../asset-kinds/shared";
import { AssetWorkflow } from "../asset-workflow";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/** The module whose switch turns changing assets through these operations on and off. */
const ASSET_WRITE_MODULE = "assetManagement";

/**
 * One asset of any registered kind. Each call is an Operation Run. The right is the kind's
 * own and is decided on the asset the call names, so every operation brings its check: the
 * registry asks it before the policy, and the workflow asks it again on the asset it loaded.
 * The policy is asked about the kind, the owner and the Namespace of every asset a call names.
 */
export function registerAssetRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new AssetWorkflow(options);

  route.operation(apiOperations["assets.list"], {
    // The list decides the right per asset. A caller without one receives an empty page.
    authorize: () => ({ allowed: true }),
    execute: (input, context) => workflow.list(context, input, context.paging)
  });

  route.operation(apiOperations["assets.sync"], {
    // The right is decided per item, each as its own write or delete, before the policy.
    authorize: (input, { access }) => workflow.authorizeSync(access, input),
    policyTargets: (input) => workflow.syncPolicyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => workflow.sync(context, input)
  });

  route.operation(apiOperations["assets.validate"], {
    authorize: (input, { access }) => workflow.authorizeValidate(access, input),
    resource: (input) => assetResource({ ...input, name: readDefinitionName(input.config) }),
    policyTargets: (input) =>
      workflow.policyTargets({ ...input, name: readDefinitionName(input.config) }),
    execute: (input, context) => workflow.validate(context, input)
  });

  route.operation(apiOperations["assets.get"], {
    authorize: (input, { access }) => workflow.authorizeRead(access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    execute: (input, context) => workflow.get(context, input)
  });

  route.operation(apiOperations["assets.put"], {
    authorize: (input, { access }) => workflow.authorizeWrite(access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => workflow.put(context, input)
  });

  route.operation(apiOperations["assets.delete"], {
    authorize: (input, { access }) => workflow.authorizeDelete(access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => workflow.delete(context, input)
  });

  route.operation(apiOperations["assets.revisions.list"], {
    authorize: (input, { access }) => workflow.authorizeRead(access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    execute: (input, context) => workflow.listRevisions(context, input, context.paging)
  });

  route.operation(apiOperations["assets.revert"], {
    authorize: (input, { access }) => workflow.authorizeWrite(access, input),
    resource: assetResource,
    policyTargets: (input) => workflow.policyTargets(input),
    changeClass: "reversible",
    module: ASSET_WRITE_MODULE,
    execute: (input, context) => workflow.revert(context, input)
  });
}

/** What the call touches, as its run and its events name it. */
function assetResource(input: {
  kind: string;
  name?: string;
  workspaceId?: string;
}): OperationResource | undefined {
  if (input.name === undefined) {
    return undefined;
  }
  return {
    kind: input.kind,
    id: input.name,
    name: input.name,
    ...(input.workspaceId === undefined
      ? {}
      : { workspaceId: asCollaborationWorkspaceId(input.workspaceId) })
  };
}
