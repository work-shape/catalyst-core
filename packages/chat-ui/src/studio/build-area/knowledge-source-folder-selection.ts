// What the folder chooser of a synced source holds (KB-FOLDERS-1): the folders chosen, the
// boundary, by their ids, and the folders below them that are left out. A folder left out is an
// `exclude` pattern of the source that names exactly it, `Archive/**`: the sync reads the pattern
// on the path below a chosen folder, so a folder left out is left out below every chosen folder
// that holds one of that path. Every other pattern of `exclude` stays as it was typed.
//
// Which rules are the chooser's: those it wrote while it is open. A rule it found may be typed by
// hand and cannot be told from one it wrote earlier, so it goes only when the person ticks
// exactly its folder. Keeping one leaves a folder out; dropping one could read a folder someone
// kept out. Folder names are compared without case, as Dropbox treats them; the sync compares a
// pattern as written, so a new rule is written in the case the source lists the folder.

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
  /** The rules this chooser wrote, by their folded text: the chosen folders they lie below. */
  owned?: ReadonlyMap<string, ReadonlySet<string>>;
  /** The names directly in a chosen folder once read, folded to as listed; `complete` if all. */
  listed?: ReadonlyMap<string, { names: ReadonlyMap<string, string>; complete: boolean }>;
  /** Chosen folders whose read failed: their path will not come. */
  unread?: ReadonlySet<string>;
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

/** A name or a path as folders are told apart: the same whatever its case or composition. */
const fold = (text: string) => text.normalize("NFC").toLowerCase();

function patternLines(text: string): string[] {
  return text
    .split("\n")
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== "");
}

/** The folders a source's `exclude` leaves out by name, in order, each once whatever its case. */
export function excludedFolders(exclude: string): string[] {
  const seen = new Set<string>();
  return patternLines(exclude).flatMap((pattern) => {
    const folder = folderOfPattern(pattern);
    if (folder === undefined || seen.has(fold(folder))) return [];
    seen.add(fold(folder));
    return [folder];
  });
}

/** `exclude` with exactly `folders` left out by name; every other pattern stays where it is. */
export function withExcludedFolders(exclude: string, folders: readonly string[]): string {
  const wanted = new Set(folders.map(fold));
  const present = new Set<string>();
  const lines = patternLines(exclude).filter((pattern) => {
    const folder = folderOfPattern(pattern);
    if (folder === undefined) return true;
    if (!wanted.has(fold(folder))) return false;
    present.add(fold(folder));
    return true;
  });
  return [
    ...lines,
    ...folders.filter((folder) => !present.has(fold(folder))).map((folder) => `${folder}/**`)
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
  prefix.length <= path.length &&
  prefix.every((name, index) => fold(path[index] ?? "") === fold(name));
const below = (rule: string, folder: string) =>
  folder === "" || fold(rule).startsWith(`${fold(folder)}/`);

/**
 * Whether a rule falls under a chosen folder: it was written there, or the folder holds the
 * rule's first name. Undefined while what the folder holds is not known.
 */
function ruleUnder(selection: FolderSelection, id: string, rule: string): boolean | undefined {
  const key = fold(rule);
  const owners = selection.owned?.get(key);
  if (owners?.has(id)) return true;
  const [first = key, ...rest] = key.split("/");
  // A longer rule written below another folder: a like first name here does not place it.
  if (owners !== undefined && rest.length > 0) return undefined;
  const listed = selection.listed?.get(id);
  if (listed === undefined) return undefined;
  if (listed.names.has(first)) return true;
  return listed.complete ? false : undefined;
}

/**
 * The rules once chosen folders go. A rule only they held goes with them, unless a folder that
 * stays is known to hold its path: the pattern leaves that one out too, and the chooser said so.
 */
function released(
  selection: FolderSelection,
  ids: ReadonlySet<string>
): { excluded: string[]; owned: Map<string, ReadonlySet<string>> } {
  const staying = [...selection.chosen.keys()].filter((id) => !ids.has(id));
  const owned = new Map(selection.owned);
  const excluded = selection.excluded.filter((rule) => {
    const key = fold(rule);
    const owners = owned.get(key);
    if (owners === undefined) return true;
    const left = [...owners].filter((id) => !ids.has(id));
    const holders =
      left.length > 0 ? left : staying.filter((id) => ruleUnder(selection, id, rule) === true);
    if (holders.length === 0) {
      owned.delete(key);
      return false;
    }
    owned.set(key, new Set(holders));
    return true;
  });
  return { excluded, owned };
}

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
    if (selection.excluded.some((rule) => fold(rule) === fold(relative))) {
      return { state: "out", under };
    }
    const withAbove = selection.excluded.find((rule) => below(relative, rule));
    if (withAbove !== undefined) {
      return { state: "outAbove", with: withAbove.split("/").at(-1) ?? withAbove };
    }
    const depth = relative.split("/").length;
    return {
      state: "in",
      under,
      without: selection.excluded
        .filter((rule) => below(rule, relative))
        .map((rule) => rule.split("/").slice(depth).join("/"))
    };
  }
  if (own) {
    return {
      state: "in",
      without: selection.excluded.filter((rule) => ruleUnder(selection, folder.id, rule) === true)
    };
  }
  let count = 0;
  for (const [id, chosenPath] of selection.chosen) {
    if (id === folder.id || chosenPath === undefined) continue;
    const inner = normal(chosenPath);
    if (inner.length > path.length && startsWith(inner, path)) count += 1;
  }
  return { state: "none", below: count };
}

/**
 * The selection once a folder above chosen ones is ticked: they go, and what was left out below
 * them is written again from the new folder, so it stays out. Undefined where a pattern cannot
 * write that path.
 */
