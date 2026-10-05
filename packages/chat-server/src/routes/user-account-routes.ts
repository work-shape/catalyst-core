import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { requireAuthScope, resolveEffectivePermissions } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "../types";
import {
  authenticateRequest,
  createCorrelationId,
  parseBody,
  resolveRequestLocale
} from "../request-context";
import { PasswordSetupWorkflow } from "../password-setup-workflow";
import { UserAccountWorkflow } from "../user-account-workflow";

export function registerUserAccountRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const userAccount = new UserAccountWorkflow(options);
  const passwordSetup = new PasswordSetupWorkflow(options);

  // Unauthenticated by design: these are the routes a locked-out user can still reach.
  app.post(apiOperations.requestPasswordReset.path, async (request) => {
    const body = parseBody(apiOperations.requestPasswordReset.requestSchema, request.body);
    return passwordSetup.requestPasswordReset(
      {
        email: body.email,
        locale: resolveRequestLocale(options, request),
        remoteAddress: request.ip,
        onDeliveryError: (error) =>
          request.log.error({ err: error }, "Password reset email delivery failed")
      },
      { correlationId: createCorrelationId(request) }
    );
  });

  app.post(apiOperations.completePasswordSetup.path, async (request) => {
    const body = parseBody(apiOperations.completePasswordSetup.requestSchema, request.body);
    return passwordSetup.completePasswordSetup(
      { token: body.token, password: body.password },
      { correlationId: createCorrelationId(request) }
    );
  });

  app.patch(apiOperations.updateCurrentUser.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "me:write");
    const body = parseBody(apiOperations.updateCurrentUser.requestSchema, request.body);
    const updated = await userAccount.updateCurrentUser(user, context, {
      displayLabel: body.displayLabel
    });
    return {
      ...updated,
      permissions: [...resolveEffectivePermissions(updated)]
    };
  });

  app.post(apiOperations.changeCurrentUserPassword.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "me:write");
    const body = parseBody(apiOperations.changeCurrentUserPassword.requestSchema, request.body);
    return userAccount.changeCurrentUserPassword(user, context, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword
    });
  });

  app.delete(apiOperations.deleteCurrentUser.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "me:delete");
    return userAccount.deleteCurrentUser(user, context);
  });
}
