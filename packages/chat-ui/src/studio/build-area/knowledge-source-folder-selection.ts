// What the folder chooser of a synced source holds (KB-FOLDERS-1): the folders chosen, the
// boundary, by their ids, and the folders below them that are left out. A folder left out is an
// `exclude` pattern of the source that names exactly it, `Archive/**`: the sync reads the pattern
// on the path below a chosen folder, so a folder left out is left out below every chosen folder
// that holds one of that path. Every other pattern of `exclude` stays as it was typed.

/** The longest pattern the definition takes. */
const PATTERN_MAX_CHARS = 500;

/** One folder as the chooser places it: its id and the names on its way from the top. */
export interface PlacedFolder {
  id: string;
  /** The folder names from the top down to the folder itself; empty for the top. */
  path: readonly string[];
}

export interface FolderSelection {
  /** The chosen folders by id, each with its path once that is read. */
  chosen: ReadonlyMap<string, readonly string[] | undefined>;
  /** The folders left out, each by its path below a chosen folder: `Archive`, `2019/Old`. */
  excluded: readonly string[];
}

/** How one folder stands in a selection. */
export type FolderState =
  /** Read with everything below it but `without`: chosen itself, or below the chosen `under`. */
  | { state: "in"; under?: string; without: readonly string[] }
  /** Left out by a pattern of its own, below the chosen `under`. */
  | { state: "out"; under: string }
  /** Left out with the folder `with` above it. */
  | { state: "outAbove"; with: string }
  /** Not read; `below` chosen folders lie under it. */
  | { state: "none"; below: number };