function chooseAbove(
  selection: FolderSelection,
  folder: PlacedFolder
): FolderSelection | undefined {
  // A chosen folder still being placed may lie below this one, with rules to write again.
  const placing = [...selection.chosen].some(
    ([id, chosenPath]) => chosenPath === undefined && !selection.unread?.has(id)
  );
  if (placing && selection.excluded.length > 0) return undefined;
  const path = normal(folder.path);
  const chosen = new Map(selection.chosen);
  const dropped = new Set<string>();
  const moved: string[] = [];
  const rewritten = new Set<string>();
  for (const [id, chosenPath] of selection.chosen) {
    if (chosenPath === undefined) continue;
    const inner = normal(chosenPath);
    if (inner.length <= path.length || !startsWith(inner, path)) continue;
    chosen.delete(id);
    dropped.add(id);
    for (const rule of selection.excluded) {
      if (ruleUnder(selection, id, rule) === false) continue;
      const segments = [...inner.slice(path.length), ...rule.split("/")];
      if (!canLeaveOut(segments)) return undefined;
      moved.push(segments.join("/"));
      rewritten.add(fold(rule));
    }
  }
  const staying = [...chosen.keys()];
  chosen.set(folder.id, folder.path);
  const { excluded: kept, owned } = released(selection, dropped);
  // A rule written again goes in its old form, which would name another folder from up here,
  // unless a folder that stays may still hold it.
  const excluded = kept.filter((rule) => {
    if (!rewritten.has(fold(rule))) return true;
    if (staying.some((id) => ruleUnder(selection, id, rule) !== false)) return true;
    owned.delete(fold(rule));
    return false;
  });
  for (const rule of moved) {
    if (excluded.some((other) => fold(other) === fold(rule) || below(rule, other))) continue;
    excluded.push(rule);
    owned.set(fold(rule), new Set([folder.id]));
  }
  return { ...selection, chosen, excluded, owned };
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
  const base = above?.id ?? folder.id;
  // The rules a tick on this folder may clear: those the chooser wrote below it.
  const ownBelow = (rule: string) =>
    selection.owned?.get(fold(rule))?.has(base) === true && below(rule, relative);
  if (on) {
    if (state.state === "outAbove") return selection;
    if (state.state === "none") return chooseAbove(selection, folder) ?? selection;
    if (state.state === "in" && state.without.length === 0) return selection;
    const excluded = selection.excluded.filter(
      (rule) => (relative === "" || fold(rule) !== fold(relative)) && !ownBelow(rule)
    );
    if (excluded.length < selection.excluded.length) {
      const owned = new Map(selection.owned);
      for (const rule of selection.excluded) {
        if (!excluded.includes(rule)) owned.delete(fold(rule));
      }
      return { ...selection, excluded, owned };
    }
    // Only rules it did not write hold the box in part, so the click takes the folder out.
  }
  if (state.state !== "in") return selection;
  const chosen = new Map(selection.chosen);
  chosen.delete(folder.id);
  if (above === undefined) {
    return { ...selection, chosen, ...released(selection, new Set([folder.id])) };
  }
  if (!canLeaveOut(path.slice(above.path.length))) return { ...selection, chosen };
  const owned = new Map(selection.owned);
  const excluded = selection.excluded.filter((rule) => {
    if (!ownBelow(rule)) return true;
    owned.delete(fold(rule));
    return false;
  });
  owned.set(fold(relative), new Set([above.id]));
  return { ...selection, chosen, excluded: [...excluded, relative], owned };
}

/** Whether the folder's box can change: what a click would do can be said by the source. */
export function canToggle(selection: FolderSelection, folder: PlacedFolder): boolean {
  const state = folderState(selection, folder);
  if (state.state === "outAbove") return false;
  if (state.state === "none") return chooseAbove(selection, folder) !== undefined;
  if (state.state === "out") return true;
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
  return { ...selection, chosen };
}

/** The selection knowing which folders lie directly in a chosen one. */
export function withFolderNames(
  selection: FolderSelection,
  id: string,
  names: readonly string[],
  complete: boolean
): FolderSelection {
  const folded = new Map(names.map((name) => [fold(name), name.normalize("NFC")]));
  const known = selection.listed?.get(id);
  if (
    known?.complete === complete &&
    known.names.size === folded.size &&
    [...folded].every(([key, name]) => known.names.get(key) === name)
  ) {
    return selection;
  }
  const listed = new Map(selection.listed);
  listed.set(id, { names: folded, complete });
  return { ...selection, listed };
}

/** The selection knowing that a chosen folder's read failed. */
export function withFolderUnread(selection: FolderSelection, id: string): FolderSelection {
  if (selection.unread?.has(id)) return selection;
  return { ...selection, unread: new Set([...(selection.unread ?? []), id]) };
}

/**
 * The `exclude` a selection stores. The sync compares a pattern as written, so where a chosen
 * folder lists a left-out folder in another case, that spelling is written beside the rule.
 */
export function excludeToStore(exclude: string, selection: FolderSelection): string {
  const text = withExcludedFolders(exclude, selection.excluded);
  const written = new Set(patternLines(text).flatMap((line) => folderOfPattern(line) ?? []));
  const added: string[] = [];
  for (const rule of selection.excluded) {
    const [first = rule, ...rest] = rule.split("/");
    for (const id of selection.chosen.keys()) {
      const spelled = selection.listed?.get(id)?.names.get(fold(first));
      if (spelled === undefined) continue;
      const segments = [spelled, ...rest];
      const folder = segments.join("/");
      if (written.has(folder) || !canLeaveOut(segments)) continue;
      written.add(folder);
      added.push(`${folder}/**`);
    }
  }
  return [...(text === "" ? [] : [text]), ...added].join("\n");
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
