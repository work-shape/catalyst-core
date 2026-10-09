import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, type ConfigAssetKind } from "@vivd-catalyst/core";
import { ConfigAssetWorkflow } from "../config-asset-workflow";
import type { Route } from "../http/route";
import { requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConfigAssetRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new ConfigAssetWorkflow({ options });

  route(apiOperations.getConfigAssetsOverview, ({ identity, context }) =>
    workflow.getOverview(identity, context)
  );

  route(apiOperations.getConfigAsset, ({ identity, params }) =>
    workflow.getAsset(identity, assetParams(params))
  );

  route(apiOperations.putConfigAsset, ({ identity, context, params, body }) =>
    workflow.putAsset(identity, context, { ...assetParams(params), ...body })
  );

  route(apiOperations.deleteConfigAsset, ({ identity, context, params, body }) =>
    workflow.deleteAsset(identity, context, { ...assetParams(params), ...body })
  );

  route(apiOperations.setDefaultConfigAgent, ({ identity, context, body }) =>
    workflow.setDefaultAgent(identity, context, body)
  );

  route(apiOperations.setConfigAgentAvailability, ({ identity, context, params, body }) =>
    workflow.setAgentAvailability(identity, context, {
      agentName: requirePathParam(params.name, "Missing config asset name"),
      ...body
    })
  );

  route(apiOperations.listAdministeredCollaborationWorkspaces, () =>
    workflow.listAdministeredWorkspaces()
  );

  route(apiOperations.listConfigAssetRevisions, ({ identity, params, paging }) =>
    workflow.listRevisions(identity, { ...assetParams(params), page: paging })
  );

  route(apiOperations.revertConfigAsset, ({ identity, context, params, body }) =>
    workflow.revertAsset(identity, context, { ...assetParams(params), ...body })
  );

  route(apiOperations.exportConfigAssets, ({ identity, context }) =>
    workflow.exportAssets(identity, context)
  );

  route(apiOperations.replaceConfigAssets, ({ identity, context, body }) =>
    workflow.replaceAssets(identity, context, body)
  );

  route(apiOperations.validateConfigAssets, ({ identity, context, body }) =>
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
