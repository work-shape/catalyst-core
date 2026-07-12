import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, type ConfigAssetKind } from "@vivd-catalyst/core";
import { ConfigAssetWorkflow } from "../config-asset-workflow";
import { authenticateConfigAssetRequest, parseBody } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConfigAssetRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const workflow = new ConfigAssetWorkflow({ options });

  app.get(apiOperations.getConfigAssetsOverview.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    return workflow.getOverview(identity, context);
  });

  app.get(apiOperations.getConfigAsset.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    return workflow.getAsset(identity, context, getAssetParams(request.params));
  });

  app.put(apiOperations.putConfigAsset.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    const body = parseBody(apiOperations.putConfigAsset.requestSchema, request.body);
    return workflow.putAsset(identity, context, {
      ...getAssetParams(request.params),
      ...body
    });
  });

  app.post(apiOperations.deleteConfigAsset.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    const body = parseBody(apiOperations.deleteConfigAsset.requestSchema, request.body);
    return workflow.deleteAsset(identity, context, {
      ...getAssetParams(request.params),
      ...body
    });
  });

  app.put(apiOperations.setDefaultConfigAgent.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    const body = parseBody(apiOperations.setDefaultConfigAgent.requestSchema, request.body);
    return workflow.setDefaultAgent(identity, context, body);
  });

  app.get(apiOperations.listConfigAssetRevisions.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    return workflow.listRevisions(identity, context, getAssetParams(request.params));
  });

  app.post(apiOperations.revertConfigAsset.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    const body = parseBody(apiOperations.revertConfigAsset.requestSchema, request.body);
    return workflow.revertAsset(identity, context, {
      ...getAssetParams(request.params),
      ...body
    });
  });

  app.get(apiOperations.exportConfigAssets.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    return workflow.exportAssets(identity, context);
  });

  app.post(apiOperations.replaceConfigAssets.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    const body = parseBody(apiOperations.replaceConfigAssets.requestSchema, request.body);
    return workflow.replaceAssets(identity, context, body);
  });

  app.post(apiOperations.validateConfigAssets.path, async (request) => {
    const { identity, context } = await authenticateConfigAssetRequest(options, request);
    const body = parseBody(apiOperations.validateConfigAssets.requestSchema, request.body);
    return workflow.validateAssets(identity, context, body);
  });
}

function getAssetParams(params: unknown): {
  kind: ConfigAssetKind;
  name: string;
} {
  const typedParams = params as { kind?: string; name?: string };
  if (typedParams.kind !== "agent" && typedParams.kind !== "skill") {
    throw new AppError("VALIDATION_FAILED", "Config asset kind must be 'agent' or 'skill'");
  }
  if (!typedParams.name) {
    throw new AppError("BAD_REQUEST", "Missing config asset name");
  }
  return { kind: typedParams.kind, name: typedParams.name };
}
