import type { LocaleCode } from "@vivd-catalyst/api-client";
import type { BuildAsset, BuildAssetKind } from "./build-asset-kind";
import type { BuildKindState } from "./build-data";
import type { BuildLocation } from "./build-route";

/**
 * How many assets one page of a list shows. The list is searched, sorted and cut in the
 * browser from the one read of the area, so this number bounds what is drawn, not what is read.
 */
export const BUILD_LIST_PAGE_SIZE = 50;

const LAST_KIND_STORAGE_KEY = "vivd-catalyst:build-kind";

/** A kind the frame shows: its entry with what the instance says about it. */
export interface VisibleBuildKind {
  entry: BuildAssetKind;
  state: BuildKindState;
}

/** The kinds with a rail item: the entries the instance answered for, in the registry's order. */
export function visibleBuildKinds(
  entries: readonly BuildAssetKind[],
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
  /** The address did not name this kind: the frame corrects it. */
  corrected: boolean;
}

/**
 * Resolves an address. `/build` and an address with a kind the reader has no item for open the
 * kind last visited, else the first one, so Build always lands on a list.
 */
export function resolveBuildPlace(
  kinds: readonly VisibleBuildKind[],
  location: BuildLocation,
  lastKindPath: string | undefined
): BuildPlace | undefined {
  const named = kinds.find((kind) => kind.entry.path === location.kindPath);
  if (named) {
    return { kind: named, name: location.name, corrected: false };
  }
  const fallback = kinds.find((kind) => kind.entry.path === lastKindPath) ?? kinds[0];
  return fallback ? { kind: fallback, name: undefined, corrected: true } : undefined;
}

/** One row of a list: the asset with the name the reader sees. */
interface BuildListRow {
  asset: BuildAsset;
  title: string;
}

/** One page of a kind's list after the search. */
export interface BuildListPage {
  rows: BuildListRow[];
  /** How many assets the search leaves. */
  total: number;
  /** The page shown, from 1. A page past the end is the last one. */
  page: number;
  pageCount: number;
  /** The position of the first row in the searched list, from 1. */
  from: number;
}

/**
 * The rows of one page: the assets whose name or id contains the search text, sorted by name
 * in the reader's language. It reads every asset of the kind once per call.
 */
export function buildListPage(input: {
  entry: BuildAssetKind;
  assets: readonly BuildAsset[];
  locale: LocaleCode;
  query: string;
  page: number;
}): BuildListPage {
  const { entry, assets, locale, query, page } = input;
  const needle = query.trim().toLocaleLowerCase(locale);
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const matching = assets
    .map((asset) => ({ asset, title: entry.title(asset, locale)?.trim() || asset.name }))
    .filter(
      (row) =>
        needle === "" ||
        row.title.toLocaleLowerCase(locale).includes(needle) ||
        row.asset.name.toLocaleLowerCase(locale).includes(needle)
    )
    .sort(
      (left, right) =>
        collator.compare(left.title, right.title) ||
        collator.compare(left.asset.name, right.asset.name)
    );
  const pageCount = Math.max(1, Math.ceil(matching.length / BUILD_LIST_PAGE_SIZE));
  const shownPage = Math.min(Math.max(1, page), pageCount);
  const start = (shownPage - 1) * BUILD_LIST_PAGE_SIZE;
  return {
    rows: matching.slice(start, start + BUILD_LIST_PAGE_SIZE),
    total: matching.length,
    page: shownPage,
    pageCount,
    from: matching.length === 0 ? 0 : start + 1
  };
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
