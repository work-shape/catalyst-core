import type { LocaleCode } from "@work-shape/catalyst-api-client";
import { opensAssets, type BuildKind } from "./build-asset-kind";
import type { BuildKindState } from "./build-data";
import type { BuildLocation } from "../../shared/build-route";

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
 * first kind the reader has, Agents for most, regardless of the previous visit (ACCEPT-1c). A
 * kind that only lists has no asset page: the address of one of its assets opens its list.
 */
export function resolveBuildPlace(
  kinds: readonly VisibleBuildKind[],
  location: BuildLocation
): BuildPlace | undefined {
  const named = kinds.find((kind) => kind.entry.path === location.kindPath);
  if (named) {
    return opensAssets(named.entry) || location.name === undefined
      ? { kind: named, name: location.name, corrected: false }
      : { kind: named, name: undefined, corrected: true };
  }
  const fallback = kinds[0];
  return fallback ? { kind: fallback, name: undefined, corrected: true } : undefined;
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

/**
 * The name people read of an asset, as its definition holds it: its `title` or its
 * `displayName`, as one text or one per language, in the reader's language first. Without
 * one, its id.
 */
export function assetConfigTitle(
  asset: { name: string; config: Readonly<Record<string, unknown>> },
  locale: LocaleCode
): string {
  for (const field of ["title", "displayName"]) {
    const value = asset.config[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "object" && value !== null) {
      for (const language of [locale, locale === "de" ? "en" : "de"]) {
        const text: unknown = Reflect.get(value, language);
        if (typeof text === "string" && text.trim()) return text.trim();
      }
    }
  }
  return asset.name;
}

/** What a button's call left to say beside it: that it worked, or why it did not. */
export interface ActionNotice {
  tone: "success" | "error";
  text: string;
}
