import type { FastifyInstance } from "fastify";
import {
  createAdministeredUserRequestSchema,
  resetAdministeredUserPasswordRequestSchema,
  updateAdministeredUserRequestSchema,
  upsertAdministeredUserIdentityRequestSchema
} from "@vivd-catalyst/api-contract";
import { AppError, asUserId } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "../types";
import { authorizeGovernanceAction } from "../governance-actions";
import { authenticateRequest, parseBody } from "../request-context";
import { UserAdministrationWorkflow } from "../user-administration-workflow";

export function registerSuperadminRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const userAdministration = new UserAdministrationWorkflow(options);

  app.get("/api/superadmin/usage", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
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

  app.get("/api/superadmin/users", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    return userAdministration.listUsers(user, context);
  });

  app.post("/api/superadmin/users", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(createAdministeredUserRequestSchema, request.body);
    return userAdministration.createUser(user, context, {
      displayLabel: body.displayLabel,
      email: body.email,
      roles: body.roles,
      permissionRefs: body.permissionRefs,
      status: body.status
    });
  });

  app.patch("/api/superadmin/users/:userId", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(updateAdministeredUserRequestSchema, request.body);
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

  app.put("/api/superadmin/users/:userId/identities", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(upsertAdministeredUserIdentityRequestSchema, request.body);
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

  app.post("/api/superadmin/users/:userId/password", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(resetAdministeredUserPasswordRequestSchema, request.body);
    const userId = getUserIdParam(request.params);
    return userAdministration.resetPassword(user, context, {
      userId,
      password: body.password
    });
  });

  app.delete("/api/superadmin/users/:userId/identities/:authSource/:externalUserId", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
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
