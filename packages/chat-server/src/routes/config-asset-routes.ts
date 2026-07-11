import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, type ConfigAssetKind } from "@vivd-catalyst/core";
import { ConfigAssetWorkflow } from "../config-asset-workflow";
import { authenticateRequest, parseBody } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerConfigAssetRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const workflow = new ConfigAssetWorkflow({ options });

  app.get(apiOperations.getConfigAssetsOverview.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return workflow.getOverview(user, context);
  });

  app.get(apiOperations.getConfigAsset.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return workflow.getAsset(user, context, getAssetParams(request.params));
  });

  app.put(apiOperations.putConfigAsset.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(apiOperations.putConfigAsset.requestSchema, request.body);
    return workflow.putAsset(user, context, {
      ...getAssetParams(request.params),
      ...body
    });
  });

  app.post(apiOperations.deleteConfigAsset.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(apiOperations.deleteConfigAsset.requestSchema, request.body);
    return workflow.deleteAsset(user, context, {
      ...getAssetParams(request.params),
      ...body
    });
  });

  app.put(apiOperations.setDefaultConfigAgent.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(apiOperations.setDefaultConfigAgent.requestSchema, request.body);
    return workflow.setDefaultAgent(user, context, body);
  });

  app.get(apiOperations.listConfigAssetRevisions.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return workflow.listRevisions(user, context, getAssetParams(request.params));
  });

  app.post(apiOperations.revertConfigAsset.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(apiOperations.revertConfigAsset.requestSchema, request.body);
    return workflow.revertAsset(user, context, {
      ...getAssetParams(request.params),
      ...body
    });
  });

  app.get(apiOperations.exportConfigAssets.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return workflow.exportAssets(user, context);
  });

  app.post(apiOperations.replaceConfigAssets.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(apiOperations.replaceConfigAssets.requestSchema, request.body);
    return workflow.replaceAssets(user, context, body);
  });

  app.post(apiOperations.validateConfigAssets.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(apiOperations.validateConfigAssets.requestSchema, request.body);
    return workflow.validateAssets(user, context, body);
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
