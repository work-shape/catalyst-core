import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import type { KnowledgeBaseDefinition } from "./definition";

export type SyncedSource = NonNullable<KnowledgeBaseDefinition["sources"]>[number];

export function withinSource(
  source: SyncedSource,
  item: { parents: readonly string[]; name: string; path: string }
): boolean {
  return (
    // Migration 5 leaves ancestry unknown until a listing learns it. A connector item
    // must have at least one parent (documentSourceItemSchema), so [] is unambiguous.
    (item.parents.length === 0 || item.parents.some((parent) => source.folders.includes(parent))) &&
    (!source.include || source.include.some((pattern) => matchesGlob(item.name, pattern))) &&
    !source.exclude?.some(
      (pattern) => matchesGlob(item.path.slice(1), pattern) || matchesGlob(item.path, pattern)
    )
  );
}

/** Schedules do not change which documents the source covers. */
export function sourceBoundaryKey(source: SyncedSource): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.connection,
        [...source.folders].sort(),
        source.include,
        source.exclude
      ])
    )
    .digest("hex");
}
