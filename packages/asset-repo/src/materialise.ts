import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { GitError, OBJECT_ID, type Repository } from "./git";
import {
  ASSET_REPO_DRAFT_REF,
  ASSET_REPO_MAX_BUNDLE_BYTES,
  ASSET_REPO_REVISION_REF_PREFIX
} from "./limits";
import type { AssetRepoRefusal, BundleReference } from "./request";

// From bundles to a repository. The ledger says which bundles there are, in which order, and
// which commit each ends on; nothing here asks a bundle what the tip is. A bundle is read as
// data that may be wrong: its header is read here, as text, before git sees the pack, and the
// pack is indexed with every object checked.

/** Ends a command with a refusal as its result. */
export class Refused extends Error {
  readonly refusal: AssetRepoRefusal;
  constructor(code: string, message: string, path?: string) {
    super(message);
    this.refusal = { status: "refused", code, message, ...(path === undefined ? {} : { path }) };
  }
}

/** How much of a bundle is read for its header: one ref and a few prerequisites fit many times. */
const BUNDLE_HEADER_MAX_BYTES = 64 * 1024;
const BUNDLE_V2_SIGNATURE = "# v2 git bundle\n";

interface BundleHeader {
  prerequisites: string[];
  refs: { commit: string; name: string }[];
  /** Where the pack starts in the file. */
  packOffset: number;
}

/** Reads the header of a version 2 bundle. Nothing else is a bundle here. */
function parseBundleHeader(start: Uint8Array): BundleHeader | undefined {
  const text = Buffer.from(start).toString("latin1");
  const end = text.indexOf("\n\n");
  if (!text.startsWith(BUNDLE_V2_SIGNATURE) || end < 0) {
    return undefined;
  }
  const header: BundleHeader = { prerequisites: [], refs: [], packOffset: end + 2 };
  const lines = text.slice(BUNDLE_V2_SIGNATURE.length, end).split("\n");
  for (const line of lines.filter((entry) => entry !== "")) {
    if (line.startsWith("-")) {
      const commit = line.slice(1, 41);
      if (!OBJECT_ID.test(commit) || (line.length > 41 && line[41] !== " ")) {
        return undefined;
      }
      header.prerequisites.push(commit);
      continue;
    }
    const commit = line.slice(0, 40);
    if (!OBJECT_ID.test(commit) || line[40] !== " " || line.length < 42) {
      return undefined;
    }
    header.refs.push({ commit, name: line.slice(41) });
  }
  return header;
}

/** What was read of a file that was copied, up to the bound of the copy. */
export interface BoundedCopy {
  bytes: number;
  sha256: string;
  /** The file holds more than the bound. The copy ends there and is not the file. */
  exceeded: boolean;
}

/**
 * Copies what an open file holds into a new file this command owns and answers its size and
 * SHA-256. The bytes are read once, here: what was counted and hashed is what the copy holds,
 * whatever becomes of the path afterwards. Not more than `maxBytes` are read.
 */
export async function copyBounded(
  source: FileHandle,
  destination: string,
  maxBytes: number
): Promise<BoundedCopy> {
  const hash = createHash("sha256");
  const target = await open(destination, "wx", 0o600);
  try {
    const buffer = Buffer.alloc(64 * 1024);
    let bytes = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) {
        return { bytes, sha256: hash.digest("hex"), exceeded: false };
      }
      bytes += bytesRead;
      if (bytes > maxBytes) {
        return { bytes, sha256: "", exceeded: true };
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await target.writeFile(chunk);
    }
  } finally {
    await target.close();
  }
}

/** Opens a regular file for reading and follows no link at its name. Nothing else is opened. */
export async function openRegularFile(path: string): Promise<FileHandle | undefined> {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  ).catch(() => undefined);
  if (file && !(await file.stat()).isFile()) {
    await file.close();
    return undefined;
  }
  return file;
}

async function isCommit(repository: Repository, commit: string): Promise<boolean> {
  return repository.succeeds(["cat-file", "-e", `${commit}^{commit}`]);
}

/**
 * Adds the objects of one bundle the ledger names, or refuses it with its name. `copy` is where
 * the bundle is copied to before anything reads it as a bundle.
 */
