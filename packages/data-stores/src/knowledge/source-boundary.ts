import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import type { KnowledgeBaseDefinition } from "./definition";

export type SyncedSource = NonNullable<KnowledgeBaseDefinition["sources"]>[number];

/** A source's `exclude`, read once: a walk up a path answers for all its literal folders. */
interface CompiledExclude {
  folders: ReadonlySet<string>;
  globs: readonly string[];
}

/** Anything `matchesGlob` may read as more than its own characters. */
const GLOB_SYNTAX = /[*?[\]{}\\]|[!+@]\(/u;
/** An empty, `.` or `..` segment, which `matchesGlob` collapses before it compares. */
const UNPLAIN_PATH = /\/\/|\/$|(?:^|\/)\.\.?(?:\/|$)/u;

const compiledExcludes = new WeakMap<readonly string[], CompiledExclude>();

function compiledExclude(patterns: readonly string[]): CompiledExclude {
  const known = compiledExcludes.get(patterns);
  if (known) return known;
  const folders = new Set<string>();
  const globs: string[] = [];
  for (const pattern of patterns) {
    const folder = pattern.endsWith("/**") ? pattern.slice(0, -"/**".length) : "";
    if (folder !== "" && !GLOB_SYNTAX.test(folder) && !UNPLAIN_PATH.test(folder))
      folders.add(folder);
    else globs.push(pattern);
  }
  const compiled = { folders, globs };
  compiledExcludes.set(patterns, compiled);
  return compiled;
}

/**
 * What `<folder>/**` answers for a plain path: true below the folder, false for the folder
 * itself, and false once a segment below it starts with a dot, which `**` does not cross.
 */
function belowFolder(folders: ReadonlySet<string>, path: string): boolean {
  for (let slash = path.lastIndexOf("/"); slash > 0; slash = path.lastIndexOf("/", slash - 1)) {
    if (path[slash + 1] === ".") return false;
    if (folders.has(path.slice(0, slash))) return true;
  }
  return false;
}

function excluded(patterns: readonly string[], path: string): boolean {
  const { folders, globs } = compiledExclude(patterns);
  const bare = path.slice(1);
  const matches = (pattern: string) => matchesGlob(bare, pattern) || matchesGlob(path, pattern);
  if (UNPLAIN_PATH.test(bare) || UNPLAIN_PATH.test(path)) return patterns.some(matches);
  return belowFolder(folders, bare) || belowFolder(folders, path) || globs.some(matches);
}

export function withinSource(
  source: SyncedSource,
  item: { parents: readonly string[]; name: string; path: string }
): boolean {
  return (
    // Migration 5 leaves ancestry unknown until a listing learns it. A connector item
    // must have at least one parent (documentSourceItemSchema), so [] is unambiguous.
    (item.parents.length === 0 || item.parents.some((parent) => source.folders.includes(parent))) &&
    (!source.include || source.include.some((pattern) => matchesGlob(item.name, pattern))) &&
    !(source.exclude && excluded(source.exclude, item.path))
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
