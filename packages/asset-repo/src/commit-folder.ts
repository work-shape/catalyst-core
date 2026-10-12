import type { Dirent } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Repository } from "./git";
import {
  ASSET_REPO_DRAFT_REF,
  ASSET_REPO_LFS_POINTER_MAX_BYTES,
  ASSET_REPO_LFS_POINTER_START,
  ASSET_REPO_MAX_BUNDLE_BYTES,
  ASSET_REPO_MAX_FILE_BYTES,
  ASSET_REPO_MAX_FILES,
  ASSET_REPO_MAX_TREE_BYTES
} from "./limits";
import {
  applyBundles,
  copyBounded,
  openRegularFile,
  Refused,
  type BoundedCopy
} from "./materialise";
import type { CommitFolderRequest, CommitFolderResult } from "./request";
import { pathRefusal, treeRefusal, type TreeEntry } from "./tree-check";

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

/** One file of the folder, as it was read: its path in the tree and the copy of its bytes. */
interface SnapshotFile extends TreeEntry {
  copy: string;
}

/**
 * Reads a folder once: every entry of it, at every depth, as a tree would name it, and the
 * bytes of every file as a copy below `snapshot`, which this command made. Each file is opened
 * once, by a name that is no link, and what is committed later is that copy, so a file that is
 * exchanged after it was read changes nothing. A directory is entered only where its path
 * holds no link, and no more names are read of the folder than a walk takes.
 */
async function snapshotFolder(
  folder: string,
  snapshot: string
): Promise<{ entries: TreeEntry[]; files: SnapshotFile[] }> {
  const root = await lstat(folder).catch(() => undefined);
  if (!root?.isDirectory()) {
    throw new Refused("folder_invalid", "The folder to commit is not a directory");
  }
  const entries: TreeEntry[] = [];
  const files: SnapshotFile[] = [];
  let names = 0;
  let bytes = 0;
  const walk = async (directory: string, prefix: string): Promise<void> => {
    // The directory as it is reached must be the directory itself: a link anywhere in its
    // path would lead the walk out of the folder.
    if ((await realpath(directory).catch(() => undefined)) !== directory) {
      throw new Refused(
        "symbolic_link",
        `'${prefix.slice(0, -1)}' is reached through a symbolic link`,
        prefix.slice(0, -1)
      );
    }
    const found: Dirent[] = [];
    for await (const entry of await opendir(directory)) {
      names += 1;
      // Counted while the names are read, so a directory of any size is left after this many.
      if (names > FOLDER_MAX_ENTRIES) {
        throw new Refused(
          "too_many_files",
          `The folder holds more than ${FOLDER_MAX_ENTRIES} files and directories`,
          `${prefix}${entry.name}`
        );
      }
      found.push(entry);
    }
    for (const entry of found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const path = `${prefix}${entry.name}`;
      // A name the store does not take is refused before anything below it is read.
      const refused = pathRefusal(path);
      if (refused) {
        throw new Refused(refused.code, refused.message, refused.path);
      }
      if (entry.isSymbolicLink()) {
        entries.push({ mode: "120000", path });
      } else if (entry.isDirectory()) {
        entries.push({ mode: "40000", path });
        await walk(join(directory, entry.name), `${path}/`);
      } else if (entry.isFile()) {
        const source = await openRegularFile(join(directory, entry.name));
        if (!source) {
          // It was a file when the directory was read and is none now.
          entries.push({ mode: "0", path });
          continue;
        }
        const copy = join(snapshot, String(files.length));
        try {
          const copied = await copyBounded(source, copy, ASSET_REPO_MAX_FILE_BYTES);
          const file = { mode: FILE_MODE, path, size: copied.bytes, copy };
          entries.push(file);
          files.push(file);
          bytes += copied.bytes;
        } finally {
          await source.close();
        }
        // Nothing is copied past what a tree may weigh.
        if (bytes > ASSET_REPO_MAX_TREE_BYTES) {
          throw new Refused(
            "tree_too_large",
            `The files of the folder have more than ${ASSET_REPO_MAX_TREE_BYTES} bytes together (ASSET_REPO_MAX_TREE_BYTES). '${path}' is the first past it.`,
            path
          );
        }
      } else {
        entries.push({ mode: "0", path });
      }
    }
  };
  await mkdir(snapshot, { mode: 0o700 });
  await walk(await realpath(folder), "");
  return { entries, files };
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
  /** A directory this command made, for the copies it reads from. */
  scratch: string;
}

/**
 * Commits the folder on the base the request names and writes the bundle that holds the new
 * commit. Rejects with `Refused` for a bundle or a folder the store does not take.
 */
export async function commitFolder(input: CommitFolderInput): Promise<CommitFolderResult> {
  const { repository, request, folder } = input;
  await applyBundles(repository, input.bundles, request.bundles, input.scratch);
  if (
    request.base !== null &&
    !(await repository.succeeds(["cat-file", "-e", `${request.base}^{commit}`]))
  ) {
    throw new Refused(
      "commit_missing",
      `The commit ${request.base} the folder was written from is in no bundle of this repository`
    );
  }

  const { entries, files } = await snapshotFolder(folder, join(input.scratch, "snapshot"));
  const refused = treeRefusal(entries);
  if (refused) {
    throw new Refused(refused.code, refused.message, refused.path);
  }
  for (const file of files) {
    if ((file.size ?? 0) < ASSET_REPO_LFS_POINTER_MAX_BYTES && (await isLfsPointer(file.copy))) {
      throw new Refused(
        "lfs_pointer",
        `'${file.path}' is a Git LFS pointer. A repository holds the file itself, or a reference to a managed file.`,
        file.path
      );
    }
  }

  // The bytes as they were read: no ignore rule, no attribute, no filter. Git runs in its own
  // repository and is handed the copy of each file, never a path of the folder.
  const ids = (
    await repository.git(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
      input: files.map((file) => `${file.copy}\n`).join("")
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
  // The bundle is made where only this command writes and copied out once, as a new file: its
  // size and hash are those of the bytes that were written out.
  const made = join(input.scratch, "new.bundle");
  await repository.git([
    "bundle",
    "create",
    "--quiet",
    "--version=2",
    made,
    request.base ? `${request.base}..${ASSET_REPO_DRAFT_REF}` : ASSET_REPO_DRAFT_REF
  ]);
  const file = `${commit}.bundle`;
  const source = await open(made, "r");
  let copiedOut: BoundedCopy;
  try {
    copiedOut = await copyBounded(source, join(input.output, file), ASSET_REPO_MAX_BUNDLE_BYTES);
  } finally {
    await source.close();
  }
  if (copiedOut.exceeded) {
    throw new Refused(
      "bundle_too_large",
      `The bundle of the commit has more than ${ASSET_REPO_MAX_BUNDLE_BYTES} bytes (ASSET_REPO_MAX_BUNDLE_BYTES)`
    );
  }
  return {
    status: "committed",
    commit,
    tree,
    parent: request.base,
    files: files.length,
    bundle: {
      file,
      kind: request.base ? "incremental" : "full",
      prerequisite: request.base,
      sha256: copiedOut.sha256,
      bytes: copiedOut.bytes
    }
  };
}
