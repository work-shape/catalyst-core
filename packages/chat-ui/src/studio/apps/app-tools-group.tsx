import { useInfiniteQuery } from "@tanstack/react-query";
import type { AppActions } from "@work-shape/catalyst-api-client";
import { appActionOperationName } from "@work-shape/catalyst-core";
import { LoadMore } from "@work-shape/catalyst-ui";
import type { MoreRead } from "../build-area/paged-items";
import {
  ToolChip,
  ToolGroup,
  toggleToolName,
  toolGroupStartsOpen,
  type ToolGroupTool
} from "../build-area/tool-group";
import { useTranslation } from "../../shared/i18n";
import { useSettingsPage } from "../../shared/settings-page-context";

// The named actions of published Apps an agent can be given, as the agent page offers them.
// The instance answers them for the Apps the reader may read or use (`apps.actions.list`); the page
// offers those of the agent's owner and of the instance. An action
// is offered where an agent can carry it now: its App is published and the operation it stands
// for is exposed to agents. A name the agent holds and the answer lacks is kept and shown as
// unavailable. The page never drops a name the reader did not remove. A reader gets each action
// in full; a holder of use alone gets its name, description and effect, and every one of those is
// offered under its deterministic tool name.

/** What every tool name of an App's action starts with. */
const APP_TOOL_PREFIX = "app.";
/** How many Apps one page of the agent page's read asks the instance for. */
const APP_TOOLS_PAGE_SIZE = 50;

/** What the instance says of the actions of Apps, as the agent page asked for it. */
export type AppToolsRead =
  | { status: "loading" }
  /** The read failed, or the instance has no Apps. Nothing can be offered. */
  | { status: "unknown" }
  | {
      status: "ready";
      apps: AppActions["apps"];
      /** Present while more published Apps follow those read: reads the next page. */
      more?: MoreRead;
    };

/** One listed action of an App: in full for a reader, its summary for a holder of use alone. */
type ListedAppAction = AppActions["apps"][number]["actions"][number];

/** The check box an action gets, where an agent can carry it now. */
function offeredTool(app: string, action: ListedAppAction): ToolGroupTool[] {
  if ("kind" in action && !action.agentTool) {
    return [];
  }
  return [
    {
      toolName: "kind" in action ? action.toolName : appActionOperationName(app, action.name),
      label: action.name,
      effect: action.effect,
      ...(action.description === undefined ? {} : { description: action.description })
    }
  ];
}

/** Whether a tool name is one of an App's action, by its form alone. */
export function isAppToolName(toolName: string): boolean {
  return toolName.startsWith(APP_TOOL_PREFIX);
}

interface AppToolGroupView {
  name: string;
  title: string;
  tools: ToolGroupTool[];
  startsOpen: boolean;
}

interface AppToolsView {
  groups: AppToolGroupView[];
  /** More Apps follow those read: the groups are not every App the reader may read yet. */
  cut: boolean;
  /**
   * The names the agent holds that no group offers, where the answer is whole. Empty until
   * the instance answered.
   */
  unavailable: string[];
  /**
   * The names the agent holds of which nothing is known: before the instance answered, and
   * those no group offers while more Apps follow. Shown, never judged.
   */
  unchecked: string[];
}

/** The groups to show and the names the agent holds that none of them offers. */
export function appToolsView(read: AppToolsRead, selected: readonly string[]): AppToolsView {
  const held = selected.filter(isAppToolName);
  if (read.status !== "ready") {
    return { groups: [], cut: false, unavailable: [], unchecked: held };
  }
  const offering = read.apps.flatMap((app) => {
    const tools = app.actions.flatMap((action) => offeredTool(app.name, action));
    return tools.length > 0 ? [{ name: app.name, title: app.title, tools }] : [];
  });
  const offered = new Set(offering.flatMap((app) => app.tools.map((tool) => tool.toolName)));
  const unoffered = held.filter((toolName) => !offered.has(toolName));
  const cut = read.more !== undefined;
  return {
    groups: offering.map((app) => ({
      ...app,
      startsOpen: toolGroupStartsOpen({
        toolCount: app.tools.length,
        selectedCount: app.tools.filter((tool) => selected.includes(tool.toolName)).length,
        groupCount: offering.length
      })
    })),
    cut,
    // An action of an App not read yet is as available as ever.
    unavailable: cut ? [] : unoffered,
    unchecked: cut ? unoffered : []
  };
}

