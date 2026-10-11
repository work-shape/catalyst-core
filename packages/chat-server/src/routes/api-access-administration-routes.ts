import { apiOperations } from "@vivd-catalyst/api-contract";
import {
  ApiAccessAdministrationWorkflow,
  authorizeApiAccessChange
} from "../api-access-administration-workflow";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/**
 * Instance > API Access. The list is a plain read. The four changes are registered operations:
 * each call is an Operation Run, and only a superadmin who holds `api_access.manage` makes one.
 */
export function registerApiAccessAdministrationRoutes(
  route: Route,
  options: ChatServerOptions
): void {
  const workflow = new ApiAccessAdministrationWorkflow(options);
  const createPrincipal = apiOperations["service_principals.create"];
  const updatePrincipal = apiOperations["service_principals.update"];
  const createCredential = apiOperations["api_credentials.create"];
  const revokeCredential = apiOperations["api_credentials.revoke"];

  route(apiOperations["service_principals.list"], ({ user, context }) =>
    workflow.listServicePrincipals(user, context)
  );

  route.operation(createPrincipal, {
    changeClass: "reversible",
    authorize: authorizeApiAccessChange(createPrincipal.id),
    execute: (input, context) => workflow.createServicePrincipal(context, input)
  });

  route.operation(updatePrincipal, {
    changeClass: "reversible",
    authorize: authorizeApiAccessChange(updatePrincipal.id),
    resource: ({ servicePrincipalId }) => ({ kind: "service_principal", id: servicePrincipalId }),
    execute: (input, context) => workflow.updateServicePrincipal(context, input)
  });

  route.operation(createCredential, {
    // A key can be revoked. Its descriptor declares the answer `secret`: the run keeps none.
    changeClass: "reversible",
    authorize: authorizeApiAccessChange(createCredential.id),
    resource: ({ servicePrincipalId }) => ({ kind: "service_principal", id: servicePrincipalId }),
    execute: (input, context) => workflow.createApiCredential(context, input)
  });

  route.operation(revokeCredential, {
    // A revoked key stays revoked, so the change counts as irreversible.
    authorize: authorizeApiAccessChange(revokeCredential.id),
    resource: ({ credentialId }) => ({ kind: "api_credential", id: credentialId }),
    execute: ({ credentialId }, context) => workflow.revokeApiCredential(context, credentialId)
  });
}
