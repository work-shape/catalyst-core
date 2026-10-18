import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { opensAssets, type BuildKind } from "./build-asset-kind";
import type { BuildKindState } from "./build-data";
import type { BuildLocation } from "../../shared/build-route";

const LAST_KIND_STORAGE_KEY = "vivd-catalyst:build-kind";

/** A kind the frame shows: its entry with what the instance says about it. */
export interface VisibleBuildKind<Entry extends BuildKind = BuildKind> {
  entry: Entry;
  state: BuildKindState;
}

/** The kinds with a rail item: the entries the instance answered for, in the registry's order. */
export function visibleBuildKinds(
  entries: readonly BuildKind[],
  states: readonly BuildKindState[]
): VisibleBuildKind[] {
  return entries.flatMap((entry) => {
    const state = states.find((candidate) => candidate.kind === entry.kind);
    return state ? [{ entry, state }] : [];
  });
}

/** What an address of the Build area shows. */
export interface BuildPlace {
  kind: VisibleBuildKind;
  /** The id of the open asset. Absent on the list. */
  name: string | undefined;
  /** The address did not name this kind, or named an asset of a kind that only lists: the frame corrects it. */
  corrected: boolean;
}

/**
 * Resolves an address. `/build` and an address with a kind the reader has no item for open the
 * kind last visited, else the first one, so Build always lands on a list. A kind that only
 * lists has no asset page: the address of one of its assets opens its list.
 */
export function resolveBuildPlace(
  kinds: readonly VisibleBuildKind[],
  location: BuildLocation,
  lastKindPath: string | undefined
): BuildPlace | undefined {
  const named = kinds.find((kind) => kind.entry.path === location.kindPath);
  if (named) {
    return opensAssets(named.entry) || location.name === undefined
      ? { kind: named, name: location.name, corrected: false }
      : { kind: named, name: undefined, corrected: true };
  }
  const fallback = kinds.find((kind) => kind.entry.path === lastKindPath) ?? kinds[0];
  return fallback ? { kind: fallback, name: undefined, corrected: true } : undefined;
}

/** The kind the reader opened last in this browser. */
export function readLastBuildKindPath(): string | undefined {
  try {
    return window.localStorage.getItem(LAST_KIND_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeLastBuildKindPath(path: string): void {
  try {
    window.localStorage.setItem(LAST_KIND_STORAGE_KEY, path);
  } catch {
    // A browser that refuses storage opens Build on the first kind.
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/** When an asset last changed, as the distance from now in the largest whole unit: "2 days ago". */
export function formatUpdated(updatedAt: string, now: Date, locale: LocaleCode): string {
  const elapsedMs = Math.max(0, now.getTime() - new Date(updatedAt).getTime());
  const [unit, size] =
    elapsedMs >= YEAR_MS
      ? (["year", YEAR_MS] as const)
      : elapsedMs >= MONTH_MS
        ? (["month", MONTH_MS] as const)
        : elapsedMs >= DAY_MS
          ? (["day", DAY_MS] as const)
          : elapsedMs >= HOUR_MS
            ? (["hour", HOUR_MS] as const)
            : (["minute", MINUTE_MS] as const);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" }).format(
    -Math.floor(elapsedMs / size),
    unit
  );
}
