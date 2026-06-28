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
  useSuperadminUserMutations,
  useUpdateCurrentUserMutation
} from "../api/workspace-mutations";
import {
  useWorkspaceAuditEventsQuery,
  useWorkspaceUsageQuery,
  useWorkspaceUsersQuery
} from "../api/workspace-queries";
import type { ChatShellAdminPanel } from "../chat-shell";
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
  showSuperadmin(tab: SuperadminRouteTab): void;
}

export interface ControlPlaneModel {
  isSuperadmin: boolean;
  settings: ControlPlaneSettingsModel;
  superadmin: ControlPlaneSuperadminModel;
}

export interface ControlPlaneSettingsModel {
  shouldRender: boolean;
  user: ApiUser | undefined;
  canChangePassword: boolean;
  updatingProfile: boolean;
  changingPassword: boolean;
  locales: LocaleCode[];
  locale: LocaleCode;
  updateProfile(input: UpdateCurrentUserRequest): Promise<ApiUser>;
  changePassword(input: ChangeCurrentUserPasswordRequest): Promise<unknown>;
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
  showSuperadmin
}: ControlPlaneModelInput): ControlPlaneModel {
  const isSuperadmin = adminPanel?.canView(user) ?? false;
  const superadminEnabled = isSuperadmin && view === "superadmin";
  const usageQuery = useWorkspaceUsageQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: superadminEnabled
  });
  const auditQuery = useWorkspaceAuditEventsQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: superadminEnabled
  });
  const usersQuery = useWorkspaceUsersQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: superadminEnabled
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
  const superadminUserMutations = useSuperadminUserMutations({
    apiBaseUrl,
    authScope,
    client
  });

  useEffect(() => {
    if (isAuthenticated && route.kind === "superadmin" && !isSuperadmin) {
      goToDefaultChat({ replace: true });
    }
  }, [goToDefaultChat, isAuthenticated, isSuperadmin, route.kind]);

  return {
    isSuperadmin,
    settings: {
      shouldRender: view === "settings",
      user,
      canChangePassword: user?.authSource === STANDALONE_AUTH_SOURCE,
      updatingProfile: updateCurrentUser.isPending,
      changingPassword: changeCurrentUserPassword.isPending,
      locales: supportedLocales,
      locale: activeLocale,
      updateProfile: (input) => updateCurrentUser.mutateAsync(input),
      changePassword: (input) => changeCurrentUserPassword.mutateAsync(input),
      selectLocale
    },
    superadmin: {
      shouldRender: superadminEnabled,
      panelInput: {
        usage: usageQuery.data,
        auditEvents: auditQuery.data ?? [],
        users: usersQuery.data ?? [],
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
        onUpsertUserIdentity: (userId, identity) =>
          superadminUserMutations.upsertUserIdentity.mutateAsync({ userId, identity }),
        onDeleteUserIdentity: (userId, identity) =>
          superadminUserMutations.deleteUserIdentity.mutateAsync({ userId, identity }),
        onResetUserPassword: (userId, password) =>
          superadminUserMutations.resetUserPassword.mutateAsync({ userId, password }),
        selectedTab: route.kind === "superadmin" ? route.tab : "usage",
        onSelectTab: showSuperadmin
      }
    }
  };
}
