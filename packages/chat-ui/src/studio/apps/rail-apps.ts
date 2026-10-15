import { useEffect, useMemo } from "react";
import type { AssetSummary } from "@work-shape/catalyst-api-client";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { useAppList } from "./app-data";
import { appState } from "./app-model";

/** How many Apps the rail lists under its Apps row. The Apps page holds every one. */
export const RAIL_APPS_LIMIT = 5;

const APP_OPENS_STORAGE_PREFIX = "vivd-catalyst:app-opens";

/** One App as the rail lists it. */
export interface RailApp {
  /** The id its address names. */
  name: string;
  /** The name people read. */
  title: string;
}

/** When this person last opened each App in this browser, by the App's id, in milliseconds. */
export type AppOpens = Readonly<Record<string, number>>;

/**
 * The Apps the rail lists: the published ones among `rows`, the one this person opened last
 * first, and the ones they never opened after those by their latest change. Never more than
 * `limit`. An App with a draft alone is not listed: it has nothing to open.
 */
export function railApps(
  rows: readonly AssetSummary[] | undefined,
  opens: AppOpens,
  limit: number = RAIL_APPS_LIMIT
): readonly RailApp[] {
  return (rows ?? [])
    .filter((app) => appState(app).kind === "published")
    .map((app) => ({ app, opened: opens[app.name] ?? 0 }))
    .sort(
      (left, right) =>
        right.opened - left.opened ||
        right.app.updatedAt.localeCompare(left.app.updatedAt) ||
        left.app.name.localeCompare(right.app.name)
    )
    .slice(0, limit)
    .map(({ app }) => ({ name: app.name, title: app.title.trim() || app.name }));
}

/** `opens` with this App opened at `at`. */
export function withAppOpen(opens: AppOpens, app: string | undefined, at: number): AppOpens {
  return app === undefined ? opens : { ...opens, [app]: at };
}

/** What the browser keeps of the opens, read as what it is: anything else counts as nothing. */
export function parseAppOpens(stored: string | null): AppOpens {
  if (stored === null) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const opens: Record<string, number> = {};
  for (const [app, at] of Object.entries(parsed)) {
    if (typeof at === "number" && Number.isFinite(at)) {
      opens[app] = at;
    }
  }
  return opens;
}

// Browser-local and scoped by instance, person and workspace, as the last workspace is.
function appOpensStorageKey(apiBaseUrl: string, userId: string, workspaceId: string): string {
  return `${APP_OPENS_STORAGE_PREFIX}:${apiBaseUrl}:${userId}:${workspaceId}`;
}

// A browser that keeps nothing, or refuses to, orders the Apps by their latest change.
function readStoredAppOpens(key: string): AppOpens {
  try {
    return parseAppOpens(window.localStorage.getItem(key));
  } catch {
    return {};
  }
}

function writeStoredAppOpens(key: string, opens: AppOpens): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(opens));
  } catch {
    // The order is a convenience: without the store it is the order of the latest change.
  }
}

/**
 * The published Apps of the open workspace for the rail, most recently opened by this person
 * first. Empty while the module is off, no workspace is open, the list has not arrived or
 * failed, or the person may open no App: the rail then shows the Apps row alone. The list is
 * the first page the Apps page reads, under the same key, so the two share one request.
 */
export function useRailApps(input: {
  enabled: boolean;
  userId: string | undefined;
  workspaceId: string | undefined;
  /** The App on screen, which counts as opened now. */
  openApp: string | undefined;
}): readonly RailApp[] {
  const { apiBaseUrl } = useWorkspaceApiClient();
  const workspaceId = input.enabled ? input.workspaceId : undefined;
  const list = useAppList(workspaceId);
  const key =
    workspaceId !== undefined && input.userId !== undefined
      ? appOpensStorageKey(apiBaseUrl, input.userId, workspaceId)
      : undefined;
  const { openApp } = input;
  const opens = useMemo(
    () => (key === undefined ? {} : withAppOpen(readStoredAppOpens(key), openApp, Date.now())),
    [key, openApp]
  );
  useEffect(() => {
    if (key !== undefined && openApp !== undefined) {
      writeStoredAppOpens(key, opens);
    }
  }, [key, openApp, opens]);
  return useMemo(() => railApps(list.rows, opens), [list.rows, opens]);
}
