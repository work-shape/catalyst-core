import type { CollaborationWorkspaceWithRole } from "@work-shape/catalyst-api-client";
import { canManageCollaborationWorkspace } from "../../shared/collaboration-workspace/collaboration-workspace-selector";
import { canChangePassword } from "../../shared/governance";
import type { TranslationKey } from "../../shared/i18n";
import type { WorkspaceRoute } from "../../shared/routes";
import type {
  ChatShellAdministration,
  PageDefinition,
  SettingsGroupId,
  SettingsPageDefinition,
  SettingsScope,
  SettingsViewer
} from "../../shared/page-definition";
import { ApiKeysPage } from "./pages/api-keys";
import { ConnectLocalAgentPage } from "./pages/connect-local-agent";
import { LanguageAppearancePage } from "./pages/language-appearance";
import { PersonalConnectionsPage } from "./pages/personal-connections";
import { ProfilePage } from "./pages/profile";
import { SecurityPage } from "./pages/security";
import { WorkspaceGeneralPage } from "./pages/workspace-general";
import { WorkspaceMembersPage } from "./pages/workspace-members";

/** The groups in the order the rail shows them. */
export const settingsGroups: readonly { id: SettingsGroupId; labelKey: TranslationKey }[] = [
  { id: "you", labelKey: "settings.you" },
  { id: "workspace", labelKey: "settings.workspace" },
  { id: "instance", labelKey: "settings.instance" }
];

const everyone = () => true;

/** The shared workspaces the viewer may manage: the ones the Workspace pages can change. */
export function managedWorkspaces(viewer: SettingsViewer): CollaborationWorkspaceWithRole[] {
  return viewer.workspaces.filter(canManageCollaborationWorkspace);
}

const managesAWorkspace = (viewer: SettingsViewer) => managedWorkspaces(viewer).length > 0;

/**
 * The You and Workspace pages: one line per page, in the order of its group. A new page adds
 * its file under `pages/` and its line here. The Instance pages are the host's, in
 * `administration.ts`.
 */
const settingsPages: readonly SettingsPageDefinition[] = [
  {
    id: "profile",
    group: "you",
    labelKey: "settings.profile",
    width: "narrow",
    visible: everyone,
    component: ProfilePage
  },
  {
    id: "language-appearance",
    group: "you",
    labelKey: "settings.languageAppearance",
    width: "narrow",
    visible: everyone,
    component: LanguageAppearancePage
  },
  {
    id: "security",
    group: "you",
    labelKey: "settings.security",
    width: "narrow",
    visible: (viewer) => canChangePassword(viewer.user),
    component: SecurityPage
  },
  {
    id: "connections",
    group: "you",
    labelKey: "settings.personalConnections",
    width: "narrow",
    visible: (viewer) => viewer.modules?.connections?.enabled === true,
    component: PersonalConnectionsPage
  },
  {
    id: "api-keys",
    group: "you",
    labelKey: "settings.apiKeys",
    visible: (viewer) => viewer.modules?.personalApiKeys?.enabled === true,
    component: ApiKeysPage
  },
  {
    id: "connect",
    group: "you",
    labelKey: "settings.connectLocalAgent",
    width: "narrow",
    visible: (viewer) => viewer.modules?.personalApiKeys?.enabled === true,
    component: ConnectLocalAgentPage
  },
  {
    id: "general",
    group: "workspace",
    labelKey: "settings.general",
    width: "narrow",
    visible: managesAWorkspace,
    component: WorkspaceGeneralPage
  },
  {
    id: "members",
    group: "workspace",
    labelKey: "settings.members",
    visible: managesAWorkspace,
    component: WorkspaceMembersPage,
    count: pendingAccessRequests
  }
];

function pendingAccessRequests(scope: SettingsScope): number | undefined {
  return scope.workspace?.pendingAccessRequestCount || undefined;
}

/** Every Settings page of this shell: its own and the ones the host mounts, by group. */
export function settingsCatalog(
  administration: ChatShellAdministration | undefined
): SettingsPageDefinition[] {
  const pages = [...settingsPages, ...(administration?.pages ?? [])];
  return settingsGroups.flatMap((group) => pages.filter((page) => page.group === group.id));
}

/** The pages the viewer may open, in rail order. */
export function visibleSettingsPages(
  catalog: readonly SettingsPageDefinition[],
  viewer: SettingsViewer
): SettingsPageDefinition[] {
  return catalog.filter((page) => page.visible(viewer));
}

/** The address of a Settings page. */
function settingsPageRoute(page: Pick<SettingsPageDefinition, "group" | "id">): WorkspaceRoute {
  return { kind: "settings", group: page.group, page: page.id };
}

/** What the viewer and the instance allow of the host's Build page. */
export interface BuildAccess {
  page: PageDefinition | undefined;
  /** The instance runs with editable agents and skills. */
  enabled: boolean;
  /** The instance said what the viewer may do. Until then Build is neither open nor closed. */
  ready: boolean;
}

