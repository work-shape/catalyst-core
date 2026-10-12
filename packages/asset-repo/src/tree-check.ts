import {
  ASSET_REPO_MAX_FILE_BYTES,
  ASSET_REPO_MAX_FILES,
  ASSET_REPO_MAX_PATH_BYTES,
  ASSET_REPO_MAX_TREE_BYTES
} from "./limits";

// The trees the platform accepts. One list for a folder before it is committed and for a
// commit after it was written: the first names the file to its author before anything is
// hashed, the second is what the store relies on.

/** Why a tree is refused, with the path that is the reason. */
export interface TreeRefusal {
  code:
    | "symbolic_link"
    | "submodule"
    | "not_a_regular_file"
    | "path_refused"
    | "case_collision"
    | "path_too_long"
    | "file_too_large"
    | "lfs_pointer"
    | "too_many_files"
    | "tree_too_large";
  path: string;
  message: string;
}

/** One entry of a tree, as `git ls-tree -r -t -l` or a walk of a folder names it. */
export interface TreeEntry {
  /** The octal mode of git: `100644`, `100755`, `120000`, `160000` or `40000`. */
  mode: string;
  path: string;
  /** The bytes of a file. Absent for a directory. */
  size?: number;
}

export interface TreeLimits {
  maxFileBytes: number;
  maxFiles: number;
  maxPathBytes: number;
  maxTreeBytes: number;
}

const DEFAULT_TREE_LIMITS: TreeLimits = {
  maxFileBytes: ASSET_REPO_MAX_FILE_BYTES,
  maxFiles: ASSET_REPO_MAX_FILES,
  maxPathBytes: ASSET_REPO_MAX_PATH_BYTES,
  maxTreeBytes: ASSET_REPO_MAX_TREE_BYTES
};

// Names git or a file system reads as something else than a file of the author: the
// repository itself and its 8.3 short name, the files that configure submodules and filters,
// and what NTFS and HFS+ fold onto them.
const REFUSED_SEGMENT = /^(?:\.git|\.gitmodules|\.gitattributes|\.\.|\.|git~\d+)$/iu;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/** The reason a path cannot be in a tree, or nothing when it can. */
export function pathRefusal(path: string, limits: TreeLimits = DEFAULT_TREE_LIMITS) {
  const refuse = (code: TreeRefusal["code"], message: string): TreeRefusal => ({
    code,
    path,
    message
  });
  if (Buffer.byteLength(path, "utf8") > limits.maxPathBytes) {
    return refuse(
      "path_too_long",
      `A path is longer than ${limits.maxPathBytes} bytes (ASSET_REPO_MAX_PATH_BYTES): '${path.slice(0, 80)}…'`
    );
  }
  if (path.startsWith("/") || CONTROL_CHARACTER.test(path) || path.includes("\\")) {
    return refuse(
      "path_refused",
      `The path '${printable(path)}' is absolute or holds a backslash or a control character`
    );
  }
  for (const segment of path.split("/")) {
    if (
      segment === "" ||
      REFUSED_SEGMENT.test(segment) ||
      segment.includes(":") ||
      /[. ]$/u.test(segment)
    ) {
      return refuse(
        "path_refused",
        `The path '${path}' holds the component '${segment}', which a repository does not take`
      );
    }
  }
  return undefined;
}

/**
 * The first reason to refuse a tree, or nothing. `entries` holds every entry of the tree, at
 * every depth, directories included.
 */
export function treeRefusal(
  entries: Iterable<TreeEntry>,
  limits: TreeLimits = DEFAULT_TREE_LIMITS
): TreeRefusal | undefined {
  const seen = new Set<string>();
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const { path, mode } = entry;
    const invalid = pathRefusal(path, limits);
    if (invalid) {
      return invalid;
    }
    if (mode === "120000") {
      return { code: "symbolic_link", path, message: `'${path}' is a symbolic link` };
    }
    if (mode === "160000") {
      return { code: "submodule", path, message: `'${path}' is a submodule entry` };
    }
    const folded = path.normalize("NFC").toLowerCase();
    if (seen.has(folded)) {
      return {
        code: "case_collision",
        path,
        message: `'${path}' differs from another path only in case`
      };
    }
    seen.add(folded);
    if (mode === "40000" || mode === "040000") {
      continue;
    }
    if (mode !== "100644" && mode !== "100755") {
      return { code: "not_a_regular_file", path, message: `'${path}' is not a regular file` };
    }
    files += 1;
    if (files > limits.maxFiles) {
      return {
        code: "too_many_files",
        path,
        message: `The tree holds more than ${limits.maxFiles} files (ASSET_REPO_MAX_FILES)`
      };
    }
    if (entry.size !== undefined && entry.size > limits.maxFileBytes) {
      return {
        code: "file_too_large",
        path,
        message: `'${path}' has ${entry.size} bytes. A file has at most ${limits.maxFileBytes} (ASSET_REPO_MAX_FILE_BYTES).`
      };
    }
    bytes += entry.size ?? 0;
    if (bytes > limits.maxTreeBytes) {
      return {
        code: "tree_too_large",
        path,
        message: `The files of the tree have more than ${limits.maxTreeBytes} bytes together (ASSET_REPO_MAX_TREE_BYTES). '${path}' is the first past it.`
      };
    }
  }
  return undefined;
}

function printable(path: string): string {
  return path.replace(/[\u0000-\u001f\u007f]/gu, "?");
}
