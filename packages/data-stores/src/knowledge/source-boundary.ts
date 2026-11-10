import { createHash } from "node:crypto";
import type { KnowledgeBaseDefinition } from "./definition";
import { sourceFolderIds, webBoundaryOf } from "./source-urls";

export type SyncedSource = NonNullable<KnowledgeBaseDefinition["sources"]>[number];

// The pattern rule of `include` and `exclude` (spec: Synced sources, "The shape"). A pattern and
// a path are compared segment by segment, split at `/`. `**` as a whole segment stands for any
// number of segments, at the end of a pattern for at least one; `*` for any characters within a
// segment, `?` for one. Every other character stands for itself, brackets, braces, parentheses
// and a backslash included, so `Projekt [alt]/**` names that folder; `**` inside a name is `*`,
// and a literal `*` or `?` cannot be written. A dot is not special: `Old/**` holds
// `/Old/.git/config` as well. Case counts as written; patterns, paths and names are compared in
// Unicode NFC, so `Müller` matches however a source composes the umlaut. Empty and `.` segments
// are dropped, and `..` drops the segment before it, in a pattern and a path alike.

/** The segments of a path or a pattern, as the rule reads them. */
function segmentsOf(text: string): string[] {
  const segments: string[] = [];
  for (const segment of text.normalize("NFC").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
}

const isWild = (segment: string) => segment.includes("*") || segment.includes("?");

/** One segment as an expression. A `u` expression allows escapes of its syntax characters only. */
function segmentSource(segment: string): string {
  let source = "";
  for (const char of segment)
    source +=
      char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[\\^$.|?*+()[\]{}]/u, "\\$&");
  return source;
}

/** A pattern's segments as one expression over a joined path without a leading slash. */
function compiledPattern(segments: readonly string[]): RegExp {
  let source = "";
  let joined = false;
  segments.forEach((segment, index) => {
    const separator = index > 0 && joined ? "/" : "";
    if (segment === "**") {
      source +=
        index === segments.length - 1
          ? `${separator}[^/]+(?:/[^/]+)*`
          : `${index > 0 ? "/" : ""}(?:[^/]+/)*`;
      joined = false;
    } else {
      source += separator + segmentSource(segment);
      joined = true;
    }
  });
  return new RegExp(`^${source}$`, "u");
}

/** A list of patterns, read once: literal folders by a set, the rest by an expression each. */
interface CompiledPatterns {
  /** `<folder>/**` without a wildcard in the folder: the folder's joined segments. */
  folders: ReadonlySet<string>;
  globs: readonly RegExp[];
  /** Of each other pattern ending in `**`, the part before it: what a folder must match. */
  prefixes: readonly RegExp[];
}

const compiledLists = new WeakMap<readonly string[], CompiledPatterns>();

function compiled(patterns: readonly string[]): CompiledPatterns {
  const known = compiledLists.get(patterns);
  if (known) return known;
  const folders = new Set<string>();
  const globs: RegExp[] = [];
  const prefixes: RegExp[] = [];
  for (const pattern of patterns) {
    // Consecutive `**` say what one says.
    const segments = segmentsOf(pattern).filter(
      (segment, index, all) => !(segment === "**" && all[index - 1] === "**")
    );
    const folder = segments.at(-1) === "**" ? segments.slice(0, -1) : undefined;
    if (folder && !folder.some(isWild)) {
      folders.add(folder.join("/"));
      continue;
    }
    globs.push(compiledPattern(segments));
    if (folder) prefixes.push(compiledPattern(folder));
  }
  const result = { folders, globs, prefixes };
  compiledLists.set(patterns, result);
  return result;
}

/** The joined segments of each folder above a path, outermost first, from the top's `""`. */
function ancestorsOf(segments: readonly string[]): string[] {
  const ancestors = [""];
  for (let end = 1; end < segments.length; end++) ancestors.push(segments.slice(0, end).join("/"));
  return ancestors;
}

function excluded(patterns: readonly string[], path: string): boolean {
  const { folders, globs } = compiled(patterns);
  const segments = segmentsOf(path);
  if (!segments.length) return false;
  if (folders.size && ancestorsOf(segments).some((folder) => folders.has(folder))) return true;
  const joined = segments.join("/");
  return globs.some((glob) => glob.test(joined));
}

/**
 * Whether a file's name matches `include`. A name is one segment, so of the literal folder
 * patterns only `**` holds it.
 */
function included(patterns: readonly string[], name: string): boolean {
  const { folders, globs } = compiled(patterns);
  const normal = name.normalize("NFC");
  return folders.has("") || globs.some((glob) => glob.test(normal));
}

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
        ? included(source.include, item.name)
        : excluded(source.include, item.path))) &&
    !(source.exclude && excluded(source.exclude, item.path))
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
  return (path) => {
    const { folders, prefixes } = compiled(exclude);
    const segments = segmentsOf(path);
    const chain = [...ancestorsOf(segments), ...(segments.length ? [segments.join("/")] : [])];
    // The top is no segment: only the literal `/**` names it.
    return chain.some(
      (folder) =>
        folders.has(folder) || (folder !== "" && prefixes.some((prefix) => prefix.test(folder)))
    );
  };
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