/** The segments of a path or a pattern as the sync's rule reads them. */
export function folderPathSegments(path: string): string[] {
  const segments: string[] = [];
  for (const segment of path.normalize("NFC").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return segments;
}

const isWild = (segment: string) => segment.includes("*") || segment.includes("?");

/** The folder a pattern leaves out with everything below it, where it names exactly one. */
function folderOfPattern(pattern: string): string | undefined {
  const segments = folderPathSegments(pattern);
  if (segments.at(-1) !== "**") return undefined;
  const folder = segments.filter((segment) => segment !== "**");
  // `**` anywhere before the end, or a wildcard in a name, names more than one folder.
  if (folder.length === 0 || folder.some(isWild)) return undefined;
  if (segments.slice(0, folder.length).includes("**")) return undefined;
  return folder.join("/");
}

function patternLines(text: string): string[] {
  return text
    .split("\n")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
}

/** The folders a source's `exclude` leaves out by name, in order, each once. */
export function excludedFolders(exclude: string): string[] {
  return [
    ...new Set(
      patternLines(exclude).flatMap((pattern) => {
        const folder = folderOfPattern(pattern);
        return folder === undefined ? [] : [folder];
      })
    )
  ];
}

/** `exclude` with exactly `folders` left out by name; its other patterns stay where they are. */
export function withExcludedFolders(exclude: string, folders: readonly string[]): string {
  const wanted = new Set(folders);
  const kept = new Set<string>();
  const lines = patternLines(exclude).filter((pattern) => {
    const folder = folderOfPattern(pattern);
    if (folder === undefined) return true;
    if (!wanted.has(folder) || kept.has(folder)) return false;
    kept.add(folder);
    return true;
  });
  return [
    ...lines,
    ...folders.filter((folder) => !kept.has(folder)).map((folder) => `${folder}/**`)
  ].join("\n");
}

/**
 * Whether a folder below a chosen one can be left out: a pattern cannot write a literal `*` or
 * `?`, nor a name the rule drops, and it has a longest length.
 */
function canLeaveOut(relative: readonly string[]): boolean {
  return (
    relative.length > 0 &&
    relative.every(
      (name) =>
        !isWild(name) &&
        !name.includes("/") &&
        !name.includes("\n") &&
        name === name.trim() &&
        name !== "." &&
        name !== ".."
    ) &&
    `${relative.join("/")}/**`.length <= PATTERN_MAX_CHARS
  );
}

const normal = (path: readonly string[]) => path.map((name) => name.normalize("NFC"));
const startsWith = (path: readonly string[], prefix: readonly string[]) =>
  prefix.length <= path.length && prefix.every((name, index) => path[index] === name);
const below = (rule: string, folder: string) => folder === "" || rule.startsWith(`${folder}/`);

/** The chosen folder furthest up that `folder` lies below, where one does. */
function chosenAbove(
  selection: FolderSelection,
  folder: PlacedFolder
): { id: string; path: readonly string[] } | undefined {
  const path = normal(folder.path);
  let found: { id: string; path: readonly string[] } | undefined;
  for (const [id, chosenPath] of selection.chosen) {
    if (id === folder.id || chosenPath === undefined) continue;
    const above = normal(chosenPath);
    if (above.length < path.length && startsWith(path, above)) {
      if (found === undefined || above.length < found.path.length) found = { id, path: above };
    }
  }
  return found;
}

const lastName = (path: readonly string[], fallback: string) => path.at(-1) ?? fallback;

export function folderState(selection: FolderSelection, folder: PlacedFolder): FolderState {
  const path = normal(folder.path);
  const own = selection.chosen.has(folder.id);
  const above = chosenAbove(selection, folder);
  if (above !== undefined && !own) {
    const relative = path.slice(above.path.length).join("/");
    const under = lastName(above.path, above.id);
    if (selection.excluded.includes(relative)) return { state: "out", under };
    const withAbove = selection.excluded.find((rule) => relative.startsWith(`${rule}/`));
    if (withAbove !== undefined) {
      return { state: "outAbove", with: withAbove.split("/").at(-1) ?? withAbove };
    }
    return {
      state: "in",
      under,
      without: selection.excluded
        .filter((rule) => below(rule, relative))
        .map((rule) => rule.slice(relative.length + 1))
    };
  }
  if (own) return { state: "in", without: selection.excluded };
  let count = 0;
  for (const [id, chosenPath] of selection.chosen) {
    if (id === folder.id || chosenPath === undefined) continue;
    const inner = normal(chosenPath);
    if (inner.length > path.length && startsWith(inner, path)) count += 1;
  }
  return { state: "none", below: count };
}

/** The selection once `folder` is ticked or unticked. */
export function toggleFolder(
  selection: FolderSelection,
  folder: PlacedFolder,
  on: boolean
): FolderSelection {
  const state = folderState(selection, folder);
  const path = normal(folder.path);
  const above = chosenAbove(selection, folder);
  const relative = above === undefined ? "" : path.slice(above.path.length).join("/");
  const chosen = new Map(selection.chosen);
  if (on) {
    if (state.state === "outAbove") return selection;
    if (state.state === "none") {
      // What lies below it is read with it now.
      for (const [id, chosenPath] of chosen) {
        if (chosenPath === undefined) continue;
        const inner = normal(chosenPath);
        if (inner.length > path.length && startsWith(inner, path)) chosen.delete(id);
      }
      chosen.set(folder.id, folder.path);
      return { chosen, excluded: selection.excluded };
    }
    // Read whole again: its own pattern goes, and each below it.
    return {
      chosen,
      excluded: selection.excluded.filter((rule) => rule !== relative && !below(rule, relative))
    };
  }
  if (state.state !== "in") return selection;
  chosen.delete(folder.id);
  if (above === undefined) {
    // Nothing chosen is left for the folders left out to lie below.
    return { chosen, excluded: chosen.size === 0 ? [] : selection.excluded };
  }
  if (!canLeaveOut(path.slice(above.path.length))) return { chosen, excluded: selection.excluded };
  return {
    chosen,
    excluded: [...selection.excluded.filter((rule) => !below(rule, relative)), relative]
  };
}

/** Whether unticking `folder` can be said by the source: a chosen one always, one below by a pattern. */
export function canUntick(selection: FolderSelection, folder: PlacedFolder): boolean {
  const above = chosenAbove(selection, folder);
  return above === undefined || canLeaveOut(normal(folder.path).slice(above.path.length));
}

/** The selection with the path of a chosen folder, once the source has answered it. */
export function withFolderPath(
  selection: FolderSelection,
  id: string,
  path: readonly string[]
): FolderSelection {
  if (!selection.chosen.has(id) || selection.chosen.get(id) !== undefined) return selection;
  const chosen = new Map(selection.chosen);
  chosen.set(id, path);
  return { chosen, excluded: selection.excluded };
}

/** What a selection reads as: the chosen folders by name, and the folders left out below them. */
export function selectionSummary(selection: FolderSelection): {
  folders: string[];
  excluded: string[];
} {
  return {
    folders: [...selection.chosen].map(([id, path]) => (path ? lastName(path, "/") : id)),
    excluded: [...selection.excluded]
  };
}
