import { useQuery } from "@tanstack/react-query";
import type { AppActions } from "@work-shape/catalyst-api-client";
import {
  ToolChip,
  ToolGroup,
  toggleToolName,
  toolGroupStartsOpen,
  type ToolGroupTool
} from "../build-area/tool-group";
import { useTranslation } from "../i18n";
import { useSettingsPage } from "../settings/settings-page-context";

// The named actions of published Apps an agent can be given, as the agent page offers them.
// The instance answers them for the Apps the reader may read (`apps.actions.list`). An action
// is offered where an agent can carry it now: its App is published and the operation it stands
// for is exposed to agents. A name the agent holds and the answer lacks is kept and shown as
// unavailable. The page never drops a name the reader did not remove.

/** What every tool name of an App's action starts with. */
const APP_TOOL_PREFIX = "app.";

/** What the instance says of the actions of Apps, as the agent page asked for it. */
export type AppToolsRead =
  | { status: "loading" }
  /** The read failed, or the instance has no Apps. Nothing can be offered. */
  | { status: "unknown" }
  | {
      status: "ready";
      apps: AppActions["apps"];
      /** The instance has more published Apps than one answer lists, and left some out. */
      truncated: boolean;
    };

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
  /** The answer left Apps out: the groups are not every App the reader may read. */
  cut: boolean;
  /**
   * The names the agent holds that no group offers, where the answer is whole. Empty until
   * the instance answered.
   */
  unavailable: string[];
  /**
   * The names the agent holds of which nothing is known: before the instance answered, and
   * those no group offers where the answer left Apps out. Shown, never judged.
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
    const tools = app.actions
      .filter((action) => action.agentTool)
      .map((action) => ({
        toolName: action.toolName,
        label: action.name,
        effect: action.effect,
        ...(action.description === undefined ? {} : { description: action.description })
      }));
    return tools.length > 0 ? [{ name: app.name, title: app.title, tools }] : [];
  });
  const offered = new Set(offering.flatMap((app) => app.tools.map((tool) => tool.toolName)));
  const unoffered = held.filter((toolName) => !offered.has(toolName));
  return {
    groups: offering.map((app) => ({
      ...app,
      startsOpen: toolGroupStartsOpen({
        toolCount: app.tools.length,
        selectedCount: app.tools.filter((tool) => selected.includes(tool.toolName)).length,
        groupCount: offering.length
      })
    })),
    cut: read.truncated,
    // An action of an App the answer left out is as available as ever.
    unavailable: read.truncated ? [] : unoffered,
    unchecked: read.truncated ? unoffered : []
  };
}

/**
 * The actions of the published Apps on the instance: one read when the agent page opens. The
 * instance answers every App the reader may read in one answer.
 */
export function useAppToolsRead(): AppToolsRead {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const query = useQuery({
    queryKey: ["app-tools", apiBaseUrl, authScope],
    queryFn: ({ signal }) => client.apps.actions.list({ signal }),
    retry: false
  });
  return query.data
    ? { status: "ready", apps: query.data.apps, truncated: query.data.truncated }
    : query.isPending
      ? { status: "loading" }
      : { status: "unknown" };
}

/**
 * The actions of Apps in an agent's Tools section: one folding group per published App the
 * reader may read, a check box per action an agent can carry, and after them the names the
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
      {view.cut ? (
        <p className="text-caption text-muted-foreground" data-app-tools-cut>
          {t("apps.toolsCut")}
        </p>
      ) : null}
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
