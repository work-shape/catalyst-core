import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { AppError, asUserId, requireAuthScope } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "../types";
import { authorizeGovernanceAction } from "../governance-actions";
import { authenticateRequest, parseBody } from "../request-context";
import { UserAdministrationWorkflow } from "../user-administration-workflow";

export function registerSuperadminRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const userAdministration = new UserAdministrationWorkflow(options);

  app.get(apiOperations.getUsageSummary.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "governance:read");
    await authorizeGovernanceAction({
      options,
      user,
      context,
      requiredRole: "superadmin",
      auditType: "governance.usage_viewed",
      deniedMessage: "Usage governance requires a superadmin role"
    });

    return options.usageGovernance.createSummary({
      clientInstanceId: options.clientInstanceId
    });
  });

  app.get(apiOperations.listAdministeredUsers.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "user_admin:read");
    return userAdministration.listUsers(user, context);
  });

  app.post(apiOperations.createAdministeredUser.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "user_admin:write");
    const body = parseBody(apiOperations.createAdministeredUser.requestSchema, request.body);
    return userAdministration.createUser(user, context, {
      displayLabel: body.displayLabel,
      email: body.email,
      roles: body.roles,
      permissionRefs: body.permissionRefs,
      status: body.status
    });
  });

  app.patch(apiOperations.updateAdministeredUser.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "user_admin:write");
    const body = parseBody(apiOperations.updateAdministeredUser.requestSchema, request.body);
    const userId = getUserIdParam(request.params);
    return userAdministration.updateUser(user, context, {
      userId,
      displayLabel: body.displayLabel,
      email: body.email,
      roles: body.roles,
      permissionRefs: body.permissionRefs,
      status: body.status
    });
  });

  app.put(apiOperations.upsertAdministeredUserIdentity.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "user_admin:write");
    const body = parseBody(apiOperations.upsertAdministeredUserIdentity.requestSchema, request.body);
    const userId = getUserIdParam(request.params);
    return userAdministration.upsertIdentity(user, context, {
      userId,
      authSource: body.authSource,
      externalUserId: body.externalUserId,
      displayLabel: body.displayLabel,
      email: body.email,
      emailVerified: body.emailVerified
    });
  });

  app.post(apiOperations.resetAdministeredUserPassword.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "user_admin:write");
    const body = parseBody(apiOperations.resetAdministeredUserPassword.requestSchema, request.body);
    const userId = getUserIdParam(request.params);
    return userAdministration.resetPassword(user, context, {
      userId,
      password: body.password
    });
  });

  app.delete(apiOperations.deleteAdministeredUserIdentity.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "user_admin:write");
    const params = getIdentityParams(request.params);
    return userAdministration.deleteIdentity(user, context, params);
  });
}

function getUserIdParam(params: unknown) {
  const userId = (params as { userId?: string }).userId;
  if (!userId) {
    throw new AppError("BAD_REQUEST", "Missing user id");
  }
  return asUserId(userId);
}

function getIdentityParams(params: unknown) {
  const typedParams = params as {
    userId?: string;
    authSource?: string;
    externalUserId?: string;
  };
  if (!typedParams.userId || !typedParams.authSource || !typedParams.externalUserId) {
    throw new AppError("BAD_REQUEST", "Missing user identity mapping parameters");
  }
  return {
    userId: asUserId(typedParams.userId),
    authSource: typedParams.authSource,
    externalUserId: typedParams.externalUserId
  };
}
