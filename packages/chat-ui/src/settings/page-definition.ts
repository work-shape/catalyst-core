import type { ComponentType } from "react";
import type { ApiUser, CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import type { PageWidth } from "@vivd-catalyst/ui";
import type { TranslationKey } from "../i18n";

/** The groups of the Settings rail: what a page changes. */
export type SettingsGroupId = "you" | "workspace" | "instance";

/**
 * Who looks at Settings: the user with the permission list the server put on it, and the
 * workspaces with the role the user acts in. A visibility function reads nothing else.
 */
export interface SettingsViewer {
  user: ApiUser | undefined;
  workspaces: readonly CollaborationWorkspaceWithRole[];
}

/** What a page is told about the scope its group is switched to. */
export interface SettingsScope {
  /** The shared workspace the Workspace pages change. */
  workspace: CollaborationWorkspaceWithRole | undefined;
}

/** A page a host can mount: its name, who sees it and what it shows. */
export interface PageDefinition {
  labelKey: TranslationKey;
  /** Hides the page from a viewer who may not open it. The server checks the right itself. */
  visible(viewer: SettingsViewer): boolean;
  component: ComponentType;
}

/** One page of the Settings area, at `/settings/<group>/<id>`. */
export interface SettingsPageDefinition extends PageDefinition {
  id: string;
  group: SettingsGroupId;
  /** `narrow` for a form, `wide` for a page that uses all the room. A list keeps the default. */
  width?: PageWidth;
  /** What waits on the page, shown as a count on its rail entry. */
  count?(scope: SettingsScope): number | undefined;
}

/**
 * The administration pages a host mounts: the Instance pages of Settings, and Config as the
 * Build page. A host that leaves it out ships no administration code.
 */
export interface ChatShellAdministration {
  pages: readonly SettingsPageDefinition[];
  build: PageDefinition;
}