async function applyBundle(
  repository: Repository,
  directory: string,
  bundle: BundleReference,
  copy: string
): Promise<void> {
  const refuse = (code: string, reason: string) =>
    new Refused(code, `The bundle '${bundle.file}' ${reason}`, bundle.file);
  if (bundle.bytes > ASSET_REPO_MAX_BUNDLE_BYTES) {
    throw refuse(
      "bundle_too_large",
      `has ${bundle.bytes} bytes. A bundle has at most ${ASSET_REPO_MAX_BUNDLE_BYTES} (ASSET_REPO_MAX_BUNDLE_BYTES).`
    );
  }
  const source = await openRegularFile(join(directory, bundle.file));
  if (!source) {
    throw refuse("bundle_missing", "is not among the files of this repository");
  }
  // A bundle of the ledger passed the tree check when it was written, and that check is not
  // repeated here. So the bytes must be the ones the ledger recorded and no others. The file
  // is read once, into a copy nobody else writes to, and not past the size the ledger
  // recorded; the hash is taken of what the copy holds, and the header and the pack are read
  // from the copy. What becomes of the file meanwhile changes nothing.
  let copied: BoundedCopy;
  try {
    copied = await copyBounded(source, copy, bundle.bytes);
  } finally {
    await source.close();
  }
  if (copied.exceeded || copied.bytes !== bundle.bytes || copied.sha256 !== bundle.sha256) {
    throw refuse("bundle_hash_mismatch", "does not have the bytes the ledger recorded for it");
  }
  const path = copy;
  const file = await open(path, "r");
  let start: Buffer;
  try {
    const buffer = Buffer.alloc(Math.min(copied.bytes, BUNDLE_HEADER_MAX_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, 0);
    start = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  const header = parseBundleHeader(start);
  if (!header) {
    throw refuse("bundle_invalid", "is not a version 2 git bundle");
  }
  const [ref] = header.refs;
  if (header.refs.length !== 1 || !ref || ref.name !== ASSET_REPO_DRAFT_REF) {
    throw refuse("bundle_invalid", `does not hold the one ref '${ASSET_REPO_DRAFT_REF}'`);
  }
  if (ref.commit !== bundle.tip) {
    throw refuse("bundle_invalid", "ends on another commit than the ledger names");
  }
  if (
    bundle.prerequisite === null
      ? header.prerequisites.length > 0
      : !header.prerequisites.includes(bundle.prerequisite)
  ) {
    throw refuse("bundle_invalid", "stands on another commit than the ledger names");
  }
  for (const prerequisite of header.prerequisites) {
    if (!(await isCommit(repository, prerequisite))) {
      throw refuse(
        "bundle_prerequisite_missing",
        `stands on the commit ${prerequisite}, which no bundle before it holds: a bundle is missing`
      );
    }
  }
  try {
    // `--strict` checks every object and that everything an object names exists. Git 2.39
    // does not check the objects of a bundle on a setting alone, so the pack is indexed here.
    await repository.git(
      [
        "index-pack",
        "--stdin",
        "--fix-thin",
        "--strict",
        `--max-input-size=${ASSET_REPO_MAX_BUNDLE_BYTES}`
      ],
      { inputFile: { path, offset: header.packOffset } }
    );
  } catch (error) {
    if (error instanceof GitError) {
      throw refuse("bundle_invalid", "holds objects git refuses");
    }
    throw error;
  }
  if (!(await isCommit(repository, bundle.tip))) {
    throw refuse("bundle_invalid", "does not hold the commit it ends on");
  }
  if (
    bundle.prerequisite !== null &&
    !(await repository.succeeds(["merge-base", "--is-ancestor", bundle.prerequisite, bundle.tip]))
  ) {
    throw refuse("bundle_invalid", "does not continue the commit it stands on");
  }
}

/**
 * Adds the objects of every bundle, in the order of the ledger. `scratch` is a directory this
 * command made, which gets the copies the bundles are read from.
 */
export async function applyBundles(
  repository: Repository,
  directory: string,
  bundles: readonly BundleReference[],
  scratch: string
): Promise<void> {
  const copies = join(scratch, "bundles");
  await mkdir(copies, { mode: 0o700 });
  for (const [index, bundle] of bundles.entries()) {
    await applyBundle(repository, directory, bundle, join(copies, `${index}.bundle`));
  }
}

/**
 * Sets the refs of a repository from the ledger: the draft and one per revision. A commit the
 * ledger names and no bundle holds is refused with the revision named.
 */
export async function writeLedgerRefs(
  repository: Repository,
  ledger: { draft: string; revisions: readonly { number: number; commit: string }[] }
): Promise<void> {
  const refs = [
    { name: ASSET_REPO_DRAFT_REF, commit: ledger.draft, what: "the draft" },
    ...ledger.revisions.map((revision) => ({
      name: `${ASSET_REPO_REVISION_REF_PREFIX}${revision.number}`,
      commit: revision.commit,
      what: `revision ${revision.number}`
    }))
  ];
  for (const ref of refs) {
    if (!(await isCommit(repository, ref.commit))) {
      throw new Refused(
        "commit_missing",
        `The commit ${ref.commit} of ${ref.what} is in no bundle of this repository`
      );
    }
  }
  await repository.git(["update-ref", "--stdin"], {
    input: refs.map((ref) => `update ${ref.name} ${ref.commit}\n`).join("")
  });
}
