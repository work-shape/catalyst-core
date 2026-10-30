import type { LocaleCode } from "@work-shape/catalyst-api-client";
import type { DraftLiveRevision, DraftTestTarget } from "@work-shape/catalyst-ui";
import type { TranslationContextValue } from "../shared/i18n";
import { formatDayShort } from "../shared/locale-format";
import { personName } from "../shared/person-name";
import type { WorkspaceRoute } from "../shared/workspace-route";
import { routeLink, type OpenRoute } from "./workflows/workflows-frame";

// What the head of a draft says (DT-1b), the same for an App and a Workflow: the live
// revision, and the test copies its changing calls write to instead of the live data.

/** Where a Data Store's page is in the build area, which has its test copy (DT-2). */
const DATA_STORES_BUILD_PATH = "data-stores";

/** The live version as the instance names it on the read of a draft. */
export interface LiveVersionFacts {
  number: number;
  publishedAt?: string | undefined;
  by?: string | undefined;
}

/**
 * The live revision line of a draft's head: `null` where nothing is published, nothing where
 * something is live and its version is not known yet, so the line waits rather than guesses.
 */
export function draftLiveOf(
  published: boolean,
  live: LiveVersionFacts | undefined,
  locale: LocaleCode,
  t: TranslationContextValue["t"]
): DraftLiveRevision | null | undefined {
  if (!published) return null;
  if (live === undefined) return undefined;
  return {
    version: live.number,
    // The server sends an empty name for an account that is gone: "Deleted account".
    ...(live.by === undefined ? {} : { by: personName(live.by, t) }),
    ...(live.publishedAt === undefined ? {} : { at: formatDayShort(live.publishedAt, locale) })
  };
}

/** A Data Store whose test copy the draft's changing calls write to, by name and title. */
export interface DraftTestCopy {
  name: string;
  title: string;
}

/** The head's test targets: each test copy, a way to its Data Store where routes open. */
export function draftTestTargetsOf(
  copies: readonly DraftTestCopy[] | undefined,
  onOpenRoute: OpenRoute | undefined
): DraftTestTarget[] {
  return (copies ?? []).map((store) => {
    const route: WorkspaceRoute = {
      kind: "build-asset",
      assetKind: DATA_STORES_BUILD_PATH,
      name: store.name
    };
    return {
      name: store.title,
      kind: "copy",
      ...(onOpenRoute === undefined ? {} : { link: <a {...routeLink(route, onOpenRoute)} /> })
    };
  });
}
