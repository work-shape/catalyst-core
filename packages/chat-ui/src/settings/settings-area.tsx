import { ChevronsUpDown, Lock } from "lucide-react";
import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { CollaborationWorkspaceWithRole } from "@vivd-catalyst/api-client";
import { Button, EmptyState, Page, Picker, SubRail, type SubRailGroup } from "@vivd-catalyst/ui";
import { BuildNavigationProvider } from "../build-area/build-route";
import { CollaborationWorkspaceAvatar } from "../collaboration-workspace/collaboration-workspace-avatar";
import type { BuildAreaModel, SettingsAreaModel } from "../control-plane/control-plane-model";
import { useTranslation } from "../i18n";
import { settingsGroups } from "./catalog";
import type { SettingsPageDefinition } from "./page-definition";
import { SettingsPageProvider } from "./settings-page-context";

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
              mode="routes"
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
          <BuildPage />
        </BuildNavigationProvider>
      </SettingsPageProvider>
    </AreaFrame>
  );
}

/**
 * The frame of a full-page area: it keeps the floating header's height free and scrolls
 * below it, so a sticky sub-rail never slides under the header's buttons.
 */
function AreaFrame({
  ref,
  label,
  children
}: {
  ref: RefObject<HTMLDivElement | null>;
  /** Names the area's landmark. */
  label: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] bg-background pt-(--layout-header)"
    >
      <div ref={ref} className="chat-scrollbar min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
        {children}
      </div>
    </section>
  );
}

/**
 * Puts the focus on the page title once, when the area opens. Moving between pages inside the
 * sub-rail leaves the focus on the chosen entry.
 */
function useAreaTitleFocus(ready: boolean) {
  const areaRef = useRef<HTMLDivElement>(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!ready || focusedRef.current) {
      return;
    }
    const title = areaRef.current?.querySelector("h1");
    if (title) {
      focusedRef.current = true;
      title.tabIndex = -1;
      title.focus({ preventScroll: true });
    }
  }, [ready]);

  return areaRef;
}

/** Which shared workspace the Workspace pages change: a picker for several, the name for one. */
function WorkspaceScope({
  workspace,
  workspaces,
  onSelect
}: {
  workspace: CollaborationWorkspaceWithRole;
  workspaces: readonly CollaborationWorkspaceWithRole[];
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
  if (workspaces.length < 2) {
    return (
      <div className="flex min-w-0 items-center gap-2 text-label">
        {mark(workspace)}
        <span className="truncate">{workspace.name}</span>
      </div>
    );
  }
  return (
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
  );
}
