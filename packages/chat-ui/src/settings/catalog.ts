import type { CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import { canManageCollaborationWorkspace } from "../collaboration-workspace/collaboration-workspace-selector";
import { canChangePassword } from "../control-plane/governance";
import type { TranslationKey } from "../i18n";
import type { WorkspaceRoute } from "../routes";
import type {
  ChatShellAdministration,
  PageDefinition,
  SettingsGroupId,
  SettingsPageDefinition,
  SettingsScope,
  SettingsViewer
} from "./page-definition";
import { LanguageAppearancePage } from "./pages/language-appearance";
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
  /** A page of Settings the viewer may not open: the area says so in place of the page. */
  | { kind: "no-access" }
  /** The address leads elsewhere. */
  | { kind: "redirect"; route: WorkspaceRoute }
  /** Nothing of the administration is the viewer's: back to chat, as before. */
  | { kind: "chat" };

/**
 * Resolves an address the way the old areas answered it: an administration address the viewer
 * may not open leads to the first one they may, else to chat; Security without a changeable
 * password leads to Profile; any other closed page says that it is closed.
 */
export function resolveSettingsRoute(input: {
  route: WorkspaceRoute;
  catalog: readonly SettingsPageDefinition[];
  build: BuildAccess;
  viewer: SettingsViewer;
  /** False while the workspace list loads: a Workspace page cannot be answered yet. */
  workspacesReady: boolean;
}): SettingsResolution | undefined {
  const { route, catalog, build, viewer, workspacesReady } = input;
  const administration = (): SettingsResolution => {
    if (!workspacesReady) {
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
    return page ? { kind: "build", page } : administration();
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
  if (route.group === "instance") {
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
    route: settingsPageRoute(page)
  }));
  const buildPage = visibleBuildPage(build, viewer);
  if (buildPage) {
    targets.push({ id: "build", labelKey: buildPage.labelKey, route: { kind: "build" } });
  }
  return targets;
}
