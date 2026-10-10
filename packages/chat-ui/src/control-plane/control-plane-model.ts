import { useEffect, useMemo } from "react";
import type {
  ApiClient,
  ApiUser,
  CollaborationWorkspaceWithRole,
  LocaleCode,
  SafeConfig
} from "@vivd-catalyst/api-client";
import {
  buildLocationOfRoute,
  buildRouteOfLocation,
  type BuildNavigation
} from "../build-area/build-route";
import {
  firstAdministrationRoute,
  managedWorkspaces,
  resolveSettingsRoute,
  settingsCatalog,
  settingsGoToTargets,
  visibleSettingsPages,
  type BuildAccess,
  type SettingsGoToTarget
} from "../settings/catalog";
import type {
  ChatShellAdministration,
  PageDefinition,
  SettingsPageDefinition,
  SettingsViewer
} from "../settings/page-definition";
import type { SettingsPageContextValue } from "../settings/settings-page-context";
import type { ThemeModePreference } from "../theme";
import type {
  WorkspaceRoute,
  WorkspaceRouteChangeOptions,
  WorkspaceRouteView
} from "../workspace/workspace-route";
import { canViewAdministrationPanel } from "./governance";

export interface ControlPlaneModelInput {
  apiBaseUrl: string;
  authScope: string;
  client: ApiClient;
  administration: ChatShellAdministration | undefined;
  user: ApiUser | undefined;
  config: SafeConfig | undefined;
  collaborationWorkspaces: CollaborationWorkspaceWithRole[];
  /** False while the workspace list loads. */
  collaborationWorkspacesReady: boolean;
  /** The shared workspace the Workspace pages change. */
  settingsCollaborationWorkspace: CollaborationWorkspaceWithRole | undefined;
  selectSettingsCollaborationWorkspace(collaborationWorkspaceId: string): void;
  isAuthenticated: boolean;
  route: WorkspaceRoute;
  view: WorkspaceRouteView;
  supportedLocales: LocaleCode[];
  activeLocale: LocaleCode;
  selectLocale(locale: LocaleCode): void;
  showContextIndicator: boolean;
  setShowContextIndicator(visible: boolean): void;
  themePreference: ThemeModePreference;
  selectThemePreference(preference: ThemeModePreference): void;
  goToDefaultChat(options?: WorkspaceRouteChangeOptions): void;
  showRoute(route: WorkspaceRoute, options?: WorkspaceRouteChangeOptions): void;
  onAccountDeleted(): void;
  onCollaborationWorkspaceDeleted(collaborationWorkspaceId: string): void;
}

export interface ControlPlaneModel {
  /** The viewer has an administration page: the rail shows the Settings gear. */
  canViewAdministration: boolean;
  /** The viewer may open Build: the rail shows its row. */
  canViewBuild: boolean;
  /** True while the UI library gallery's route is active for a user who may open it. */
  showUiLibrary: boolean;
  /** Where the command palette's "Go to" group leads for this viewer. */
  goToTargets: SettingsGoToTarget[];
  /** Present while a Settings route is open. */
  settings: SettingsAreaModel | undefined;
  /** Present while the Build route is open for a viewer who may see it. */
  build: BuildAreaModel | undefined;
}

export interface SettingsAreaModel {
  /** The pages the viewer may open, in rail order. */
  pages: SettingsPageDefinition[];
  /** The open page. Absent for an address the viewer may not open, and while it resolves. */
  page: SettingsPageDefinition | undefined;
  /** The address is a page the viewer may not open. */
  noAccess: boolean;
  /** The shared workspaces the viewer may manage. */
  workspaces: CollaborationWorkspaceWithRole[];
  selectWorkspace(collaborationWorkspaceId: string): void;
  openPage(page: SettingsPageDefinition): void;
  context: SettingsPageContextValue;
}

export interface BuildAreaModel {
  page: PageDefinition;
  context: SettingsPageContextValue;
  /** The open place in Build and the way to another one. */
  navigation: BuildNavigation;
}

