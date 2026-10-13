// An asset whose content is a repository is kept as git bundles, and git runs for it only as
// this command, in the sandbox the instance runs agent commands in: a container without a
// network, with a read-only root and one writable directory. The worker writes a request, the
// bundles the ledger names and, for a save, the folder as plain files into that directory; the
// command writes a result and a bundle into `out/`, and the worker reads `out/` back as data
// it does not trust. Nothing here knows a kind of asset.

/** The command, as the runner image installs it on its path. */
export const ASSET_REPO_COMMAND = "catalyst-asset-repo";
/** What the worker asks for, below the command's directory. */
export const ASSET_REPO_REQUEST_FILE = "request.json";
/** Where the worker puts the bundles the ledger names, below the command's directory. */
export const ASSET_REPO_BUNDLES_DIRECTORY = "bundles";
/** Where the worker puts the files to commit, below the command's directory. */
export const ASSET_REPO_FOLDER_DIRECTORY = "folder";
/** Where the command writes, below its directory. */
export const ASSET_REPO_OUTPUT_DIRECTORY = "out";
/** What the command says about its outcome, below the output directory. */
export const ASSET_REPO_RESULT_FILE = "result.json";
/**
 * Where the command keeps what it works on, below its directory: its repository, its copies
 * of the bundles and of the files, and the new bundle before it is copied out. The worker
 * makes it, empty. It is on the disk of the worker, as the folder and the bundles are, and
 * not in the `/tmp` of the sandbox, which is a small tmpfs that counts as memory.
 */
export const ASSET_REPO_WORK_DIRECTORY = "work";
/** The repository `materialise` leaves, below the output directory. */
export const ASSET_REPO_REPOSITORY_DIRECTORY = "repo.git";

/** The one line of history a repository has. Its tip is the commit of the draft revision. */
export const ASSET_REPO_DRAFT_REF = "refs/heads/draft";
/** One ref per revision, so that every revision stays reachable. */
export const ASSET_REPO_REVISION_REF_PREFIX = "refs/revisions/";

/** The largest file a repository takes. A larger one is refused with its path. */
export const ASSET_REPO_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** What the files of one commit may weigh together. A heavier tree is refused. */
export const ASSET_REPO_MAX_TREE_BYTES = 50 * 1024 * 1024;
/** How many files one commit may hold. One more is refused. */
export const ASSET_REPO_MAX_FILES = 2000;
/** The longest path, in bytes. A longer one is refused. */
export const ASSET_REPO_MAX_PATH_BYTES = 512;
/**
 * What the history of one repository may weigh: the bundles of its ledger together, and so
 * the largest bundle that is read. A save that would leave more is refused.
 */
export const ASSET_REPO_MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
/**
 * The disk one commit may take below its directory, from the limits above: the folder and the
 * bundles as the worker wrote them, the command's copy of each, a repository that holds the
 * history and the new tree without a byte saved, and the new bundle twice, made and copied
 * out. A worker starts no commit on a disk with less room, and the files of a commit are
 * removed when it ended.
 */
export const ASSET_REPO_COMMIT_DISK_BYTES =
  5 * ASSET_REPO_MAX_TREE_BYTES + 3 * ASSET_REPO_MAX_BUNDLE_BYTES;
/** The largest `request.json` and `result.json` that is read: 2,000 revisions fit ten times. */
export const ASSET_REPO_MAX_REQUEST_BYTES = 2 * 1024 * 1024;
/** A size as a person reads it, in MiB with one decimal, rounded up: never below the bytes. */
export function assetRepoMib(bytes: number): string {
  return `${Math.ceil((bytes / (1024 * 1024)) * 10) / 10} MiB`;
}

/** What the command writes to its error stream when the disk it works on is full. */
export const ASSET_REPO_NO_SPACE_MARK = "catalyst-asset-repo: no space";
/** What a person is told then. */
export const ASSET_REPO_NO_SPACE_MESSAGE =
  "The server has too little free disk space for this save. Nothing was saved. An operator needs to free space on the server; then save again.";
/** How long one git process may run. Past it the command fails and the save is refused. */
export const ASSET_REPO_GIT_TIMEOUT_MS = 60_000;
/** A blob at or above this size is never inflated in memory by git. */
export const ASSET_REPO_BIG_FILE_THRESHOLD = "4m";
/** A Git LFS pointer is shorter than this and starts with the line below. */
export const ASSET_REPO_LFS_POINTER_MAX_BYTES = 1024;
export const ASSET_REPO_LFS_POINTER_START = "version https://git-lfs";
