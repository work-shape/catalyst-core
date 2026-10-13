import {
  AppError,
  fileSetFileObjectKey,
  getSubjectUserId,
  isAuthenticatedServicePrincipal,
  type AssetRepoWrite,
  type AuthenticatedIdentity,
  type FileSet,
  type OperationRunId
} from "@vivd-catalyst/core";
import { createAssetRepoCommitClient } from "./asset-repo-jobs";
import type { ChatServerOptions } from "./types";

// The save of an asset whose files are a repository, as the API process makes it: the source
// files of a stored file set of the asset become one commit, made by the worker that reaches
// the sandbox. What comes back is what the write of the revision names. Nothing here is live:
// the bundle is pending until that write, and a write that is refused leaves it to the sweeper.
//
// Nothing here knows a kind of asset.

type SaveContext = Pick<ChatServerOptions, "clientInstanceId" | "stores" | "pages">;

/** Who the ledger names as the author of a commit: the opaque id of the caller. */
function authorOf(actor: AuthenticatedIdentity): string {
  return isAuthenticatedServicePrincipal(actor) ? actor.id : getSubjectUserId(actor);
}

/**
 * Commits the source files of `fileSet` onto `baseCommit` and answers the repository write of
 * the revision. A tree the command refuses, a commit that was not made in time and an instance
 * that cannot make one each throw, and nothing was written that a reader can see.
 */
export async function commitAssetFileSet(
  options: SaveContext,
  input: {
    assetId: string;
    operationRunId: OperationRunId;
    fileSet: FileSet;
    /** The commit of the draft the files replace. `null` starts the repository. */
    baseCommit: string | null;
    actor: AuthenticatedIdentity;
    message: string;
    signal?: AbortSignal;
  }
): Promise<AssetRepoWrite> {
  const client =
    options.pages?.assetRepo ?? createAssetRepoCommitClient({ stores: options.stores });
  const owner = { kind: "asset" as const, id: input.assetId };
  const { result } = await client.commit({
    clientInstanceId: options.clientInstanceId,
    assetId: input.assetId,
    operationRunId: input.operationRunId,
    request: {
      store: "files",
      files: input.fileSet.sourceFiles.map((file) => ({
        path: file.path,
        objectKey: fileSetFileObjectKey(owner, input.fileSet.id, "src", file.path),
        byteSize: file.bytes,
        checksum: file.sha256
      })),
      baseCommit: input.baseCommit,
      author: authorOf(input.actor),
      message: input.message
    },
    ...(input.signal ? { signal: input.signal } : {})
  });
  if (result.status === "committed") {
    return {
      commit: result.commit,
      tree: result.tree,
      baseCommit: input.baseCommit,
      operationRunId: input.operationRunId,
      bundle: result.bundle
    };
  }
  // The disk of the worker is full: the state of the instance, which an operator changes.
  if (result.status === "refused" && result.code === "no_space") {
    throw new AppError("CONFLICT", result.message, { reason: "no_space" });
  }
  if (result.status === "refused") {
    throw new AppError(
      "VALIDATION_FAILED",
      result.message,
      { reason: result.code, ...(result.path === undefined ? {} : { path: result.path }) },
      { exposeMessage: true }
    );
  }
  if (result.reason === "timeout") {
    throw new AppError(
      "TIMEOUT",
      // An answer of status 500 and above carries no details, so the reason is said here.
      `commit_timeout: ${result.message}`,
      { reason: "commit_timeout", retryable: true },
      { exposeMessage: true }
    );
  }
  // An instance that cannot make the commit refuses the call and says why: its runner image is
  // older than the release, which the message names, or no worker takes commits. An answer
  // of status 500 tells nothing, so these two are refusals.
  if (result.reason === "command_missing" || result.reason === "no_worker") {
    throw new AppError("CONFLICT", result.message, {
      reason: result.reason === "command_missing" ? "runner_image_outdated" : "commit_unavailable"
    });
  }
  throw new AppError("INTERNAL", result.message, { reason: "commit_failed" });
}
