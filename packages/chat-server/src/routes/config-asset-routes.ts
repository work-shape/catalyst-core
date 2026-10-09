import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, type ConfigAssetKind } from "@vivd-catalyst/core";
import { ConfigAssetWorkflow } from "../config-asset-workflow";
import type { Route } from "../http/route";
import { requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConfigAssetRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new ConfigAssetWorkflow({ options });

  route(apiOperations["config_assets.get_overview"], ({ identity, context }) =>
    workflow.getOverview(identity, context)
  );

  route(apiOperations["config_assets.get"], ({ identity, params }) =>
    workflow.getAsset(identity, assetParams(params))
  );

  route(apiOperations["config_assets.put"], ({ identity, context, params, body }) =>
    workflow.putAsset(identity, context, { ...assetParams(params), ...body })
  );

  route(apiOperations["config_assets.delete"], ({ identity, context, params, body }) =>
    workflow.deleteAsset(identity, context, { ...assetParams(params), ...body })
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

  route(apiOperations["config_assets.revisions.list"], ({ identity, params, paging }) =>
    workflow.listRevisions(identity, { ...assetParams(params), page: paging })
  );

  route(apiOperations["config_assets.revert"], ({ identity, context, params, body }) =>
    workflow.revertAsset(identity, context, { ...assetParams(params), ...body })
  );

  route(apiOperations["config_assets.export"], ({ identity, context }) =>
    workflow.exportAssets(identity, context)
  );

  route(apiOperations["config_assets.replace"], ({ identity, context, body }) =>
    workflow.replaceAssets(identity, context, body)
  );

  route(apiOperations["config_assets.validate"], ({ identity, context, body }) =>
    workflow.validateAssets(identity, context, body)
  );
}

function assetParams(params: { kind: string; name: string }): {
  kind: ConfigAssetKind;
  name: string;
} {
  if (params.kind !== "agent" && params.kind !== "skill") {
    throw new AppError("VALIDATION_FAILED", "Config asset kind must be 'agent' or 'skill'");
  }
  return {
    kind: params.kind,
    name: requirePathParam(params.name, "Missing config asset name")
  };
}