export function useControlPlaneModel({
  apiBaseUrl,
  authScope,
  client,
  administration,
  user,
  config,
  collaborationWorkspaces,
  collaborationWorkspacesReady,
  settingsCollaborationWorkspace,
  selectSettingsCollaborationWorkspace,
  isAuthenticated,
  route,
  view,
  supportedLocales,
  activeLocale,
  selectLocale,
  showContextIndicator,
  setShowContextIndicator,
  themePreference,
  selectThemePreference,
  goToDefaultChat,
  showRoute,
  onAccountDeleted,
  onCollaborationWorkspaceDeleted
}: ControlPlaneModelInput): ControlPlaneModel {
  const catalog = useMemo(() => settingsCatalog(administration), [administration]);
  const viewer = useMemo<SettingsViewer>(
    () => ({ user, workspaces: collaborationWorkspaces }),
    [collaborationWorkspaces, user]
  );
  const build = useMemo<BuildAccess>(
    () => ({
      page: administration?.build,
      enabled: config?.features.configAssets.enabled === true
    }),
    [administration, config?.features.configAssets.enabled]
  );
  // An address is answered once the user and the configuration are known.
  const resolution =
    isAuthenticated && user && config
      ? resolveSettingsRoute({
          route,
          catalog,
          build,
          viewer,
          workspacesReady: collaborationWorkspacesReady
        })
      : undefined;
  const canViewUiLibrary = canViewAdministrationPanel(user);

  useEffect(() => {
    if (resolution?.kind === "redirect") {
      showRoute(resolution.route, { replace: true });
    } else if (resolution?.kind === "chat") {
      goToDefaultChat({ replace: true });
    }
  }, [goToDefaultChat, resolution, showRoute]);

  useEffect(() => {
    if (isAuthenticated && route.kind === "ui-library" && !canViewUiLibrary) {
      goToDefaultChat({ replace: true });
    }
  }, [canViewUiLibrary, goToDefaultChat, isAuthenticated, route.kind]);

  const context: SettingsPageContextValue | undefined =
    user && config
      ? {
          apiBaseUrl,
          authScope,
          client,
          user,
          config,
          locales: supportedLocales,
          locale: activeLocale,
          selectLocale,
          showContextIndicator,
          setShowContextIndicator,
          themePreference,
          selectThemePreference,
          workspace: settingsCollaborationWorkspace,
          onAccountDeleted,
          onWorkspaceLeft: () => goToDefaultChat(),
          onWorkspaceDeleted: onCollaborationWorkspaceDeleted
        }
      : undefined;

  const buildLocation = buildLocationOfRoute(route);
  const buildKindPath = buildLocation?.kindPath;
  const buildAssetName = buildLocation?.name;
  const inBuild = buildLocation !== undefined;
  const buildNavigation = useMemo<BuildNavigation | undefined>(
    () =>
      inBuild
        ? {
            location: { kindPath: buildKindPath, name: buildAssetName },
            open: (location, options) => showRoute(buildRouteOfLocation(location), options)
          }
        : undefined,
    [buildAssetName, buildKindPath, inBuild, showRoute]
  );

  return {
    canViewAdministration: firstAdministrationRoute(catalog, build, viewer) !== undefined,
    canViewBuild: Boolean(build.enabled && build.page?.visible(viewer)),
    showUiLibrary: view === "ui-library" && canViewUiLibrary,
    goToTargets: settingsGoToTargets(catalog, build, viewer),
    settings:
      context && view === "settings"
        ? {
            pages: visibleSettingsPages(catalog, viewer),
            page: resolution?.kind === "page" ? resolution.page : undefined,
            noAccess: resolution?.kind === "no-access",
            workspaces: managedWorkspaces(viewer),
            selectWorkspace: selectSettingsCollaborationWorkspace,
            openPage: (page) => showRoute({ kind: "settings", group: page.group, page: page.id }),
            context
          }
        : undefined,
    build:
      context && buildNavigation && resolution?.kind === "build"
        ? { page: resolution.page, context, navigation: buildNavigation }
        : undefined
  };
}
