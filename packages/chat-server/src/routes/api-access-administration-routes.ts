import { apiOperations } from "@vivd-catalyst/api-contract";
import { ApiAccessAdministrationWorkflow } from "../api-access-administration-workflow";
import type { Route } from "../http/route";
import { requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";

export function registerApiAccessAdministrationRoutes(
  route: Route,
  options: ChatServerOptions
): void {
  const workflow = new ApiAccessAdministrationWorkflow(options);

  route(apiOperations.listServicePrincipals, ({ user, context }) =>
    workflow.listServicePrincipals(user, context)
  );

  route(apiOperations.createServicePrincipal, ({ user, context, body }) =>
    workflow.createServicePrincipal(user, context, body)
  );

  route(apiOperations.updateServicePrincipal, ({ user, context, params, body }) =>
    workflow.updateServicePrincipal(user, context, {
      servicePrincipalId: requirePathParam(params.servicePrincipalId, "Missing servicePrincipalId"),
      ...body
    })
  );

  route(apiOperations.createApiCredential, ({ user, context, params, body }) =>
    workflow.createApiCredential(user, context, {
      servicePrincipalId: requirePathParam(params.servicePrincipalId, "Missing servicePrincipalId"),
      ...body
    })
  );

  route(apiOperations.revokeApiCredential, ({ user, context, params }) =>
    workflow.revokeApiCredential(
      user,
      context,
      requirePathParam(params.credentialId, "Missing credentialId")
    )
  );
}
