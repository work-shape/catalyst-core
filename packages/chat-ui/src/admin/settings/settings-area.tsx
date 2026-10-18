import { ChevronsUpDown, Lock } from "lucide-react";
import type { CollaborationWorkspaceWithRole } from "@work-shape/catalyst-api-client";
import {
  Button,
  EmptyState,
  Page,
  Picker,
  SubRail,
  type SubRailGroup
} from "@work-shape/catalyst-ui";
import { AreaFrame, useAreaTitleFocus } from "../../shared/area-frame";
import { BuildNavigationProvider } from "../../shared/build-route";
import { CollaborationWorkspaceAvatar } from "../../shared/collaboration-workspace/collaboration-workspace-avatar";
import type { BuildAreaModel, SettingsAreaModel } from "../control-plane/control-plane-model";
import { useTranslation } from "../../shared/i18n";
import { settingsGroups } from "./catalog";
import type { SettingsPageDefinition } from "../../shared/page-definition";
import { SettingsPageProvider } from "../../shared/settings-page-context";

/** From this many workspaces on, the picker shows its search field. */
const WORKSPACE_SEARCH_FROM_COUNT = 7;

function pageValue(page: Pick<SettingsPageDefinition, "group" | "id">): string {
  return `${page.group}/${page.id}`;
}

/**
 * The Settings area: the sub-rail with the groups the viewer has, and the open page beside it.
 * The page brings its own title; the area has none.
 */
export function SettingsArea({ settings }: { settings: SettingsAreaModel }) {
  const { t } = useTranslation();
  const { pages, page, noAccess, workspaces, selectWorkspace, openPage, context } = settings;
  const areaRef = useAreaTitleFocus(page !== undefined);
  const shownGroups = settingsGroups.filter((group) =>
    pages.some((candidate) => candidate.group === group.id)
  );
  // A viewer with one group sees plain entries: a single label would only repeat the area.
  const labelled = shownGroups.length > 1;
  const groups: SubRailGroup[] = shownGroups.map((group) => ({
    id: group.id,
    label: labelled ? t(group.labelKey) : undefined,
    scope:
      group.id === "workspace" && context.workspace ? (
        <WorkspaceScope
          workspace={context.workspace}
          workspaces={workspaces}
          worksInPersonal={context.activeWorkspace?.kind === "personal"}
          onSelect={selectWorkspace}
        />
      ) : undefined,
    items: pages
      .filter((candidate) => candidate.group === group.id)
      .map((candidate) => ({
        id: pageValue(candidate),
        label: t(candidate.labelKey),
        count: candidate.count?.({ workspace: context.workspace }),
        countTone: "primary"
      }))
  }));
  const OpenPage = page?.component;

  return (
    <AreaFrame ref={areaRef} label={t("settings")}>
      <SettingsPageProvider value={context}>
        <Page
          width={page?.width}
          subRail={
            <SubRail
              title={t("settings")}
              label={t("settings.pages")}
              groups={groups}
              value={page ? pageValue(page) : ""}
              onValueChange={(id) => {
                const next = pages.find((candidate) => pageValue(candidate) === id);
                if (next) {
                  openPage(next);
                }
              }}
            />
          }
        >
          {OpenPage ? (
            <OpenPage />
          ) : noAccess ? (
            <EmptyState icon={<Lock aria-hidden="true" />}>{t("settings.noAccess")}</EmptyState>
          ) : null}
        </Page>
      </SettingsPageProvider>
    </AreaFrame>
  );
}

/** Build: the host's Build page as an area of its own. The page lays itself out. */
export function BuildArea({ build }: { build: BuildAreaModel }) {
  const { t } = useTranslation();
  const areaRef = useAreaTitleFocus(true);
  const BuildPage = build.page.component;

  return (
    <AreaFrame ref={areaRef} label={t(build.page.labelKey)}>
      <SettingsPageProvider value={build.context}>
        <BuildNavigationProvider value={build.navigation}>
          {build.closed ? (
            <Page>
              <EmptyState icon={<Lock aria-hidden="true" />}>{t("build.noAccess")}</EmptyState>
            </Page>
          ) : (
            <BuildPage />
          )}
        </BuildNavigationProvider>
      </SettingsPageProvider>
    </AreaFrame>
  );
}

/**
 * Which shared workspace the Workspace pages change: a picker for several, the name for one. A
 * personal workspace has no such pages, so while the person works in theirs the scope says
 * that the name is a shared workspace, not where they are.
 */
function WorkspaceScope({
  workspace,
  workspaces,
  worksInPersonal,
  onSelect
}: {
  workspace: CollaborationWorkspaceWithRole;
  workspaces: readonly CollaborationWorkspaceWithRole[];
  worksInPersonal: boolean;
  onSelect(collaborationWorkspaceId: string): void;
}) {
  const { t } = useTranslation();
  const mark = (candidate: CollaborationWorkspaceWithRole) => (
    <CollaborationWorkspaceAvatar
      name={candidate.name}
      emoji={candidate.emoji}
      accentColor={candidate.accentColor}
      size="sm"
    />
  );
  const caption = worksInPersonal ? (
    <span data-workspace-scope-shared="" className="text-caption text-muted-foreground">
      {t("settings.workspaceScopeShared")}
    </span>
  ) : null;
  if (workspaces.length < 2) {
    return (
      <div className="grid min-w-0 gap-0.5">
        {caption}
        <div className="flex min-w-0 items-center gap-2 text-label">
          {mark(workspace)}
          <span className="truncate">{workspace.name}</span>
        </div>
      </div>
    );
  }
  return (
    <div className="grid min-w-0 gap-0.5">
      {caption}
      <Picker
        search={workspaces.length > WORKSPACE_SEARCH_FROM_COUNT}
        value={workspace.id}
        options={workspaces.map((candidate) => ({
          value: candidate.id,
          label: candidate.name,
          leading: mark(candidate)
        }))}
        onValueChange={onSelect}
      >
        <Button
          variant="outline"
          size="sm"
          className="w-full min-w-0 justify-start"
          aria-label={`${t("settings.workspaceScope")}: ${workspace.name}`}
        >
          {mark(workspace)}
          <span className="min-w-0 flex-1 truncate text-left">{workspace.name}</span>
          <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </Picker>
    </div>
  );
}
