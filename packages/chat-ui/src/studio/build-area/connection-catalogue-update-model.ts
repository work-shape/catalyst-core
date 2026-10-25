import { sameJson } from "@work-shape/catalyst-core";
import { recordOf } from "./connection-approval-model";
import {
  catalogueLink,
  managedSettings,
  type CatalogueEntryOffer,
  type CataloguePartOffer
} from "./connection-catalogue-model";
import { withPartScopes } from "./connection-catalogue-oauth";

// The update of a Connection on the operator's managed OAuth client to the version of its
// catalogue entry this instance ships (MS-APP-RELINK), without React. The instance holds such a
// Connection to its part's current settings exactly; what is built here is what the page saves.

/**
 * A Connection on the operator's managed OAuth client that was installed from another version
 * of its entry than the one this instance ships (MS-APP-RELINK). It keeps its part's settings
 * exactly, and the instance knows only the current version's, so nothing else of it can be
 * saved until it is relinked.
 */
export interface CatalogueUpdate {
  entry: CatalogueEntryOffer;
  part: CataloguePartOffer;
  /** The entry version the Connection was installed from. */
  from: number;
  /** The definition relinked: the current version's settings, its scopes, the link at it. */
  config: Record<string, unknown>;
  /** The settings the update changes, by dotted path, the scopes aside. */
  changed: string[];
}

/**
 * The update a stored definition is offered, or nothing. Only a Connection made on the
 * instance, on a managed client its entry's current part still asks for, at the entry's
 * offered part. Its operations stay as they are: the scopes follow from them.
 */
export function catalogueUpdateOf(
  config: Record<string, unknown>,
  entries: readonly CatalogueEntryOffer[]
): CatalogueUpdate | undefined {
  if (config.origin === "release" || config.authScheme !== "oauth") return undefined;
  const link = recordOf(config.catalogue);
  const settings = recordOf(config.settings) ?? {};
  const managed = recordOf(settings.oauth)?.managedClient;
  if (link === undefined || typeof link.version !== "number" || typeof managed !== "string")
    return undefined;
  const entry = entries.find((candidate) => candidate.id === link.entry && candidate.offered);
  if (entry === undefined || entry.version === link.version) return undefined;
  const part = entry.parts.find(
    (candidate) => candidate.part === link.part && candidate.connectorType === config.connectorType
  );
  if (part?.managedClient !== managed) return undefined;
  const relinked = withPartScopes(
    {
      ...config,
      catalogue: catalogueLink(entry, part.part),
      settings: managedSettings(part.settings, managed)
    },
    part
  );
  return {
    entry,
    part,
    from: link.version,
    config: relinked,
    changed: changedSettings(settings, recordOf(relinked.settings) ?? {})
  };
}

/** The consent scopes follow from the enabled operations: they are no setting of their own. */
const SCOPES_PATH = "oauth.scopes";

/** The dotted paths of the settings that differ, one level into a group such as `oauth`. */
export function changedSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): string[] {
  const changed: string[] = [];
  for (const key of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const left = recordOf(before[key]);
    const right = recordOf(after[key]);
    if (left !== undefined && right !== undefined) {
      for (const inner of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        const path = `${key}.${inner}`;
        if (path !== SCOPES_PATH && !sameJson(left[inner], right[inner])) changed.push(path);
      }
    } else if (!sameJson(before[key], after[key])) {
      changed.push(key);
    }
  }
  return changed;
}
