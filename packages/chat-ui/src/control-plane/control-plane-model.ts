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
  useDeleteCurrentUserMutation,
  useUpdateCurrentUserMutation
} from "../api/workspace-mutations";
import type { ChatShellAdminPanel, ChatShellAdminPanelInput } from "../chat-shell";
import type {
  SuperadminRouteTab,
  WorkspaceRoute,
  WorkspaceRouteChangeOptions,
  WorkspaceRouteView
} from "../workspace/workspace-route";
import { STANDALONE_AUTH_SOURCE } from "../workspace-utils";
import { canViewAdministrationPanel } from "./governance";

export interface ControlPlaneModelInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  adminPanel: ChatShellAdminPanel | undefined;
  user: ApiUser | undefined;
  configAssetManagement: SafeConfig["features"]["configAssets"] | undefined;
  userInvitationsEnabled: boolean;
  isAuthenticated: boolean;
  route: WorkspaceRoute;
  view: WorkspaceRouteView;
  supportedLocales: LocaleCode[];
  activeLocale: LocaleCode;
  selectLocale(locale: LocaleCode): void;
  showContextIndicator: boolean;
  setShowContextIndicator(visible: boolean): void;
  goToDefaultChat(options?: WorkspaceRouteChangeOptions): void;
  onAccountDeleted(): void;
  showSuperadmin(tab: SuperadminRouteTab, options?: WorkspaceRouteChangeOptions): void;
}

export interface ControlPlaneModel {
  canViewAdministration: boolean;
  /** True while the UI library gallery's route is active for a user who may open it. */
  showUiLibrary: boolean;
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
  showContextIndicator: boolean;
  updateProfile(input: UpdateCurrentUserRequest): Promise<ApiUser>;
  changePassword(input: ChangeCurrentUserPasswordRequest): Promise<unknown>;
  deleteAccount(): Promise<unknown>;
  selectLocale(locale: LocaleCode): void;
  setShowContextIndicator(visible: boolean): void;
}

export type ControlPlaneSuperadminModel =
  { shouldRender: false } | { shouldRender: true; panelInput: ChatShellAdminPanelInput };

export function useControlPlaneModel({
  apiBaseUrl,
  authScope,
  client,
  adminPanel,
  user,
  configAssetManagement,
  userInvitationsEnabled,
  isAuthenticated,
  route,
  view,
  supportedLocales,
  activeLocale,
  selectLocale,
  showContextIndicator,
  setShowContextIndicator,
  goToDefaultChat,
  onAccountDeleted,
  showSuperadmin
}: ControlPlaneModelInput): ControlPlaneModel {
  const routeTab = route.kind === "superadmin" ? route.tab : undefined;
  const administrationRoute = adminPanel?.resolveRoute({
    user,
    configAssetManagement,
    requestedTab: routeTab
  });
  const canViewAdministration = administrationRoute?.canView ?? false;
  const administrationPending = administrationRoute?.pending ?? false;
  const selectedAdministrationTab = administrationRoute?.selectedTab;
  const administrationEnabled = canViewAdministration && view === "superadmin";
  const canViewUiLibrary = canViewAdministrationPanel(user);
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

  useEffect(() => {
    if (!isAuthenticated || route.kind !== "superadmin") {
      return;
    }
    if (administrationPending) {
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
    administrationPending,
    canViewAdministration,
    goToDefaultChat,
    isAuthenticated,
    route,
    selectedAdministrationTab,
    showSuperadmin
  ]);

  useEffect(() => {
    if (isAuthenticated && route.kind === "ui-library" && !canViewUiLibrary) {
      goToDefaultChat({ replace: true });
    }
  }, [canViewUiLibrary, goToDefaultChat, isAuthenticated, route.kind]);

  const superadmin: ControlPlaneSuperadminModel =
    administrationEnabled && user && selectedAdministrationTab
      ? {
          shouldRender: true,
          panelInput: {
            apiBaseUrl,
            authScope,
            client,
            user,
            configAssetManagement,
            userInvitationsEnabled,
            selectedTab: selectedAdministrationTab,
            onSelectTab: showSuperadmin
          }
        }
      : { shouldRender: false };

  return {
    canViewAdministration,
    showUiLibrary: view === "ui-library" && canViewUiLibrary,
    settings: {
      shouldRender: view === "settings",
      user,
      canChangePassword: user?.authSource === STANDALONE_AUTH_SOURCE,
      updatingProfile: updateCurrentUser.isPending,
      changingPassword: changeCurrentUserPassword.isPending,
      deletingAccount: deleteCurrentUser.isPending,
      locales: supportedLocales,
      locale: activeLocale,
      showContextIndicator,
      updateProfile: (input) => updateCurrentUser.mutateAsync(input),
      changePassword: (input) => changeCurrentUserPassword.mutateAsync(input),
      deleteAccount: () => deleteCurrentUser.mutateAsync(),
      selectLocale,
      setShowContextIndicator
    },
    superadmin
  };
}
