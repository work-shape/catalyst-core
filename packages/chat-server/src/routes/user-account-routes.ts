import { apiOperations } from "@vivd-catalyst/api-contract";
import { asUserId, getSubjectUserId, resolveEffectivePermissions } from "@vivd-catalyst/core";
import type { Route } from "../http/route";
import { resolveRequestLocale } from "../request-context";
import type { ChatServerOptions } from "../types";
import { PasswordSetupWorkflow } from "../password-setup-workflow";
import { UserAccountWorkflow } from "../user-account-workflow";

export function registerUserAccountRoutes(route: Route, options: ChatServerOptions): void {
  const userAccount = new UserAccountWorkflow(options);
  const passwordSetup = new PasswordSetupWorkflow(options);

  // Unauthenticated by design: these are the routes a locked-out user can still reach.
  route(apiOperations.requestPasswordReset, async ({ context, body, request }) => {
    return passwordSetup.requestPasswordReset(
      {
        email: body.email,
        locale: resolveRequestLocale(options, request),
        remoteAddress: request.ip,
        onDeliveryError: (error) =>
          request.log.error({ err: error }, "Password reset email delivery failed")
      },
      { correlationId: context.correlationId }
    );
  });

  route(apiOperations.completePasswordSetup, async ({ context, body }) => {
    return passwordSetup.completePasswordSetup(
      { token: body.token, password: body.password },
      { correlationId: context.correlationId }
    );
  });

  route(apiOperations.updateCurrentUser, async ({ user, context, body }) => {
    const updated = await userAccount.updateCurrentUser(user, context, {
      displayLabel: body.displayLabel
    });
    return {
      ...updated,
      permissions: [...resolveEffectivePermissions(updated)]
    };
  });

  route(apiOperations.getCurrentUserModelPreference, async ({ user }) => {
    const preference = await options.stores.users.getUserModelPreference({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(getSubjectUserId(user))
    });
    return preference ?? { reasoningEfforts: {} };
  });

  route(apiOperations.setCurrentUserModelPreference, async ({ user, body }) => {
    await options.stores.users.setUserModelPreference({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(getSubjectUserId(user)),
      preference: body
    });
    return body;
  });

  route(apiOperations.changeCurrentUserPassword, async ({ user, context, body }) => {
    return userAccount.changeCurrentUserPassword(user, context, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword
    });
  });

  route(apiOperations.deleteCurrentUser, async ({ user, context }) => {
    return userAccount.deleteCurrentUser(user, context);
  });
}
