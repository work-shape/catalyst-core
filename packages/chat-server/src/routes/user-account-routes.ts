import type { FastifyInstance } from "fastify";
import {
  changeCurrentUserPasswordRequestSchema,
  updateCurrentUserRequestSchema
} from "@vivd-catalyst/api-contract";
import type { ChatServerOptions } from "../types";
import { authenticateRequest, parseBody } from "../request-context";
import { UserAccountWorkflow } from "../user-account-workflow";

export function registerUserAccountRoutes(app: FastifyInstance, options: ChatServerOptions): void {
  const userAccount = new UserAccountWorkflow(options);

  app.patch("/api/me", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(updateCurrentUserRequestSchema, request.body);
    return userAccount.updateCurrentUser(user, context, {
      displayLabel: body.displayLabel
    });
  });

  app.post("/api/me/password", async (request) => {
    const { user, context } = await authenticateRequest(options, request);
    const body = parseBody(changeCurrentUserPasswordRequestSchema, request.body);
    return userAccount.changeCurrentUserPassword(user, context, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword
    });
  });
}
