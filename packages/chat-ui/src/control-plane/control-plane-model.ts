import { useEffect } from "react";
import type {
  ApiClient,
  ApiUser,
  ChangeCurrentUserPasswordRequest,
  LocaleCode,
  UpdateCurrentUserRequest
} from "@vivd-catalyst/api-client";
import {
  useChangeCurrentUserPasswordMutation,
  useDeleteCurrentUserMutation,
  useSuperadminUserMutations,
  useUpdateCurrentUserMutation
} from "../api/workspace-mutations";
import {
  useWorkspaceAuditActivitiesQuery,
  useWorkspaceUsageQuery,
  useWorkspaceUsersQuery
} from "../api/workspace-queries";
import type { ChatShellAdminPanel } from "../chat-shell";
import { canViewUsageGovernance } from "../governance";
import type {
  SuperadminRouteTab,
  WorkspaceRoute,
  WorkspaceRouteChangeOptions,
  WorkspaceRouteView
} from "../workspace-route";
import { apiErrorMessage, STANDALONE_AUTH_SOURCE } from "../workspace-utils";

export interface ControlPlaneModelInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  adminPanel: ChatShellAdminPanel | undefined;
  user: ApiUser | undefined;
  isAuthenticated: boolean;
  route: WorkspaceRoute;
  view: WorkspaceRouteView;
  supportedLocales: LocaleCode[];
  activeLocale: LocaleCode;
  selectLocale(locale: LocaleCode): void;
  goToDefaultChat(options?: WorkspaceRouteChangeOptions): void;
  onAccountDeleted(): void;
  showSuperadmin(tab: SuperadminRouteTab, options?: WorkspaceRouteChangeOptions): void;
}

export interface ControlPlaneModel {
  canViewAdministration: boolean;
  settings: ControlPlaneSettingsModel;
  superadmin: ControlPlaneSuperadminModel;
}

export interface ControlPlaneSettingsModel {
  shouldRender: boolean;
  user: ApiUser | undefined;
  canChangePassword: boolean;
  updatingProfile: boolean;
  changingPassword: boolean;
  deletingAccount: boolean;
  locales: LocaleCode[];
  locale: LocaleCode;
  updateProfile(input: UpdateCurrentUserRequest): Promise<ApiUser>;
  changePassword(input: ChangeCurrentUserPasswordRequest): Promise<unknown>;
  deleteAccount(): Promise<unknown>;
  selectLocale(locale: LocaleCode): void;
}

export interface ControlPlaneSuperadminModel {
  shouldRender: boolean;
  panelInput: SuperadminPanelInput;
}

export type SuperadminPanelInput = Parameters<ChatShellAdminPanel["renderPanel"]>[0];

export function useControlPlaneModel({
  apiBaseUrl,
  authScope,
  client,
  adminPanel,
  user,
  isAuthenticated,
  route,
  view,
  supportedLocales,
  activeLocale,
  selectLocale,
  goToDefaultChat,
  onAccountDeleted,
  showSuperadmin
}: ControlPlaneModelInput): ControlPlaneModel {
  const canViewAdministration = adminPanel?.canView(user) ?? false;
  const canViewUsage = canViewUsageGovernance(user);
  const administrationEnabled = canViewAdministration && view === "superadmin";
  const routeTab = route.kind === "superadmin" ? route.tab : undefined;
  const selectedAdministrationTab =
    routeTab !== undefined
      ? routeTab === "usage" && !canViewUsage
        ? "users"
        : routeTab
      : canViewUsage
        ? "usage"
        : "users";
  const usageQuery = useWorkspaceUsageQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: administrationEnabled && canViewUsage
  });
  const auditQuery = useWorkspaceAuditActivitiesQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: administrationEnabled
  });
  const usersQuery = useWorkspaceUsersQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: administrationEnabled
  });
  const updateCurrentUser = useUpdateCurrentUserMutation({
    apiBaseUrl,
    authScope,
    client
  });
  const changeCurrentUserPassword = useChangeCurrentUserPasswordMutation({
    apiBaseUrl,
    authScope,
    client
  });
  const deleteCurrentUser = useDeleteCurrentUserMutation({
    apiBaseUrl,
    authScope,
    client,
    onDeleted: onAccountDeleted
  });
  const superadminUserMutations = useSuperadminUserMutations({
    apiBaseUrl,
    authScope,
    client
  });

  useEffect(() => {
    if (isAuthenticated && route.kind === "superadmin" && !canViewAdministration) {
      goToDefaultChat({ replace: true });
      return;
    }
    if (isAuthenticated && route.kind === "superadmin" && routeTab === "usage" && !canViewUsage) {
      showSuperadmin("users", { replace: true });
    }
  }, [canViewAdministration, canViewUsage, goToDefaultChat, isAuthenticated, route.kind, routeTab, showSuperadmin]);

  return {
    canViewAdministration,
    settings: {
      shouldRender: view === "settings",
      user,
      canChangePassword: user?.authSource === STANDALONE_AUTH_SOURCE,
      updatingProfile: updateCurrentUser.isPending,
      changingPassword: changeCurrentUserPassword.isPending,
      deletingAccount: deleteCurrentUser.isPending,
      locales: supportedLocales,
      locale: activeLocale,
      updateProfile: (input) => updateCurrentUser.mutateAsync(input),
      changePassword: (input) => changeCurrentUserPassword.mutateAsync(input),
      deleteAccount: () => deleteCurrentUser.mutateAsync(),
      selectLocale
    },
    superadmin: {
      shouldRender: administrationEnabled,
      panelInput: {
        usage: usageQuery.data,
        auditActivities: auditQuery.data ?? [],
        users: usersQuery.data ?? [],
        canViewUsageGovernance: canViewUsage,
        loading: usageQuery.isLoading || auditQuery.isLoading,
        usersLoading: usersQuery.isLoading,
        error: canViewUsage && usageQuery.error
          ? apiErrorMessage(usageQuery.error, undefined)
          : auditQuery.error
            ? apiErrorMessage(auditQuery.error, undefined)
            : undefined,
        usersError: usersQuery.error ? apiErrorMessage(usersQuery.error, undefined) : undefined,
        usersMutating: superadminUserMutations.isPending,
        onCreateUser: (input) => superadminUserMutations.createUser.mutateAsync(input),
        onUpdateUser: (userId, update) =>
          superadminUserMutations.updateUser.mutateAsync({ userId, update }),
        onDeleteUser: (userId) => superadminUserMutations.deleteUser.mutateAsync(userId),
        onUpsertUserIdentity: (userId, identity) =>
          superadminUserMutations.upsertUserIdentity.mutateAsync({ userId, identity }),
        onDeleteUserIdentity: (userId, identity) =>
          superadminUserMutations.deleteUserIdentity.mutateAsync({ userId, identity }),
        onResetUserPassword: (userId, password) =>
          superadminUserMutations.resetUserPassword.mutateAsync({ userId, password }),
        selectedTab: selectedAdministrationTab,
        onSelectTab: showSuperadmin
      }
    }
  };
}
