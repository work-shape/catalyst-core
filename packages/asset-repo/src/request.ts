import { OBJECT_ID } from "./git";

// What the worker asks of the command, and what the command answers. Both are files, and each
// side reads the other's as data: the command checks a request before it starts git, and the
// worker checks a result before it believes it.

/** One bundle, as the ledger names it. The order of the list is the order of the ledger. */
export interface BundleReference {
  /** The name of the file below the bundles directory. */
  file: string;
  tip: string;
  /** The commit an incremental bundle stands on. `null` for a full bundle. */
  prerequisite: string | null;
  /**
   * The SHA-256 and the size the ledger recorded when the bundle was written. A file with
   * other bytes is not the bundle the ledger names and is refused before it is read.
   */
  sha256: string;
  bytes: number;
}

export interface RepositoryLimits {
  fileBytes: number;
  files: number;
  treeBytes: number;
  historyBytes: number;
}

export interface CommitFolderRequest {
  limits?: RepositoryLimits;
  bundles: BundleReference[];
  /** The commit the folder was written from, which becomes the parent. `null` for the first. */
  base: string | null;
  /** The opaque id of the user the ledger names as the author. */
  author: string;
  /** The time the ledger gives the revision, in seconds since 1970. */
  time: number;
  /** One line. The ledger makes it, so that a repeated save names the same commit. */
  message: string;
}

export interface MaterialiseRequest {
  bundles: BundleReference[];
  /** The commit of the draft revision. */
  draft: string;
  /** Every revision of the ledger with its commit. */
  revisions: { number: number; commit: string }[];
}

/** Why the command did nothing. `path` names the file that is the reason, where one is. */
export interface AssetRepoRefusal {
  status: "refused";
  code: string;
  path?: string;
  message: string;
}

export type CommitFolderResult =
  | {
      status: "committed";
      commit: string;
      tree: string;
      parent: string | null;
      files: number;
      /** The bundle that holds the commit, below the output directory. */
      bundle: {
        file: string;
        kind: "full" | "incremental";
        prerequisite: string | null;
        /** What the ledger records of the file, and what a later request names it by. */
        sha256: string;
        bytes: number;
      };
    }
  | AssetRepoRefusal;

export type MaterialiseResult =
  { status: "materialised"; draft: string; revisions: number; commits: number } | AssetRepoRefusal;

export class RequestError extends Error {}

const BUNDLE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}\.bundle$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const MESSAGE = /^[^\u0000-\u001f\u007f]{1,200}$/u;

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestError(`${what} is not an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function commit(value: unknown, what: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new RequestError(`${what} is not a commit id`);
  }
  return value;
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new RequestError(`${what} is not a list`);
  }
  return [...value];
}

function bundles(value: unknown): BundleReference[] {
  return list(value, "bundles").map((entry, index) => {
    const bundle = record(entry, `bundles[${index}]`);
    if (typeof bundle.file !== "string" || !BUNDLE_FILE.test(bundle.file)) {
      throw new RequestError(`bundles[${index}].file is not the name of a bundle file`);
    }
    if (typeof bundle.sha256 !== "string" || !SHA256.test(bundle.sha256)) {
      throw new RequestError(`bundles[${index}].sha256 is not a SHA-256 in lower-case hex`);
    }
    if (
      typeof bundle.bytes !== "number" ||
      !Number.isSafeInteger(bundle.bytes) ||
      bundle.bytes < 1
    ) {
      throw new RequestError(`bundles[${index}].bytes is not a number of bytes`);
    }
    return {
      file: bundle.file,
      sha256: bundle.sha256,
      bytes: bundle.bytes,
      tip: commit(bundle.tip, `bundles[${index}].tip`),
      prerequisite:
        bundle.prerequisite === null
          ? null
          : commit(bundle.prerequisite, `bundles[${index}].prerequisite`)
    };
  });
}

export function parseCommitFolderRequest(value: unknown): CommitFolderRequest {
  const request = record(value, "The request");
  const { author, time, message } = request;
  if (typeof author !== "string" || !AUTHOR.test(author)) {
    throw new RequestError("author is not an opaque user id");
  }
  if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0) {
    throw new RequestError("time is not a number of seconds");
  }
  if (typeof message !== "string" || !MESSAGE.test(message)) {
    throw new RequestError("message is not one line of at most 200 characters");
  }
  const base = request.base === null ? null : commit(request.base, "base");
  const named = bundles(request.bundles);
  if ((base === null) !== (named.length === 0)) {
    throw new RequestError("A first commit names no bundle, and every other names its base");
  }
  const limits = request.limits === undefined ? undefined : record(request.limits, "limits");
  const positive = (value: unknown): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
      throw new RequestError("Repository limits are positive safe integers");
    return value;
  };
  return {
    bundles: named,
    base,
    author,
    time,
    message,
    ...(limits
      ? {
          limits: {
            fileBytes: positive(limits.fileBytes),
            files: positive(limits.files),
            treeBytes: positive(limits.treeBytes),
            historyBytes: positive(limits.historyBytes)
          }
        }
      : {})
  };
}

export function parseMaterialiseRequest(value: unknown): MaterialiseRequest {
  const request = record(value, "The request");
  const revisions = list(request.revisions, "revisions").map((entry, index) => {
    const revision = record(entry, `revisions[${index}]`);
    const { number } = revision;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 1) {
      throw new RequestError(`revisions[${index}].number is not a revision number`);
    }
    return { number, commit: commit(revision.commit, `revisions[${index}].commit`) };
  });
  const named = bundles(request.bundles);
  // Every commit the request names comes out of a bundle it names. A request without one
  // could only be answered from objects somebody else put there.
  if (named.length === 0) {
    throw new RequestError("A repository is made from at least one bundle");
  }
  return { bundles: named, draft: commit(request.draft, "draft"), revisions };
}
