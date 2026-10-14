import { createHash } from "node:crypto";
import {
  AppError,
  ASSET_GET_FILES_MAX_BYTES,
  ASSET_PUT_FILES_MAX_BYTES,
  assetObjectPrefix,
  createFileSetId,
  fileSetContentType,
  fileSetFileObjectKey,
  fileSetObjectPrefix,
  requireFileSetWithinLimits,
  type AssetBuildClient,
  type FileSet,
  type FileSetId,
  type FileSetOwner,
  type UserId
} from "@vivd-catalyst/core";
import { z } from "zod";
import type { WorkflowAssetKind } from "./asset-kinds/shared";
import {
  readFileSetFile,
  storeAssetFileSet,
  writeFileSetObjects,
  type PageFileInput
} from "./page-file-sets";
import { createPageBuildClient } from "./page-jobs";
import type { AssetWorkflowOptions } from "./types";

// The files of an asset whose revisions hold files: a write hands over the whole source set,
// the build of Pages builds it, and the file set it leaves is immutable and owned by the
// asset, below `assets/<assetId>/<fileSetId>/`. The revision that names it is the caller's.
// A kind that reads its files itself (`manifestOfFiles`) has no build: its file set holds the
// source files alone.

/** What a file set that no kit built names as its kit version. */
const UNBUILT_FILE_SET_KIT_VERSION = "none";

/**
 * The body limit of a write that carries files: `ASSET_PUT_FILES_MAX_BYTES` as base64, and
 * room for the paths and the rest of the call around it.
 */
export const ASSET_PUT_BODY_LIMIT_BYTES =
  Math.ceil(ASSET_PUT_FILES_MAX_BYTES / 3) * 4 + 1024 * 1024;

type FilesContext = Pick<AssetWorkflowOptions, "clientInstanceId" | "stores" | "pages">;

/** One source file as a call carries it. */
export type AssetFileInput = { path: string; text: string } | { path: string; base64: string };

function requireObjects(options: FilesContext): NonNullable<AssetWorkflowOptions["pages"]> {
  if (!options.pages) {
    throw new AppError(
      "VALIDATION_FAILED",
      "This instance has no store of files, so it holds no asset with files",
      { reason: "files_unavailable" }
    );
  }
  return options.pages;
}

function builds(options: FilesContext): AssetBuildClient {
  return options.pages?.assetBuilds ?? createPageBuildClient({ stores: options.stores });
}

/**
 * The files of a call as bytes. The size of the whole call is checked on what the call holds
 * before any of it is decoded, so a call over the limit costs no second copy of itself.
 */
