import type { FastifyInstance } from "fastify";
import { apiOperations } from "@vivd-catalyst/api-contract";
import { requireAuthScope } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "../types";
import { authenticateRequest, parseBody } from "../request-context";
import { UserAccountWorkflow } from "../user-account-workflow";

export function registerUserAccountRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const userAccount = new UserAccountWorkflow(options);

  app.patch(apiOperations.updateCurrentUser.path, async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    requireAuthScope(user, "me:write");
    const body = parseBody(apiOperations.updateCurrentUser.requestSchema, request.body);
    return userAccount.updateCurrentUser(user, context, {
      displayLabel: body.displayLabel
    });
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
