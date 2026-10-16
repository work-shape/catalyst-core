import { apiOperations } from "@work-shape/catalyst-api-contract";
import { asUserId } from "@work-shape/catalyst-core";
import { recordGovernanceAccess } from "../access/governance-actions";
import type { Route } from "../http/route";
import { deletionState } from "./deletion-answer";
import { requirePathParam } from "./request-context";
import type { ChatServerOptions } from "../types";
import { UserAdministrationWorkflow } from "../users/user-administration-service";
import { authorizeUserAdministration } from "../access/user-administration-rights";

/** What stands in the hashed input of a call where a password was. */
const PASSWORD_MARK = "[password]";

/**
 * Instance > Users and Usage. The two reads are plain routes. The seven user changes are
 * registered operations: each call is an Operation Run and checks `users.manage`, the
 * superadmin rules and the rule of no escalation before it runs.
 */
export function registerSuperadminRoutes(route: Route, options: ChatServerOptions): void {
  const userAdministration = new UserAdministrationWorkflow(options);
  const create = apiOperations["users.create"];
  const update = apiOperations["users.update"];
  const remove = apiOperations["users.delete"];
  const upsertIdentity = apiOperations["users.identities.upsert"];
  const resetPassword = apiOperations["users.password.reset"];
  const sendInvitation = apiOperations["users.invitation.send"];
  const deleteIdentity = apiOperations["users.identities.delete"];

  route(apiOperations["usage.get_summary"], async ({ user, context }) => {
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

  route(apiOperations["users.list"], async ({ user, context, paging }) => {
    return userAdministration.listUsers(user, context, paging);
  });

  route.operation(create, {
    changeClass: "reversible",
    authorize: (input, context) =>
      authorizeUserAdministration(options, create.id, context, {
        displayLabel: input.displayLabel,
        roles: input.roles,
        permissionRefs: input.permissionRefs,
        permissions: input.permissions
      }),
    inputWithoutSecrets: (input) =>
      input.passwordSignIn
        ? { ...input, passwordSignIn: { ...input.passwordSignIn, password: PASSWORD_MARK } }
        : undefined,
    execute: (input, context) =>
      userAdministration.createUser(create.id, context, {
        displayLabel: input.displayLabel,
        email: input.email,
        roles: input.roles,
        permissionRefs: input.permissionRefs,
        permissions: input.permissions,
        status: input.status,
        passwordSignIn: input.passwordSignIn
      })
  });

  route.operation(update, {
    changeClass: "reversible",
    authorize: (input, context) =>
      authorizeUserAdministration(options, update.id, context, {
        userId: input.userId,
        roles: input.roles,
        permissionRefs: input.permissionRefs,
        permissions: input.permissions
      }),
    resource: ({ userId }) => ({ kind: "user", id: userId }),
    execute: (input, context) =>
      userAdministration.updateUser(update.id, context, {
        userId: userIdParam(input),
        displayLabel: input.displayLabel,
        email: input.email,
        roles: input.roles,
        permissionRefs: input.permissionRefs,
        permissions: input.permissions,
        status: input.status
      })
  });

  route.operation(remove, {
    // Deleting an account and its data is irreversible.
    authorize: (input, context) =>
      authorizeUserAdministration(options, remove.id, context, {
        userId: input.userId,
        superadminOnly: true
      }),
    resource: ({ userId }) => ({ kind: "user", id: userId }),
    execute: async (input, context) =>
      deletionState(
        await userAdministration.deleteUser(remove.id, context, {
          userId: userIdParam(input)
        })
      )
  });

  route.operation(upsertIdentity, {
    changeClass: "reversible",
    authorize: (input, context) =>
      authorizeUserAdministration(options, upsertIdentity.id, context, {
        userId: input.userId
      }),
    resource: ({ userId }) => ({ kind: "user", id: userId }),
    execute: (input, context) =>
      userAdministration.upsertIdentity(upsertIdentity.id, context, {
        userId: userIdParam(input),
        authSource: input.authSource,
        externalUserId: input.externalUserId,
        displayLabel: input.displayLabel,
        email: input.email,
        emailVerified: input.emailVerified
      })
  });

  route.operation(resetPassword, {
    // The previous password cannot be restored, so this change is irreversible.
    authorize: (input, context) =>
      authorizeUserAdministration(options, resetPassword.id, context, {
        userId: input.userId
      }),
    resource: ({ userId }) => ({ kind: "user", id: userId }),
    inputWithoutSecrets: (input) => ({ ...input, password: PASSWORD_MARK }),
    execute: (input, context) =>
      userAdministration.resetPassword(resetPassword.id, context, {
        userId: userIdParam(input),
        password: input.password
      })
  });

  route.operation(sendInvitation, {
    // Sending an invitation sends mail outside the instance.
    changeClass: "outward",
    authorize: (input, context) =>
      authorizeUserAdministration(options, sendInvitation.id, context, {
        userId: input.userId
      }),
    resource: ({ userId }) => ({ kind: "user", id: userId }),
    execute: (input, context) =>
      userAdministration.sendInvitation(sendInvitation.id, context, {
        userId: userIdParam(input)
      })
  });

  route.operation(deleteIdentity, {
    changeClass: "reversible",
    authorize: (input, context) =>
      authorizeUserAdministration(options, deleteIdentity.id, context, {
        userId: input.userId
      }),
    resource: ({ userId }) => ({ kind: "user", id: userId }),
    execute: (input, context) =>
      userAdministration.deleteIdentity(deleteIdentity.id, context, identityParams(input))
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
