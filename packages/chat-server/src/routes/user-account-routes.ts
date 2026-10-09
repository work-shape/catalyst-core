import { apiOperations } from "@vivd-catalyst/api-contract";
import { asUserId, getSubjectUserId, allowedLegacyPermissions } from "@vivd-catalyst/core";
import type { Route } from "../http/route";
import { resolveRequestLocale } from "../request-context";
import type { ResolvedChatServerOptions } from "../types";
import { PasswordSetupWorkflow } from "../password-setup-workflow";
import { UserAccountWorkflow } from "../user-account-workflow";

export function registerUserAccountRoutes(route: Route, options: ResolvedChatServerOptions): void {
  const userAccount = new UserAccountWorkflow(options);
  const passwordSetup = new PasswordSetupWorkflow(options);

  // Unauthenticated by design: these are the routes a locked-out user can still reach.
  route(apiOperations["password_reset.request"], async ({ context, body, request }) => {
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

  route(apiOperations["password_setup.complete"], async ({ context, body }) => {
    return passwordSetup.completePasswordSetup(
      { token: body.token, password: body.password },
      { correlationId: context.correlationId }
    );
  });

  route(apiOperations["me.update"], async ({ user, access, context, body }) => {
    const updated = await userAccount.updateCurrentUser(user, context, {
      displayLabel: body.displayLabel
    });
    return {
      ...updated,
      // A profile change moves no right, so the answer loaded for this request still holds.
      permissions: allowedLegacyPermissions(access)
    };
  });

  route(apiOperations["me.model_preference.get"], async ({ user }) => {
    const preference = await options.stores.users.getUserModelPreference({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(getSubjectUserId(user))
    });
    return preference ?? { reasoningEfforts: {} };
  });

  route(apiOperations["me.model_preference.set"], async ({ user, body }) => {
    await options.stores.users.setUserModelPreference({
      clientInstanceId: options.clientInstanceId,
      userId: asUserId(getSubjectUserId(user)),
      preference: body
    });
    return body;
  });

  route(apiOperations["me.password.change"], async ({ user, context, body }) => {
    return userAccount.changeCurrentUserPassword(user, context, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword
    });
  });

  route(apiOperations["me.delete"], async ({ user, context }) => {
    return userAccount.deleteCurrentUser(user, context);
  });
}