/**
 * The Apps an agent of `owner` may name: an agent of the instance those of the instance, an
 * agent of a workspace those of its workspace and of the instance.
 */
export function appsOfOwner(
  apps: AppActions["apps"],
  owner: string | undefined
): AppActions["apps"] {
  return apps.filter(
    (app) =>
      app.scope.kind === "instance" || (owner !== undefined && app.scope.workspaceId === owner)
  );
}

/**
 * The actions of the published Apps an agent of `owner` may name: the first page when the agent
 * page opens, and the next as the reader asks for it. The instance pages every App the reader
 * may read or use; the page keeps those of the agent's owner and of the instance.
 */
export function useAppToolsRead(owner: string | undefined): AppToolsRead {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const query = useInfiniteQuery({
    queryKey: ["app-tools", apiBaseUrl, authScope, owner ?? ""],
    queryFn: ({ pageParam, signal }) =>
      client.apps.actions.list({
        query: { limit: APP_TOOLS_PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) },
        signal
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor,
    retry: false
  });
  return query.data
    ? {
        status: "ready",
        apps: appsOfOwner(
          query.data.pages.flatMap((page) => page.apps),
          owner
        ),
        ...(query.hasNextPage
          ? {
              more: {
                loading: query.isFetchingNextPage,
                load: () => void query.fetchNextPage().catch(() => undefined)
              }
            }
          : {})
      }
    : query.isPending
      ? { status: "loading" }
      : { status: "unknown" };
}

/**
 * The actions of Apps in an agent's Tools section: one folding group per published App the
 * reader may read or use, a check box per action an agent can carry, and after them the names the
 * agent holds that nothing offers. Those stay until the reader removes them. A group of the
 * same rank as the Connections beside it.
 */
export function AppToolsGroup({
  read,
  selected,
  disabled,
  onChange
}: {
  read: AppToolsRead;
  /** Every tool name the agent holds. The group reads and changes those of Apps. */
  selected: readonly string[];
  disabled?: boolean;
  onChange(selected: string[]): void;
}) {
  const { t } = useTranslation();
  const view = appToolsView(read, selected);
  const held = [...view.unchecked, ...view.unavailable];
  // An instance that offers nothing of Apps shows the group only for what the agent holds,
  // and to say that Apps were left out.
  if (view.groups.length === 0 && held.length === 0 && !view.cut) {
    return null;
  }
  const remove = disabled
    ? undefined
    : (toolName: string) => onChange(toggleToolName(selected, toolName, false));
  return (
    <fieldset className="grid min-w-0 gap-3" data-tool-group="apps">
      <legend className="text-label">{t("apps.title")}</legend>
      <p className="text-caption text-muted-foreground">{t("apps.toolsHint")}</p>
      {view.groups.map((group) => (
        <ToolGroup
          key={group.name}
          source={{ kind: "app", name: group.name }}
          title={group.title.trim() || group.name}
          tools={group.tools}
          selected={selected}
          startsOpen={group.startsOpen}
          disabled={disabled}
          onChange={onChange}
        />
      ))}
      {read.status === "ready" && read.more ? (
        <div className="grid justify-items-start gap-1" data-app-tools-cut>
          <p className="text-caption text-muted-foreground">{t("apps.toolsCut")}</p>
          <LoadMore
            loading={read.more.loading}
            onLoad={read.more.load}
            label={t("apps.showMore")}
            data-app-tools-more=""
          />
        </div>
      ) : null}
      {held.length > 0 ? (
        <div className="grid min-w-0 gap-2">
          <p className="text-caption text-muted-foreground">
            {t(
              read.status === "loading"
                ? "apps.toolsLoading"
                : read.status === "unknown"
                  ? "apps.toolsUnknown"
                  : view.cut
                    ? "apps.toolsHeldUnlisted"
                    : "apps.toolsUnavailable"
            )}
          </p>
          <ul aria-label={t("apps.toolsHeld")} className="flex min-w-0 flex-wrap gap-2">
            {held.map((toolName) => (
              <li key={toolName} data-held-app-tool={toolName} className="min-w-0">
                <ToolChip toolName={toolName} remove={remove} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </fieldset>
  );
}
