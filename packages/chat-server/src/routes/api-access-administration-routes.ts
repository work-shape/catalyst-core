import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, requireAuthScope } from "@vivd-catalyst/core";
import type { FastifyInstance } from "fastify";
import { ApiAccessAdministrationWorkflow } from "../api-access-administration-workflow";
import { authenticateRequest, parseBody } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerApiAccessAdministrationRoutes(
  app: FastifyInstance,
  options: ChatServerOptions
): void {
  const workflow = new ApiAccessAdministrationWorkflow(options);

  app.get(apiOperations.listServicePrincipals.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "api_access:read");
    return workflow.listServicePrincipals(user, context);
  });

  app.post(apiOperations.createServicePrincipal.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "api_access:write");
    const body = parseBody(apiOperations.createServicePrincipal.requestSchema, request.body);
    return workflow.createServicePrincipal(user, context, body);
  });

  app.patch(apiOperations.updateServicePrincipal.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "api_access:write");
    const body = parseBody(apiOperations.updateServicePrincipal.requestSchema, request.body);
    return workflow.updateServicePrincipal(user, context, {
      servicePrincipalId: getPathParam(request.params, "servicePrincipalId"),
      ...body
    });
  });

  app.post(apiOperations.createApiCredential.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "api_access:write");
    const body = parseBody(apiOperations.createApiCredential.requestSchema, request.body);
    return workflow.createApiCredential(user, context, {
      servicePrincipalId: getPathParam(request.params, "servicePrincipalId"),
      ...body
    });
  });

  app.post(apiOperations.revokeApiCredential.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "api_access:write");
    return workflow.revokeApiCredential(
      user,
      context,
      getPathParam(request.params, "credentialId")
    );
  });
}

function getPathParam(params: unknown, name: string): string {
  const value = (params as Record<string, string | undefined>)[name];
  if (!value) {
    throw new AppError("BAD_REQUEST", `Missing ${name}`);
  }
  return value;
}
