import { apiOperations } from "@vivd-catalyst/api-contract";
import { asUserId } from "@vivd-catalyst/core";
import { recordGovernanceAccess } from "../governance-actions";
import type { Route } from "../http/route";
import { requirePathParam } from "../request-context";
import type { ChatServerOptions } from "../types";
import { UserAdministrationWorkflow } from "../user-administration-workflow";

export function registerSuperadminRoutes(route: Route, options: ChatServerOptions): void {
  const userAdministration = new UserAdministrationWorkflow(options);

  route(apiOperations.getUsageSummary, async ({ user, context }) => {
    await recordGovernanceAccess({
      options,
      user,
      context,
      auditType: "governance.usage_viewed"
    });

    return options.usageGovernance.createSafeSummary({
      clientInstanceId: options.clientInstanceId,
      webSearchEnabled: options.config.webAccess.enabled && options.config.webAccess.search.enabled
    });
  });

  route(apiOperations.listAdministeredUsers, async ({ user, context }) => {
    return userAdministration.listUsers(user, context);
  });

  route(apiOperations.createAdministeredUser, async ({ user, context, body }) => {
    return userAdministration.createUser(user, context, {
      displayLabel: body.displayLabel,
      email: body.email,
      roles: body.roles,
      permissionRefs: body.permissionRefs,
      permissions: body.permissions,
      status: body.status,
      passwordSignIn: body.passwordSignIn
    });
  });

  route(apiOperations.updateAdministeredUser, async ({ user, context, params, body }) => {
    const userId = userIdParam(params);
    return userAdministration.updateUser(user, context, {
      userId,
      displayLabel: body.displayLabel,
      email: body.email,
      roles: body.roles,
      permissionRefs: body.permissionRefs,
      permissions: body.permissions,
      status: body.status
    });
  });

  route(apiOperations.deleteAdministeredUser, async ({ user, context, params }) => {
    const userId = userIdParam(params);
    return userAdministration.deleteUser(user, context, {
      userId
    });
  });

  route(apiOperations.upsertAdministeredUserIdentity, async ({ user, context, params, body }) => {
    const userId = userIdParam(params);
    return userAdministration.upsertIdentity(user, context, {
      userId,
      authSource: body.authSource,
      externalUserId: body.externalUserId,
      displayLabel: body.displayLabel,
      email: body.email,
      emailVerified: body.emailVerified
    });
  });

  route(apiOperations.resetAdministeredUserPassword, async ({ user, context, params, body }) => {
    const userId = userIdParam(params);
    return userAdministration.resetPassword(user, context, {
      userId,
      password: body.password
    });
  });

  route(apiOperations.sendAdministeredUserInvitation, async ({ user, context, params }) => {
    return userAdministration.sendInvitation(user, context, {
      userId: userIdParam(params)
    });
  });

  route(apiOperations.deleteAdministeredUserIdentity, async ({ user, context, params }) => {
    return userAdministration.deleteIdentity(user, context, identityParams(params));
  });
}

function userIdParam(params: { userId: string }) {
  return asUserId(requirePathParam(params.userId, "Missing user id"));
}

function identityParams(params: { userId: string; authSource: string; externalUserId: string }) {
  const missing = "Missing user identity mapping parameters";
  return {
    userId: asUserId(requirePathParam(params.userId, missing)),
    authSource: requirePathParam(params.authSource, missing),
    externalUserId: requirePathParam(params.externalUserId, missing)
  };
}
