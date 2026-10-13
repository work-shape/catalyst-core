import { useEffect, useMemo } from "react";
import type {
  ApiClient,
  ApiUser,
  CollaborationWorkspaceWithRole,
  LocaleCode,
  SafeConfig
} from "@vivd-catalyst/api-client";
import type { AgentCreation } from "../agents/agents-model";
import { AGENT_ASSET_KIND, mayCreateAgents, resolveBuildRights } from "../build-area/build-rights";
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
import { usePlatformContextQuery } from "../api/workspace-queries";
import { workspaceRoutePath } from "../routes";
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
  /** The viewer may open agents in Build: the Agents page links each agent to its page there. */
  canOpenAgentsInBuild: boolean;
  /**
   * Present when the viewer may start a new agent in Studio: the Agents page offers it, with
   * the Namespaces its dialog lets the viewer name the agent in.
   */
  agentCreation: AgentCreation | undefined;
  /** True while the UI library gallery's route is active for a user who may open it. */
  showUiLibrary: boolean;
  /** Where the command palette's "Go to" group leads for this viewer. */
  goToTargets: SettingsGoToTarget[];
  /** Present while a Settings route is open. */
  settings: SettingsAreaModel | undefined;
  /** Present while a Build route is open and the instance runs with Build. */
  build: BuildAreaModel | undefined;
  /** Which instance this is and what release it runs. Absent until the instance answered. */
  platform: PlatformIdentity | undefined;
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

/** The instance and the release the account menu names. */
export interface PlatformIdentity {
  instanceName: string;
  releaseVersion: string;
}

export interface BuildAreaModel {
  page: PageDefinition;
  /** Nothing in Build is the viewer's: the area says that it is not available. */
  closed: boolean;
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
  const platformQuery = usePlatformContextQuery({
    apiBaseUrl,
    authScope,
    client,
    enabled: isAuthenticated
  });
  const platformContext = platformQuery.data;
  const viewer = useMemo<SettingsViewer>(
    () => ({ user, workspaces: collaborationWorkspaces, platform: platformContext }),
    [collaborationWorkspaces, platformContext, user]
  );
  const build = useMemo<BuildAccess>(
    () => ({
      page: administration?.build,
      enabled: config?.features.configAssets.enabled === true,
      ready: !platformQuery.isPending
    }),
    [administration, config?.features.configAssets.enabled, platformQuery.isPending]
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
    const forUiLibraryReaders = route.kind === "ui-library" || route.kind === "workflow-samples";
    if (isAuthenticated && forUiLibraryReaders && !canViewUiLibrary) {
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
            open: (location, options) => showRoute(buildRouteOfLocation(location), options),
            href: (location) => workspaceRoutePath(buildRouteOfLocation(location))
          }
        : undefined,
    [buildAssetName, buildKindPath, inBuild, showRoute]
  );

  const canViewBuild = Boolean(build.enabled && build.page?.visible(viewer));
  const buildRights = resolveBuildRights(user, platformContext);

  return {
    canViewAdministration: firstAdministrationRoute(catalog, build, viewer) !== undefined,
    canViewBuild,
    canOpenAgentsInBuild: canViewBuild && buildRights.reads(AGENT_ASSET_KIND),
    agentCreation:
      canViewBuild && mayCreateAgents(buildRights, config?.features.configAssets)
        ? {
            namespaces: buildRights.creatableNamespaces(AGENT_ASSET_KIND),
            mayNameFreely: buildRights.instanceWrite
          }
        : undefined,
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
      context &&
      buildNavigation &&
      (resolution?.kind === "build" || resolution?.kind === "build-closed")
        ? {
            page: resolution.page,
            closed: resolution.kind === "build-closed",
            context,
            navigation: buildNavigation
          }
        : undefined,
    platform: platformContext
      ? {
          instanceName: platformContext.instance.name,
          releaseVersion: platformContext.release.version
        }
      : undefined
  };
}
