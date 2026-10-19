import { apiOperations } from "@work-shape/catalyst-api-contract";
import { WORKFLOW_ASSET_KIND, WORKFLOW_ACTIONS } from "@work-shape/catalyst-core";
import { AssetWorkflow } from "../assets/asset-service";
import { accessResource, decide } from "../assets/asset-access";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

export function registerWorkflowUnpublishRoute(route: Route, options: ChatServerOptions): void {
  const workflow = new AssetWorkflow(options);
  route.operation(apiOperations["workflows.unpublish"], {
    resource: (input) => ({ kind: WORKFLOW_ASSET_KIND, id: input.workflow, name: input.workflow }),
    authorize: async (input, { access }) => {
      const asset = await options.configAssets.store.getConfigAsset({
        clientInstanceId: options.clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: input.workflow
      });
      return decide(
        access,
        WORKFLOW_ACTIONS.publish,
        asset
          ? accessResource(WORKFLOW_ASSET_KIND, asset.name, asset.scope, asset.id)
          : { kind: WORKFLOW_ASSET_KIND, name: input.workflow }
      );
    },
    changeClass: "reversible",
    module: "workflows",
    execute: (input, context) =>
      workflow.drafts.unpublish(context, { kind: WORKFLOW_ASSET_KIND, name: input.workflow })
  });
}
