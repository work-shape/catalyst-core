import { useEffect } from "react";
import type {
  ApiClient,
  ApiUser,
  ChangeCurrentUserPasswordRequest,
  LocaleCode,
  SafeConfig,
  UpdateCurrentUserRequest
} from "@vivd-catalyst/api-client";
import {
  useChangeCurrentUserPasswordMutation,
  useConfigAssetMutations,
  useDeleteCurrentUserMutation,
  useSuperadminUserMutations,
  useUpdateCurrentUserMutation
} from "../api/workspace-mutations";
import {
  useConfigAssetsExportQuery,
  useConfigAssetsOverviewQuery,
  useWorkspaceAuditActivitiesQuery,
  useWorkspaceUsageQuery,
  useWorkspaceUsersQuery
} from "../api/workspace-queries";
import { useQueryClient } from "@tanstack/react-query";
import { workspaceQueryKeys } from "../api/workspace-query-keys";
import type { ChatShellAdminPanel } from "../chat-shell";
import { canEditConfigAssets, canManageUsers, canViewAudit, canViewUsageGovernance } from "../governance";
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
  configAssetManagement: SafeConfig["features"]["configAssets"] | undefined;
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
  configAssetManagement,
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
  const canViewUsage = canViewUsageGovernance(user);
  const userCanManageUsers = canManageUsers(user);
  const userCanViewAudit = canViewAudit(user);
  const userCanEditConfigAssets =
    configAssetManagement?.enabled === true && canEditConfigAssets(user);
  const requestedConfigPending =
    route.kind === "superadmin" &&
    route.tab === "config" &&
    configAssetManagement === undefined &&
    canEditConfigAssets(user);
  const canViewAdministration =
    (adminPanel?.canView(user) ?? false) &&
    (canViewUsage || userCanManageUsers || userCanViewAudit || userCanEditConfigAssets);
  const canManageSuperadminAccess = Boolean(user?.roles.includes("superadmin"));
  const administrationEnabled = canViewAdministration && view === "superadmin";
  const routeTab = route.kind === "superadmin" ? route.tab : undefined;
  const defaultAdministrationTab = firstAvailableAdministrationTab({
    canViewUsage,
    canManageUsers: userCanManageUsers,
    canViewAudit: userCanViewAudit,
    canEditConfigAssets: userCanEditConfigAssets
  });
  const selectedAdministrationTab = requestedConfigPending
    ? "config"
    : routeTab &&
        canViewAdministrationTab(routeTab, {
          canViewUsage,
          canManageUsers: userCanManageUsers,
          canViewAudit: userCanViewAudit,
          canEditConfigAssets: userCanEditConfigAssets
        })
      ? routeTab
      : defaultAdministrationTab;
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
    enabled: administrationEnabled && userCanViewAudit
  });
  const usersQuery = useWorkspaceUsersQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: administrationEnabled && userCanManageUsers
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
  const queryClient = useQueryClient();
  const configAssetsEnabled = administrationEnabled && userCanEditConfigAssets;
  const configAssetsOverviewQuery = useConfigAssetsOverviewQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: configAssetsEnabled
  });
  const configAssetsExportQuery = useConfigAssetsExportQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: configAssetsEnabled
  });
  const configAssetMutations = useConfigAssetMutations({
    apiBaseUrl,
    authScope,
    client
  });

  useEffect(() => {
    if (!isAuthenticated || route.kind !== "superadmin") {
      return;
    }
    if (requestedConfigPending) {
      return;
    }
    if (!canViewAdministration) {
      goToDefaultChat({ replace: true });
      return;
    }
    if (selectedAdministrationTab && route.tab !== selectedAdministrationTab) {
      showSuperadmin(selectedAdministrationTab, { replace: true });
    }
  }, [
    canViewAdministration,
    goToDefaultChat,
    isAuthenticated,
    route,
    requestedConfigPending,
    selectedAdministrationTab,
    showSuperadmin
  ]);

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
        canManageUsers: userCanManageUsers,
        canViewAudit: userCanViewAudit,
        canManageSuperadminAccess,
        loading: usageQuery.isLoading || auditQuery.isLoading,
        usersLoading: usersQuery.isLoading,
        error: usageQuery.error
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
        canEditConfigAssets: userCanEditConfigAssets,
        configAssets: {
          editableAgentFields: configAssetManagement?.editableAgentFields ?? [],
          allowAgentCreation: configAssetManagement?.allowAgentCreation ?? false,
          allowAgentDeletion: configAssetManagement?.allowAgentDeletion ?? false,
          allowDefaultAgentChange: configAssetManagement?.allowDefaultAgentChange ?? false,
          allowSkillEditing: configAssetManagement?.allowSkillEditing ?? false,
          overview: configAssetsOverviewQuery.data,
          agents: namedBundleEntries(configAssetsExportQuery.data?.agents),
          skills: namedBundleEntries(configAssetsExportQuery.data?.skills),
          loading: configAssetsOverviewQuery.isLoading || configAssetsExportQuery.isLoading,
          error:
            configAssetsOverviewQuery.error || configAssetsExportQuery.error
              ? apiErrorMessage(configAssetsOverviewQuery.error ?? configAssetsExportQuery.error, undefined)
              : undefined,
          mutating: configAssetMutations.isPending,
          onSaveAsset: (saveInput) => configAssetMutations.putAsset.mutateAsync(saveInput),
          onDeleteAsset: (deleteInput) => configAssetMutations.deleteAsset.mutateAsync(deleteInput),
          onSetDefaultAgent: (defaultInput) =>
            configAssetMutations.setDefaultAgent.mutateAsync(defaultInput),
          onRevertAsset: (revertInput) => configAssetMutations.revertAsset.mutateAsync(revertInput),
          onLoadRevisions: (kind, name) => client.configAssetRevisions(kind, name),
          onReload: () =>
            queryClient.invalidateQueries({
              queryKey: workspaceQueryKeys.configAssetsOverview(apiBaseUrl, authScope)
            })
        },
        selectedTab: selectedAdministrationTab ?? "users",
        onSelectTab: showSuperadmin
      }
    }
  };
}

function firstAvailableAdministrationTab(input: {
  canViewUsage: boolean;
  canManageUsers: boolean;
  canViewAudit: boolean;
  canEditConfigAssets: boolean;
}): SuperadminRouteTab | undefined {
  if (input.canManageUsers) {
    return "users";
  }
  if (input.canEditConfigAssets) {
    return "config";
  }
  if (input.canViewUsage) {
    return "usage";
  }
  if (input.canViewAudit) {
    return "audit";
  }
  return undefined;
}

function canViewAdministrationTab(
  tab: SuperadminRouteTab,
  input: {
    canViewUsage: boolean;
    canManageUsers: boolean;
    canViewAudit: boolean;
    canEditConfigAssets: boolean;
  }
): boolean {
  if (tab === "usage") {
    return input.canViewUsage;
  }
  if (tab === "users") {
    return input.canManageUsers;
  }
  if (tab === "config") {
    return input.canEditConfigAssets;
  }
  return input.canViewAudit;
}

function namedBundleEntries(
  configs: Array<Record<string, unknown>> | undefined
): Array<{ name: string; config: Record<string, unknown> }> {
  return (configs ?? []).flatMap((config) => {
    const name = config.name;
    return typeof name === "string" ? [{ name, config }] : [];
  });
}
