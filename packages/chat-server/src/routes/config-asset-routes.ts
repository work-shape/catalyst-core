import { apiOperations } from "@vivd-catalyst/api-contract";
import { ConfigAssetWorkflow } from "../config-asset-workflow";
import type { Route } from "../http/route";
import { requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConfigAssetRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new ConfigAssetWorkflow({ options });

  route(apiOperations["config_assets.get_overview"], ({ identity, context }) =>
    workflow.getOverview(identity, context)
  );

  route(apiOperations["config_agents.set_default"], ({ identity, context, body }) =>
    workflow.setDefaultAgent(identity, context, body)
  );

  route(apiOperations["config_agents.set_availability"], ({ identity, context, params, body }) =>
    workflow.setAgentAvailability(identity, context, {
      agentName: requirePathParam(params.name, "Missing config asset name"),
      ...body
    })
  );

  route(apiOperations["instance.workspaces.list"], () => workflow.listAdministeredWorkspaces());

  route(apiOperations["config_assets.export"], ({ identity, context }) =>
    workflow.exportAssets(identity, context)
  );

  route(apiOperations["config_assets.replace"], ({ identity, access, context, body }) =>
    workflow.replaceAssets(identity, access, context, body)
  );

  route(apiOperations["config_assets.validate"], ({ identity, access, context, body }) =>
    workflow.validateAssets(identity, access, context, body)
  );
}
