import { useTranslation } from "../../../shared/i18n";
import { useSuperadminUserMutations } from "../../../shared/api/workspace-mutations";
import { useWorkspaceUsersQuery } from "../../../shared/api/workspace-queries";
import { UserAdministrationPanel } from "../../control-plane/user-administration-panel";
import { OwnerScheduledStartsCard } from "../../control-plane/owner-scheduled-starts";
import { apiErrorMessage } from "../../../shared/workspace-utils";
import { useSettingsPage } from "../../../shared/settings-page-context";
import { UserEffectiveRightsCard } from "../../access/effective-rights";
import { useEffectivePermissionsQuery } from "../../access/access-queries";
import { giverAccess } from "../../access/grant-options";

/** Instance > Users: the accounts of this instance, with its own data. */
export function UsersPage() {
  const { t } = useTranslation();
  const { apiBaseUrl, authScope, client, user, config } = useSettingsPage();
  const usersQuery = useWorkspaceUsersQuery({ apiBaseUrl, authScope, client, enabled: true });
  // Deleting an account is the right `users.delete`, read from the viewer's own rights as the
  // Access page reads them. The server asks it again, with the rule on the account deleted.
  const ownRights = useEffectivePermissionsQuery({
    apiBaseUrl,
    authScope,
    client,
    holderId: user.id
  });
  const canDeleteUsers =
    ownRights.error === null && giverAccess(ownRights.data).authorize("users.delete").allowed;
  const userMutations = useSuperadminUserMutations({
    apiBaseUrl,
    authScope,
    client,
    heldMessage: t("settings.userChangeWaitsForApproval")
  });

  return (
    <UserAdministrationPanel
      users={usersQuery.data ?? []}
      loading={usersQuery.isLoading}
      error={usersQuery.error ? apiErrorMessage(usersQuery.error, undefined) : undefined}
      // Changing a superadmin and giving the role stay a superadmin's (the named list, D8).
      canManageSuperadminAccess={user.roles.includes("superadmin")}
      canDeleteUsers={canDeleteUsers}
      mutating={userMutations.isPending}
      onCreateUser={(input) => userMutations.createUser.mutateAsync(input)}
      onUpdateUser={(userId, update) => userMutations.updateUser.mutateAsync({ userId, update })}
      onDeleteUser={(userId) => userMutations.deleteUser.mutateAsync(userId)}
      onUpsertIdentity={(userId, identity) =>
        userMutations.upsertUserIdentity.mutateAsync({ userId, identity })
      }
      onDeleteIdentity={(userId, identity) =>
        userMutations.deleteUserIdentity.mutateAsync({ userId, identity })
      }
      onResetPassword={(userId, password) =>
        userMutations.resetUserPassword.mutateAsync({ userId, password })
      }
      viewerId={user.id}
      onResetTwoFactor={(userId) => userMutations.resetUserTwoFactor.mutateAsync(userId)}
      onSendInvitation={
        config.features.userInvitations.enabled
          ? (userId) => userMutations.sendUserInvitation.mutateAsync(userId)
          : undefined
      }
      userRights={(userId) => <UserEffectiveRightsCard key={userId} holderId={userId} />}
      ownedScheduledStarts={(owner) => (
        <OwnerScheduledStartsCard
          key={`scheduled-${owner.id}`}
          owner={owner}
          people={usersQuery.data ?? []}
        />
      )}
    />
  );
}
