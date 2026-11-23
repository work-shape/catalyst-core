import { createHash } from "node:crypto";
import {
  documentFolderMatches,
  documentNameMatches,
  documentPathMatches
} from "@work-shape/catalyst-core";
import type { KnowledgeBaseDefinition } from "./definition";
import { sourceFolderIds, webBoundaryOf } from "./source-urls";

export type SyncedSource = NonNullable<KnowledgeBaseDefinition["sources"]>[number];

export function withinSource(
  source: SyncedSource,
  item: { parents: readonly string[]; name: string; path: string }
): boolean {
  return (
    // Migration 5 leaves ancestry unknown until a listing learns it. A connector item
    // must have at least one parent (documentSourceItemSchema), so [] is unambiguous.
    (item.parents.length === 0 ||
      item.parents.some((parent) => sourceFolderIds(source).includes(parent))) &&
    // A web source's `include` is read on the address's path, as `exclude` reads a path; a
    // folder source's on the name.
    (!source.include ||
      (source.folders
        ? documentNameMatches(source.include, item.name)
        : documentPathMatches(source.include, item.path))) &&
    !(source.exclude && documentPathMatches(source.exclude, item.path))
  );
}

/**
 * Whether the source's `exclude` leaves out everything below a folder, by the folder's path in
 * the form of an item's: what a listing need not walk (`DocumentSourceListInput.excludesFolder`).
 * A folder is left out when a pattern ending in `**` names it or a folder above it.
 */
export function sourceExcludesFolder(
  source: SyncedSource
): ((path: string) => boolean) | undefined {
  const exclude = source.exclude;
  if (!exclude) return undefined;
  return (path) => documentFolderMatches(exclude, path);
}

/** Schedules do not change which documents the source covers. */
export function sourceBoundaryKey(source: SyncedSource): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.connection,
        [...sourceFolderIds(source)].sort(),
        source.include,
        source.exclude,
        // A folder source's key stays what it was; a web source's names its kinds and depth.
        ...(source.folders ? [] : [webBoundaryOf(source)])
      ])
    )
    .digest("hex");
}
