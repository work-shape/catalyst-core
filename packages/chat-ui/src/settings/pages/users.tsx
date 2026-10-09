import { useSuperadminUserMutations } from "../../api/workspace-mutations";
import { useWorkspaceUsersQuery } from "../../api/workspace-queries";
import { UserAdministrationPanel } from "../../control-plane/user-administration-panel";
import { apiErrorMessage } from "../../workspace-utils";
import { useSettingsPage } from "../settings-page-context";

/** Instance > Users: the accounts of this instance, with its own data. */
export function UsersPage() {
  const { apiBaseUrl, authScope, client, user, config } = useSettingsPage();
  const usersQuery = useWorkspaceUsersQuery({ apiBaseUrl, authScope, client, enabled: true });
  const userMutations = useSuperadminUserMutations({ apiBaseUrl, authScope, client });

  return (
    <UserAdministrationPanel
      users={usersQuery.data ?? []}
      loading={usersQuery.isLoading}
      error={usersQuery.error ? apiErrorMessage(usersQuery.error, undefined) : undefined}
      canManageSuperadminAccess={user.roles.includes("superadmin")}
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
      onSendInvitation={
        config.features.userInvitations.enabled
          ? (userId) => userMutations.sendUserInvitation.mutateAsync(userId)
          : undefined
      }
    />
  );
}
