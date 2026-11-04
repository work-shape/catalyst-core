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
import { useRolesQuery } from "../../access/role-queries";
import { UserRolesCard } from "../../access/user-roles-card";

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
  const rolesQuery = useRolesQuery({ apiBaseUrl, authScope, client });
  const customRoleNames = new Map(
    (rolesQuery.data ?? []).filter((role) => !role.builtIn).map((role) => [role.id, role.name])
  );
  const viewerIsSuperadmin = user.roles.includes("superadmin");
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
      canManageSuperadminAccess={viewerIsSuperadmin}
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
      customRoleNames={customRoleNames}
      userRoles={(person) => (
        <UserRolesCard
          key={`roles-${person.id}`}
          user={person}
          roles={rolesQuery.data}
          rolesFailed={Boolean(rolesQuery.error)}
          editor={{
            superadmin: viewerIsSuperadmin,
            rights: ownRights.error === null ? ownRights.data : undefined
          }}
          disabledReason={
            !viewerIsSuperadmin && person.roles.includes("superadmin")
              ? t("settings.userSuperadminOnly")
              : undefined
          }
          instanceAdminName={user.instanceAdminName}
          onSetRoles={(userId, roles) =>
            userMutations.updateUser.mutateAsync({ userId, update: { roles } })
          }
        />
      )}
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
