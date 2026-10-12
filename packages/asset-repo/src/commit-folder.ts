import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Repository } from "./git";
import {
  ASSET_REPO_DRAFT_REF,
  ASSET_REPO_LFS_POINTER_MAX_BYTES,
  ASSET_REPO_LFS_POINTER_START,
  ASSET_REPO_MAX_FILES
} from "./limits";
import { applyBundles, Refused } from "./materialise";
import type { CommitFolderRequest, CommitFolderResult } from "./request";
import { treeRefusal, type TreeEntry } from "./tree-check";

// One commit from a folder of plain files. The folder is read as files and nothing else: git
// is never started inside it, so a `.git` directory, a `.gitignore` or a `.gitattributes` in
// it configures nothing. The tree is made from the bytes of each file, hashed without a
// filter, and written into the index entry by entry. `git add` would apply the ignore rules of
// the folder and leave out a file without a word.

/** The mode every file is committed with. The executable bit of a mounted folder says nothing. */
const FILE_MODE = "100644";
/** The address form of an author. The id is opaque, so removing a person rewrites nothing. */
const AUTHOR_ADDRESS_HOST = "users.catalyst.invalid";
const COMMITTER = { name: "catalyst", email: "platform@catalyst.invalid" };
/**
 * A walk that found more names than this stops and the folder is refused: directories hold no
 * bytes, so the cap on files alone would let a folder make the command walk any number of them.
 */
const FOLDER_MAX_ENTRIES = 4 * ASSET_REPO_MAX_FILES;

/** Every entry of a folder, at every depth, as a tree would name it. Follows no link. */
async function walkFolder(folder: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const names = await readdir(directory, { withFileTypes: true });
    for (const entry of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = `${prefix}${entry.name}`;
      if (entries.length >= FOLDER_MAX_ENTRIES) {
        throw new Refused(
          "too_many_files",
          `The folder holds more than ${FOLDER_MAX_ENTRIES} files and directories`,
          path
        );
      }
      if (entry.isSymbolicLink()) {
        entries.push({ mode: "120000", path });
      } else if (entry.isDirectory()) {
        entries.push({ mode: "40000", path });
        // What a repository inside the folder holds is nothing to read: the folder is refused
        // for it below, by its name.
        if (entry.name.toLowerCase() !== ".git") {
          await walk(join(directory, entry.name), `${path}/`);
        }
      } else if (entry.isFile()) {
        entries.push({
          mode: FILE_MODE,
          path,
          size: (await lstat(join(directory, entry.name))).size
        });
      } else {
        entries.push({ mode: "0", path });
      }
    }
  };
  await walk(folder, "");
  return entries;
}

async function isLfsPointer(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(ASSET_REPO_LFS_POINTER_START.length);
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytesRead).toString("latin1") === ASSET_REPO_LFS_POINTER_START;
  } finally {
    await file.close();
  }
}

interface LsTreeEntry extends TreeEntry {
  type: string;
}

/** Every entry of the tree of a commit, at every depth. */
async function readTree(repository: Repository, commit: string): Promise<LsTreeEntry[]> {
  const listing = await repository.git(["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", commit]);
  return listing
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", , size = "-"] = line.slice(0, tab).split(/ +/u);
      return {
        mode: mode.replace(/^0+/u, ""),
        type,
        path: line.slice(tab + 1),
        ...(size === "-" ? {} : { size: Number(size) })
      };
    });
}

export interface CommitFolderInput {
  repository: Repository;
  request: CommitFolderRequest;
  /** The folder to commit. Read, never entered. */
  folder: string;
  /** Where the bundles of the request are. */
  bundles: string;
  /** Where the bundle of the new commit is written. */
  output: string;
}

/**
 * Commits the folder on the base the request names and writes the bundle that holds the new
 * commit. Rejects with `Refused` for a bundle or a folder the store does not take.
 */
export async function commitFolder(input: CommitFolderInput): Promise<CommitFolderResult> {
  const { repository, request, folder } = input;
  await applyBundles(repository, input.bundles, request.bundles);
  if (
    request.base !== null &&
    !(await repository.succeeds(["cat-file", "-e", `${request.base}^{commit}`]))
  ) {
    throw new Refused(
      "commit_missing",
      `The commit ${request.base} the folder was written from is in no bundle of this repository`
    );
  }

  const entries = await walkFolder(folder);
  const refused = treeRefusal(entries);
  if (refused) {
    throw new Refused(refused.code, refused.message, refused.path);
  }
  const files = entries.filter((entry) => entry.mode === FILE_MODE);
  for (const file of files) {
    if (
      (file.size ?? 0) < ASSET_REPO_LFS_POINTER_MAX_BYTES &&
      (await isLfsPointer(join(folder, file.path)))
    ) {
      throw new Refused(
        "lfs_pointer",
        `'${file.path}' is a Git LFS pointer. A repository holds the file itself, or a reference to a managed file.`,
        file.path
      );
    }
  }

  // The bytes as they are: no ignore rule, no attribute, no filter. Git runs in its own
  // repository and is handed each file by its full path.
  const ids = (
    await repository.git(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      input: files.map((file) => `${join(folder, file.path)}\n`).join("")
    })
  )
    .split("\n")
    .filter((line) => line !== "");
  if (ids.length !== files.length) {
    throw new Error("git hashed another number of files than the folder holds");
  }
  await repository.git(["read-tree", "--empty"]);
  await repository.git(["update-index", "-z", "--index-info"], {
    input: files.map((file, index) => `${FILE_MODE} ${ids[index]}\t${file.path}\0`).join("")
  });
  const tree = (await repository.git(["write-tree"])).trim();

  // Author, committer and both times come from the ledger, so repeating a save gives the same
  // commit id.
  const when = `@${request.time} +0000`;
  const commit = (
    await repository.git(
      ["commit-tree", tree, ...(request.base ? ["-p", request.base] : []), "-m", request.message],
      {
        env: {
          GIT_AUTHOR_NAME: request.author,
          GIT_AUTHOR_EMAIL: `${request.author}@${AUTHOR_ADDRESS_HOST}`,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_NAME: COMMITTER.name,
          GIT_COMMITTER_EMAIL: COMMITTER.email,
          GIT_COMMITTER_DATE: when
        }
      }
    )
  ).trim();

  // The tree as git wrote it is what the store relies on, so it is checked again as such: a
  // path the index left out or folded shows here, as a tree with fewer files.
  const written = await readTree(repository, commit);
  const stored = treeRefusal(written);
  if (stored) {
    throw new Refused(stored.code, stored.message, stored.path);
  }
  if (written.filter((entry) => entry.type === "blob").length !== files.length) {
    throw new Error("The commit holds another number of files than the folder");
  }

  await repository.git(["update-ref", ASSET_REPO_DRAFT_REF, commit]);
  const file = `${commit}.bundle`;
  await repository.git([
    "bundle",
    "create",
    "--quiet",
    "--version=2",
    join(input.output, file),
    request.base ? `${request.base}..${ASSET_REPO_DRAFT_REF}` : ASSET_REPO_DRAFT_REF
  ]);
  return {
    status: "committed",
    commit,
    tree,
    parent: request.base,
    files: files.length,
    bundle: {
      file,
      kind: request.base ? "incremental" : "full",
      prerequisite: request.base
    }
  };
}
