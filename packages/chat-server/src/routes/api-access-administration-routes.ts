import { apiOperations } from "@vivd-catalyst/api-contract";
import { ApiAccessAdministrationWorkflow } from "../api-access-administration-workflow";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";

/**
 * Instance > API Access. The list is a plain read. The four changes are registered operations:
 * each call is an Operation Run. Principals are administered under `service_principals.manage`,
 * their keys under `api_access.manage`, and what either gives a principal asks the rule of no
 * escalation.
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
    authorize: (input, caller) =>
      workflow.authorizeCreatePrincipal(createPrincipal.id, caller, input),
    execute: (input, context) => workflow.createServicePrincipal(createPrincipal.id, context, input)
  });

  route.operation(updatePrincipal, {
    changeClass: "reversible",
    authorize: (input, caller) =>
      workflow.authorizeUpdatePrincipal(updatePrincipal.id, caller, input),
    resource: ({ servicePrincipalId }) => ({ kind: "service_principal", id: servicePrincipalId }),
    execute: (input, context) => workflow.updateServicePrincipal(updatePrincipal.id, context, input)
  });

  route.operation(createCredential, {
    // A key can be revoked. Its descriptor declares the answer `secret`: the run keeps none.
    changeClass: "reversible",
    authorize: (input, caller) =>
      workflow.authorizeCreateCredential(createCredential.id, caller, input),
    resource: ({ servicePrincipalId }) => ({ kind: "service_principal", id: servicePrincipalId }),
    execute: (input, context) => workflow.createApiCredential(createCredential.id, context, input)
  });

  route.operation(revokeCredential, {
    // A revoked key stays revoked, so the change counts as irreversible.
    authorize: (_input, caller) => workflow.authorizeRevokeCredential(revokeCredential.id, caller),
    resource: ({ credentialId }) => ({ kind: "api_credential", id: credentialId }),
    execute: ({ credentialId }, context) => workflow.revokeApiCredential(context, credentialId)
  });
}