export function decodeAssetFiles(files: readonly AssetFileInput[]): PageFileInput[] {
  const sizes = files.map((file) =>
    "text" in file ? Buffer.byteLength(file.text, "utf8") : base64ByteLength(file.base64)
  );
  const total = sizes.reduce((sum, bytes) => sum + bytes, 0);
  if (total > ASSET_PUT_FILES_MAX_BYTES) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The files of the call have ${total} bytes. One write carries at most ${ASSET_PUT_FILES_MAX_BYTES} bytes of files (ASSET_PUT_FILES_MAX_BYTES).`,
      {
        reason: "files_too_large",
        cap: "ASSET_PUT_FILES_MAX_BYTES",
        limit: ASSET_PUT_FILES_MAX_BYTES,
        actual: total
      }
    );
  }
  return files.map((file) => ({
    path: file.path,
    bytes:
      "text" in file
        ? new TextEncoder().encode(file.text)
        : new Uint8Array(Buffer.from(file.base64, "base64"))
  }));
}

function base64ByteLength(text: string): number {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((text.length * 3) / 4) - padding);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assetOwner(assetId: string): FileSetOwner {
  return { kind: "asset", id: assetId };
}

/**
 * Removes one file set of an asset a write stored and then did not name: row and objects.
 * Where a revision names the file set the write was committed and something after it failed:
 * the files are that revision's and stay.
 */
export async function removeUnnamedAssetFileSet(
  options: FilesContext,
  assetId: string,
  fileSetId: FileSetId
): Promise<void> {
  const { objects } = requireObjects(options);
  const removed = await options.stores.pages.deleteAssetFileSet({
    clientInstanceId: options.clientInstanceId,
    assetId,
    fileSetId
  });
  if (removed) {
    await objects.deletePrefix(fileSetObjectPrefix(assetOwner(assetId), fileSetId));
  }
}

/** Removes everything stored for an asset whose rows are gone. */
export async function removeAssetObjects(options: FilesContext, assetId: string): Promise<void> {
  await requireObjects(options).objects.deletePrefix(assetObjectPrefix(assetId));
}

/**
 * Builds the source files of one write and stores the file set, for an asset whose row may
 * not exist yet. It answers when the file set is stored. A set the build refuses, a build that
 * did not end in time and a build that gave no result each throw, and nothing stays stored.
 */
export async function buildAssetFileSet(
  options: FilesContext,
  input: {
    kind: WorkflowAssetKind;
    name: string;
    assetId: string;
    files: readonly PageFileInput[];
    requestedByUserId?: UserId;
    signal?: AbortSignal;
  }
): Promise<FileSet> {
  const { objects } = requireObjects(options);
  const { manifestFile } = input.kind;
  if (manifestFile !== undefined && !input.files.some((file) => file.path === manifestFile)) {
    throw new AppError(
      "VALIDATION_FAILED",
      `The files hold no '${manifestFile}'. Every write carries the whole source set, the manifest among it.`,
      { reason: "manifest_missing", file: manifestFile }
    );
  }
  requireFileSetWithinLimits(
    input.files.map((file) => ({ part: "src", path: file.path, bytes: file.bytes.byteLength }))
  );
  const owner = assetOwner(input.assetId);
  const fileSetId = createFileSetId();
  const prefix = fileSetObjectPrefix(owner, fileSetId);
  const manifestOf = input.kind.manifestOfFiles?.bind(input.kind);
  if (manifestOf) {
    try {
      return await storeAssetFileSet(options, {
        assetId: input.assetId,
        fileSetId,
        kitVersion: UNBUILT_FILE_SET_KIT_VERSION,
        manifest: manifestOf(input.files),
        sourceFiles: input.files,
        builtFiles: [],
        writes: ["src"],
        ...(input.requestedByUserId ? { createdByUserId: input.requestedByUserId } : {}),
        ...(input.signal ? { signal: input.signal } : {})
      });
    } catch (error) {
      await objects.deletePrefix(prefix).catch(() => undefined);
      throw error;
    }
  }
  try {
    await writeFileSetObjects(
      objects,
      owner,
      fileSetId,
      input.files.map((file) => ({ part: "src" as const, file })),
      input.signal
    );
    const outcome = await builds(options).buildAsset({
      clientInstanceId: options.clientInstanceId,
      request: {
        pageName: input.name,
        directory: input.name,
        files: input.files.map((file) => ({
          path: file.path,
          objectKey: fileSetFileObjectKey(owner, fileSetId, "src", file.path),
          byteSize: file.bytes.byteLength,
          checksum: sha256(file.bytes)
        })),
        ...(input.requestedByUserId ? { requestedByUserId: input.requestedByUserId } : {}),
        asset: { assetId: input.assetId, fileSetId }
      },
      ...(input.signal ? { signal: input.signal } : {})
    });
    if (outcome.status === "errors") {
      throw new AppError(
        "VALIDATION_FAILED",
        `The files of ${input.kind.kind} '${input.name}' do not build. Nothing was written.`,
        { reason: "validation_failed", issues: outcome.errors }
      );
    }
    if (outcome.status === "failed") {
      throw outcome.reason === "timeout"
        ? new AppError(
            "TIMEOUT",
            // An answer of status 500 and above carries no details, so the reason is said here.
            `build_timeout: the files of ${input.kind.kind} '${input.name}' were not built in time. Nothing was written. Send the write again.`,
            { reason: "build_timeout", retryable: true },
            { exposeMessage: true }
          )
        : new AppError(
            "INTERNAL",
            outcome.message,
            { reason: outcome.reason === "no_worker" ? "build_unavailable" : "build_failed" },
            { exposeMessage: true }
          );
    }
    const fileSet = await options.stores.pages.getAssetFileSet({
      clientInstanceId: options.clientInstanceId,
      assetId: input.assetId,
      fileSetId: outcome.fileSetId
    });
    if (!fileSet) {
      throw new AppError("INTERNAL", "A build stored a file set that is not there");
    }
    return fileSet;
  } catch (error) {
    // No revision names this file set. A build that still runs finds its result written and
    // removes what it wrote itself.
    await options.stores.pages
      .deleteAssetFileSet({
        clientInstanceId: options.clientInstanceId,
        assetId: input.assetId,
        fileSetId
      })
      .catch(() => undefined);
    await objects.deletePrefix(prefix).catch(() => undefined);
    throw error;
  }
}

/**
 * Copies a stored file set into the prefix of an asset, source and built files as they are,
 * each checked against the hash its row holds. Nothing is built: the copy is the same bytes.
 */
export async function copyFileSetToAsset(
  options: FilesContext,
  input: { source: FileSet; assetId: string; createdByUserId?: UserId }
): Promise<FileSet> {
  const { objects } = requireObjects(options);
  const read = (part: "src" | "dist") =>
    Promise.all(
      (part === "src" ? input.source.sourceFiles : input.source.builtFiles).map(async (file) => ({
        path: file.path,
        bytes: await readFileSetFile(options, input.source, part, file)
      }))
    );
  const fileSetId = createFileSetId();
  try {
    return await storeAssetFileSet(options, {
      assetId: input.assetId,
      fileSetId,
      kitVersion: input.source.kitVersion,
      manifest: input.source.manifest,
      sourceFiles: await read("src"),
      builtFiles: await read("dist"),
      writes: ["src", "dist"],
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
    });
  } catch (error) {
    await objects
      .deletePrefix(fileSetObjectPrefix(assetOwner(input.assetId), fileSetId))
      .catch(() => undefined);
    throw error;
  }
}

/**
 * Stores the folder of one write of a kind whose revision is a config with files beside it
 * (`revisionFiles`), for an asset whose row may not exist yet. Where the instance has no store
 * of files the write is the config alone, and is refused only where the folder holds a file
 * the config cannot.
 */
export async function storeRevisionFiles(
  options: FilesContext,
  input: {
    kind: WorkflowAssetKind;
    assetId: string;
    files: readonly PageFileInput[];
    extras: readonly string[];
    createdByUserId?: UserId;
  }
): Promise<FileSet | undefined> {
  const hook = input.kind.revisionFiles;
  if (!hook) return undefined;
  if (!options.pages) {
    if (input.extras.length === 0) return undefined;
    throw new AppError(
      "VALIDATION_FAILED",
      `This instance has no store of files, so a ${input.kind.kind} holds its text alone here: '${input.extras[0] ?? ""}' cannot be kept`,
      { reason: "files_unavailable", path: input.extras[0] ?? "" }
    );
  }
  const fileSetId = createFileSetId();
  try {
    return await storeAssetFileSet(options, {
      assetId: input.assetId,
      fileSetId,
      kitVersion: UNBUILT_FILE_SET_KIT_VERSION,
      manifest: hook.manifestOf(input.extras),
      sourceFiles: input.files,
      builtFiles: [],
      writes: ["src"],
      ...(input.createdByUserId ? { createdByUserId: input.createdByUserId } : {})
    });
  } catch (error) {
    await options.pages.objects
      .deletePrefix(fileSetObjectPrefix(assetOwner(input.assetId), fileSetId))
      .catch(() => undefined);
    throw error;
  }
}

/**
 * The folder of one revision of such a kind, in the order of its paths: the files its config
 * holds, and the files of its file set the config does not hold. A file of the config is
 * answered as the bytes that were written where those still say what the config says, so a
 * folder that was written is read back as it was; otherwise as the config makes it. A
 * revision without a file set, such as every one from before a skill could hold files, is
 * read from its config alone.
 */
export async function readRevisionFiles(
  options: FilesContext,
  kind: WorkflowAssetKind,
  revision: { assetId: string; config: unknown; fileSetId?: FileSetId }
): Promise<{ files: AssetFileOutput[] }> {
  const hook = kind.revisionFiles;
  if (!hook) return { files: [] };
  const fileSet = revision.fileSetId
    ? await options.stores.pages.getAssetFileSet({
        clientInstanceId: options.clientInstanceId,
        assetId: revision.assetId,
        fileSetId: revision.fileSetId
      })
    : undefined;
  const stored = new Map((fileSet?.sourceFiles ?? []).map((file) => [file.path, file]));
  const bytesOf = (path: string) => {
    const file = stored.get(path);
    return fileSet && file ? readFileSetFile(options, fileSet, "src", file) : undefined;
  };
  const own = await Promise.all(
    hook.filesOfConfig(revision.config).map(async (derived) => {
      const written = await bytesOf(derived.path);
      return written && hook.matchesConfig(revision.config, { path: derived.path, bytes: written })
        ? { path: derived.path, bytes: written }
        : derived;
    })
  );
  const held = new Set(own.map((file) => file.path));
  const index = hook.indexed({}, fileSet).files;
  const extras = z.array(z.object({ path: z.string() })).parse(index ?? []);
  const others = await Promise.all(
    extras
      .filter(({ path }) => !held.has(path))
      .map(async ({ path }) => ({ path, bytes: (await bytesOf(path)) ?? new Uint8Array() }))
  );
  return {
    files: [...own, ...others]
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
      .map((file) => ({
        path: file.path,
        contentType: stored.get(file.path)?.contentType ?? fileSetContentType(file.path),
        sha256: sha256(file.bytes),
        bytes: file.bytes.byteLength,
        ...fileContent(file.bytes)
      }))
  };
}

/** The source files of a file set as a write's answer names them: no content. */
export function sourceFileEntries(
  fileSet: FileSet
): { path: string; sha256: string; bytes: number }[] {
  return fileSet.sourceFiles
    .map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

/** How many source files of one read are fetched from the store at a time. */
const ASSET_GET_FILE_READS_IN_FLIGHT = 8;

/** One source file as a read answers it. Without `text` and `base64` it is an index entry. */
export interface AssetFileOutput {
  path: string;
  contentType: string;
  sha256: string;
  bytes: number;
  text?: string;
  base64?: string;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * The content of a file as a call carries it back: `text` where the bytes are UTF-8 text, so
 * that writing the text again stores the same bytes, and `base64` for everything else.
 */
function fileContent(bytes: Uint8Array): { text: string } | { base64: string } {
  if (!bytes.includes(0)) {
    try {
      return { text: utf8.decode(bytes) };
    } catch {
      // Not UTF-8: answered as bytes.
    }
  }
  return { base64: Buffer.from(bytes).toString("base64") };
}

/**
 * The source files of a file set in the order of their paths, each checked against its hash.
 * A set above `ASSET_GET_FILES_MAX_BYTES` is answered as its index, and no object is read.
 */
export async function readSourceFiles(
  options: FilesContext,
  fileSet: FileSet
): Promise<{ files: AssetFileOutput[]; filesOmitted?: true }> {
  const index = [...fileSet.sourceFiles].sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  const entry = (file: (typeof index)[number]): AssetFileOutput => ({
    path: file.path,
    contentType: file.contentType,
    sha256: file.sha256,
    bytes: file.bytes
  });
  const total = index.reduce((sum, file) => sum + file.bytes, 0);
  if (total > ASSET_GET_FILES_MAX_BYTES) {
    return { files: index.map(entry), filesOmitted: true };
  }
  const files: AssetFileOutput[] = [];
  for (let start = 0; start < index.length; start += ASSET_GET_FILE_READS_IN_FLIGHT) {
    const batch = index.slice(start, start + ASSET_GET_FILE_READS_IN_FLIGHT);
    files.push(
      ...(await Promise.all(
        batch.map(async (file) => ({
          ...entry(file),
          ...fileContent(await readFileSetFile(options, fileSet, "src", file))
        }))
      ))
    );
  }
  return { files };
}