function visibleBuildPage(build: BuildAccess, viewer: SettingsViewer): PageDefinition | undefined {
  return build.enabled && build.page?.visible(viewer) ? build.page : undefined;
}

/**
 * Where the Settings gear and the old `/admin` address lead: the first Instance page the viewer
 * may see, else General of a shared workspace they manage, else Build. Nothing for a viewer
 * with none of them.
 */
export function firstAdministrationRoute(
  catalog: readonly SettingsPageDefinition[],
  build: BuildAccess,
  viewer: SettingsViewer
): WorkspaceRoute | undefined {
  const visible = visibleSettingsPages(catalog, viewer);
  const first =
    visible.find((page) => page.group === "instance") ??
    visible.find((page) => page.group === "workspace");
  if (first) {
    return settingsPageRoute(first);
  }
  return visibleBuildPage(build, viewer) ? { kind: "build" } : undefined;
}

/** What a route of the Settings or Build area shows to this viewer. */
export type SettingsResolution =
  /** The answer waits on the workspace list. */
  | { kind: "pending" }
  | { kind: "page"; page: SettingsPageDefinition }
  | { kind: "build"; page: PageDefinition }
  /** Build exists here and nothing in it is the viewer's: the area says so. */
  | { kind: "build-closed"; page: PageDefinition }
  /** A page of Settings the viewer may not open: the area says so in place of the page. */
  | { kind: "no-access" }
  /** The address leads elsewhere. */
  | { kind: "redirect"; route: WorkspaceRoute }
  /** Nothing of the administration is the viewer's: back to chat, as before. */
  | { kind: "chat" };

/**
 * Resolves an address: `/admin` and an address of no page lead to the first page the viewer
 * may open, else to chat; Security without a changeable password leads to Profile; any other
 * closed page says that it is closed, and so does Build for a viewer who holds no right on an
 * agent or a skill.
 */
export function resolveSettingsRoute(input: {
  route: WorkspaceRoute;
  catalog: readonly SettingsPageDefinition[];
  build: BuildAccess;
  viewer: SettingsViewer;
  /** False while the workspace list loads: a Workspace page cannot be answered yet. */
  workspacesReady: boolean;
  /**
   * False while the platform context loads: a page shown by a right that only the context
   * tells, such as API access by `service_principals.manage`, cannot be answered yet.
   */
  platformReady: boolean;
}): SettingsResolution | undefined {
  const { route, catalog, build, viewer, workspacesReady, platformReady } = input;
  const administration = (): SettingsResolution => {
    if (!workspacesReady || !platformReady) {
      return { kind: "pending" };
    }
    const first = firstAdministrationRoute(catalog, build, viewer);
    return first ? { kind: "redirect", route: first } : { kind: "chat" };
  };

  if (route.kind === "administration") {
    return administration();
  }
  if (route.kind === "build" || route.kind === "build-kind" || route.kind === "build-asset") {
    const page = visibleBuildPage(build, viewer);
    if (page) {
      return { kind: "build", page };
    }
    if (!build.enabled || !build.page) {
      return administration();
    }
    return build.ready ? { kind: "build-closed", page: build.page } : { kind: "pending" };
  }
  if (route.kind !== "settings") {
    return undefined;
  }
  const page = catalog.find(
    (candidate) => candidate.group === route.group && candidate.id === route.page
  );
  if (page?.visible(viewer)) {
    return { kind: "page", page };
  }
  if (!platformReady) {
    return { kind: "pending" };
  }
  // An Instance page that exists says it is closed, where it is, rather than leading elsewhere
  // without a word; an address of no page leads to the first one the viewer may open.
  if (route.group === "instance" && page === undefined) {
    return administration();
  }
  if (route.group === "you" && route.page === "security") {
    return { kind: "redirect", route: { kind: "settings", group: "you", page: "profile" } };
  }
  if (route.group === "workspace" && !workspacesReady) {
    return { kind: "pending" };
  }
  return { kind: "no-access" };
}

/** One place the command palette's "Go to" group offers. */
export interface SettingsGoToTarget {
  id: string;
  labelKey: TranslationKey;
  /** The Settings group of a page, which the palette names before it: "Instance › Users". */
  groupLabelKey?: TranslationKey;
  route: WorkspaceRoute;
}

/** The Settings pages the viewer may open and Build, for the palette. Nothing closed is listed. */
export function settingsGoToTargets(
  catalog: readonly SettingsPageDefinition[],
  build: BuildAccess,
  viewer: SettingsViewer
): SettingsGoToTarget[] {
  const targets: SettingsGoToTarget[] = visibleSettingsPages(catalog, viewer).map((page) => ({
    id: `settings/${page.group}/${page.id}`,
    labelKey: page.labelKey,
    groupLabelKey: settingsGroups.find((group) => group.id === page.group)?.labelKey,
    route: settingsPageRoute(page)
  }));
  const buildPage = visibleBuildPage(build, viewer);
  if (buildPage) {
    targets.push({ id: "build", labelKey: buildPage.labelKey, route: { kind: "build" } });
  }
  return targets;
}
