import { setTimeout } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  assetRepoMib,
  ASSET_REPO_MAX_BUNDLE_BYTES,
  ASSET_REPO_MAX_FILE_BYTES,
  ASSET_REPO_MAX_FILES,
  ASSET_REPO_MAX_TREE_BYTES
} from "@work-shape/catalyst-asset-repo";
import {
  isRecord,
  assetObjectPrefix,
  assetRepoBundleObjectKey,
  defineJobHandler,
  defineJobKind,
  defineSchedule,
  isAppError,
  isOperationTimeout,
  isOperationRunId,
  JOB_UNCLAIMED_MS,
  JOB_WORKER_CHECK_INTERVAL_MS,
  noWorkerTakesJobs,
  scheduledJobPayloadSchema,
  subjectDedupeKey,
  type AssetRepoBundle,
  type AssetRepoCommitRequest,
  type AssetRepoCommitResult,
  type AssetRepoSave,
  type AssetRepoSaveBundle,
  type ClientInstanceId,
  type JobControl,
  type JobSchedule,
  type Logger,
  type ObjectStorage,
  type OperationRunId,
  type PlatformStores,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { AssetRepoCommitRunner } from "./asset-repo-sandbox";

// A save of an asset whose files are a repository. The API process has no git and does not
// reach the sandbox. It writes the pending row of the save with what to commit and enqueues
// `asset_repo.commit`; the workspace command worker, the one process that reaches the sandbox,
// reads the bundles of the ledger and the files, has the commit made by the fixed command,
// names the new bundle on the pending row, puts its object and writes how it ended on the
// row, where the save reads it. The write of the revision, which makes the bundle part of the
// repository, is the caller's: it names the commit, the tree and the bundle of this result.
//
// Nothing here knows a kind of asset.

const ASSET_REPO_COMMIT_LEASE_MS = 3 * 60 * 1000;
const ASSET_REPO_COMMIT_HEARTBEAT_MS = 30 * 1000;
/** A commit is one container for a few seconds. */
const ASSET_REPO_COMMIT_DEFAULT_SLOTS = 2;
/** How many objects of one save are read from the store at a time. */
const ASSET_REPO_READ_CONCURRENCY = 8;
/** How long a save waits for its commit. Past it the save fails and may be tried again. */
export const ASSET_REPO_COMMIT_WAIT_MS = 60_000;
const ASSET_REPO_COMMIT_POLL_INTERVAL_MS = 250;
/** A save that is still pending after this long is given up, and its object removed. */
export const ASSET_REPO_SAVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const ASSET_REPO_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** How many rows one pass of the sweeper gives up, and how many objects it removes. */
const ASSET_REPO_SWEEP_LIMIT = 500;

/**
 * Makes the commit of one save. One attempt: a commit that failed half way is answered as
 * failed, and the Operation Run that saves tries again and builds the same commit. One commit
 * per asset at a time, in the order saved.
 */
export const assetRepoCommitJob = defineJobKind({
  kind: "asset_repo.commit",
  payloadSchema: z.object({ assetId: z.string().min(1), operationRunId: z.string().min(1) }),
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: ASSET_REPO_COMMIT_LEASE_MS,
  heartbeatMs: ASSET_REPO_COMMIT_HEARTBEAT_MS,
  concurrency: { perKey: 1 },
  manualRetry: false
});

/** Gives up the saves that did not finish and removes their objects. */
export const assetRepoSweepJob = defineJobKind({
  kind: "asset_repo.sweep",
  payloadSchema: scheduledJobPayloadSchema,
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: 10 * 60 * 1000,
  concurrency: { global: 1 },
  manualRetry: false
});

export const assetRepoSweepSchedule = defineSchedule({
  kind: assetRepoSweepJob,
  every: ASSET_REPO_SWEEP_INTERVAL_MS
});

/** The subject of the job of one save. */
const saveSubject = (assetId: string, operationRunId: string) => `${assetId}:${operationRunId}`;

type Refused = Extract<AssetRepoCommitResult, { status: "refused" | "failed" }>;

/** An object the ledger or a save names is not the bytes that were recorded for it. */
class NotAsRecorded extends Error {}

/** Reads an object that has `bytes` bytes and the hash `sha256`, and no byte more. */
async function readRecorded(
  objects: ObjectStorage,
  key: string,
  recorded: { bytes: number; sha256: string },
  signal: AbortSignal
): Promise<Uint8Array> {
  if (recorded.bytes > ASSET_REPO_MAX_BUNDLE_BYTES) {
    throw new NotAsRecorded();
  }
  const stored = await objects.get(key).catch(() => {
    throw new NotAsRecorded();
  });
  const hash = createHash("sha256");
  const bytes = new Uint8Array(recorded.bytes);
  let length = 0;
  for await (const chunk of stored.body) {
    signal.throwIfAborted();
    // A longer object is left as soon as it is longer: it is not read to its end.
    if (length + chunk.byteLength > recorded.bytes) {
      throw new NotAsRecorded();
    }
    bytes.set(chunk, length);
    hash.update(chunk);
    length += chunk.byteLength;
  }
  if (length !== recorded.bytes || hash.digest("hex") !== recorded.sha256) {
    throw new NotAsRecorded();
  }
  return bytes;
}

/** Runs `read` over `items`, a few at a time, and keeps their order. */
async function readEach<Item, Read>(
  items: readonly Item[],
  read: (item: Item) => Promise<Read>
): Promise<Read[]> {
  const results: Read[] = [];
  const pending = items.map((item, index) => ({ item, index }));
  await Promise.all(
    Array.from({ length: ASSET_REPO_READ_CONCURRENCY }, async () => {
      for (let next = pending.shift(); next; next = pending.shift()) {
        results[next.index] = await read(next.item);
      }
    })
  );
  return results;
}

/** What the sizes a request names already decide, before a byte is read. */
function requestRefusal(request: AssetRepoCommitRequest): Refused | undefined {
  const { files } = request;
  if (files.length > ASSET_REPO_MAX_FILES) {
    return {
      status: "refused",
      code: "too_many_files",
      message: `The folder holds ${files.length} files. A repository takes at most ${ASSET_REPO_MAX_FILES} (ASSET_REPO_MAX_FILES).`
    };
  }
  const large = files.find((file) => file.byteSize > ASSET_REPO_MAX_FILE_BYTES);
  if (large) {
    return {
      status: "refused",
      code: "file_too_large",
      path: large.path,
      message: `'${large.path}' has ${large.byteSize} bytes. A file has at most ${ASSET_REPO_MAX_FILE_BYTES} (ASSET_REPO_MAX_FILE_BYTES).`
    };
  }
  const total = files.reduce((sum, file) => sum + file.byteSize, 0);
  if (total > ASSET_REPO_MAX_TREE_BYTES) {
    return {
      status: "refused",
      code: "tree_too_large",
      message: `The files have ${assetRepoMib(total)} together. One save may hold at most ${assetRepoMib(ASSET_REPO_MAX_TREE_BYTES)}. Nothing was saved. Remove files or make them smaller, then save again.`
    };
  }
  return undefined;
}

/** The history of the repository is at its limit. Nothing shortens a history yet. */
const HISTORY_TOO_LARGE: Refused = {
  status: "refused",
  code: "history_too_large",
  message: `The stored history of this asset has reached the limit of ${assetRepoMib(ASSET_REPO_MAX_BUNDLE_BYTES)}. Nothing was saved. Until history can be shortened, the way out is a new asset from the current files.`
};

export interface AssetRepoJobsOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  /** The `files` store, where the bundles of repositories are kept. */
  objects: ObjectStorage;
  /** The store of the Execution Workspaces, where the files an agent wrote are. */
  workspaceObjects: ObjectStorage | undefined;
  logger: Logger;
  slots?: number;
  /** Makes the commit in the sandbox. */
  commit: AssetRepoCommitRunner;
  now?: () => Date;
}

/** The handlers of `asset_repo.commit` and `asset_repo.sweep`, for the process that serves them. */
export function createAssetRepoJobs(options: AssetRepoJobsOptions): {
  handlers: RegisteredJobHandler[];
  schedules: JobSchedule[];
} {
  const { clientInstanceId, objects } = options;
  const saves = options.stores.configAssets;
  const now = options.now ?? (() => new Date());

  const commitSave = async (
    save: AssetRepoSave & { request: AssetRepoCommitRequest },
    jobId: string,
    signal: AbortSignal
  ): Promise<AssetRepoCommitResult | undefined> => {
    const { assetId, operationRunId, request } = save;
    const address = { clientInstanceId, assetId, operationRunId };
    const tooLarge = requestRefusal(request);
    if (tooLarge) {
      return tooLarge;
    }
    const source = request.store === "files" ? objects : options.workspaceObjects;
    if (!source) {
      return {
        status: "failed",
        reason: "store",
        message: "This instance has no store of the files to commit."
      };
    }
    // The bundles of the repository, as the ledger names them. Each is read once, to no more
    // than the size the ledger recorded, and its hash is taken over the bytes that are handed
    // to the command. A bundle with other bytes never enters the sandbox.
    const ledger: AssetRepoBundle[] =
      request.baseCommit === null
        ? []
        : await saves.listAssetRepoBundles({ clientInstanceId, assetId });
    // A save reads every bundle of the ledger: the new commit is made in a repository that
    // holds the whole history. What that may weigh is the limit of a repository, so the room
    // a save needs does not grow past it however long the history is.
    const history = ledger.reduce((sum, row) => sum + row.bytes, 0);
    if (history > ASSET_REPO_MAX_BUNDLE_BYTES) {
      return HISTORY_TOO_LARGE;
    }
    if (request.baseCommit !== null && ledger.length === 0) {
      return {
        status: "refused",
        code: "base_unknown",
        message: "The folder was written from a commit of a repository that holds none."
      };
    }
    let bundles: Parameters<AssetRepoCommitRunner>[0]["bundles"];
    try {
      bundles = await readEach(ledger, async (row) => ({
        tip: row.tipCommit,
        prerequisite: row.prerequisiteCommit ?? null,
        sha256: row.sha256,
        bytes: await readRecorded(objects, row.objectKey, row, signal)
      }));
    } catch (error) {
      if (!(error instanceof NotAsRecorded)) {
        throw error;
      }
      return {
        status: "refused",
        code: "bundle_hash_mismatch",
        message:
          "A bundle of the repository is not in the store with the size and the SHA-256 the ledger recorded for it. Nothing was read from it."
      };
    }
    let files: Parameters<AssetRepoCommitRunner>[0]["files"];
    try {
      files = await readEach(request.files, async (file) => ({
        path: file.path,
        bytes: await readRecorded(
          source,
          file.objectKey,
          { bytes: file.byteSize, sha256: file.checksum },
          signal
        )
      }));
    } catch (error) {
      if (!(error instanceof NotAsRecorded)) {
        throw error;
      }
      return {
        status: "failed",
        reason: "store",
        message: "A file of the folder changed or was removed while it was saved. Save again."
      };
    }
    const outcome = await options.commit({
      id: jobId,
      request: {
        base: request.baseCommit,
        author: request.author,
        // The time of the save, which every attempt of its run reads from its row.
        time: Math.floor(Date.parse(save.savedAt) / 1000),
        message: request.message
      },
      files,
      bundles,
      signal
    });
    if (outcome.status === "refused") {
      return outcome;
    }
    if (outcome.status === "failed") {
      options.logger.warn(
        { assetId, operationRunId, reason: outcome.reason, detail: outcome.detail },
        "A commit to the repository of an asset gave no result"
      );
      return { status: "failed", reason: outcome.reason, message: outcome.message };
    }
    const { sha256, bytes, kind, prerequisite } = outcome.bundle;
    // The bundle of this save would be part of the history every later save reads.
    if (history + bytes.byteLength > ASSET_REPO_MAX_BUNDLE_BYTES) {
      return HISTORY_TOO_LARGE;
    }
    const bundle: AssetRepoSaveBundle = {
      objectKey: assetRepoBundleObjectKey({ assetId, commit: outcome.commit, sha256 }),
      kind,
      tipCommit: outcome.commit,
      ...(prerequisite === null ? {} : { prerequisiteCommit: prerequisite }),
      bytes: bytes.byteLength,
      sha256
    };
    // The row names the bundle before the object is put: no object is in the store that no
    // row names, and the sweeper finds every one by its row.
    try {
      await saves.nameAssetRepoSaveBundle({ ...address, bundle });
    } catch (error) {
      const reason = isAppError(error) && isRecord(error.details) ? error.details.reason : "";
      if (reason === "save_not_pending") {
        return undefined;
      }
      if (reason === "pending_bundle_differs" || reason === "bundle_named_by_another_save") {
        return {
          status: "refused",
          code: reason,
          message: isAppError(error) ? error.message : "The save named another bundle before."
        };
      }
      throw error;
    }
    await objects.put(bundle.objectKey, bytes, {
      contentType: "application/octet-stream",
      size: bytes.byteLength
    });
    return {
      status: "committed",
      commit: outcome.commit,
      tree: outcome.tree,
      files: outcome.files,
      bundle: { objectKey: bundle.objectKey, sha256, bytes: bundle.bytes }
    };
  };

  const answer = (control: JobControl, save: AssetRepoSave, result: AssetRepoCommitResult) =>
    control.transaction((stores) =>
      stores.configAssets.answerAssetRepoSave({
        clientInstanceId,
        assetId: save.assetId,
        operationRunId: save.operationRunId,
        result
      })
    );

  return {
    handlers: [
      defineJobHandler({
        kind: assetRepoCommitJob,
        slots: options.slots ?? ASSET_REPO_COMMIT_DEFAULT_SLOTS,
        async run(job, control) {
          const { assetId, operationRunId } = job.payload;
          // The job names its save in the payload, as its subject and, through the asset, as
          // its concurrency key. A job whose three do not agree was not enqueued by a save.
          if (
            !isOperationRunId(operationRunId) ||
            job.subject !== saveSubject(assetId, operationRunId) ||
            job.concurrencyKey !== assetId
          ) {
            control.logger.warn(
              { jobId: job.id },
              "A repository commit job does not name its save"
            );
            return;
          }
          const save = await saves.getAssetRepoSave({ clientInstanceId, assetId, operationRunId });
          // A save with a result, a save that was given up and one that is part of the
          // repository already are finished: nothing is committed or put for them.
          const { request } = save ?? {};
          if (!save || !request || save.state !== "pending" || save.result) {
            return;
          }
          const result = await commitSave({ ...save, request }, job.id, control.signal);
          if (result) {
            await answer(control, save, result);
          }
        },
        async onExhausted(job, stores) {
          const { assetId, operationRunId } = job.payload;
          if (!isOperationRunId(operationRunId)) {
            return;
          }
          await stores.configAssets.answerAssetRepoSave({
            clientInstanceId,
            assetId,
            operationRunId,
            result: {
              status: "failed",
              reason: "crashed",
              message: "The commit did not finish: its worker stopped. Save again."
            }
          });
        }
      }),
      defineJobHandler({
        kind: assetRepoSweepJob,
        slots: 1,
        async run(_job, control) {
          const swept = await saves.sweepAssetRepoSaves({
            olderThan: new Date(now().getTime() - ASSET_REPO_SAVE_MAX_AGE_MS),
            limit: ASSET_REPO_SWEEP_LIMIT,
            async removeObject(object) {
              // The sweeper removes bundles of repositories and nothing else, whatever a
              // row names.
              const prefix = `${assetObjectPrefix(object.assetId)}repo/`;
              if (
                object.clientInstanceId !== clientInstanceId ||
                !object.objectKey.startsWith(prefix) ||
                !object.objectKey.endsWith(".bundle")
              ) {
                throw new Error(
                  "A row of the ledger names an object that is not a bundle of its asset"
                );
              }
              await objects.delete(object.objectKey);
            }
          });
          if (swept.swept > 0 || swept.removed > 0) {
            control.logger.info(swept, "Gave up saves of repositories that did not finish");
          }
        }
      })
    ],
    schedules: [assetRepoSweepSchedule]
  };
}

export interface AssetRepoCommitClientOptions {
  stores: Pick<PlatformStores, "configAssets" | "jobs">;
  waitMs?: number;
  pollIntervalMs?: number;
  /** Replaces `JOB_UNCLAIMED_MS`. For tests. */
  unclaimedMs?: number;
  /** Replaces `JOB_WORKER_CHECK_INTERVAL_MS`. For tests. */
  workerCheckIntervalMs?: number;
}

export interface AssetRepoCommitClient {
  /**
   * Has the commit of one save made and answers how it ended, with the time the commit
   * carries. Called again for the same Operation Run it answers the commit that run made
   * before, or tries again where the attempt before it failed.
   */
  commit(input: {
    clientInstanceId: ClientInstanceId;
    assetId: string;
    operationRunId: OperationRunId;
    request: AssetRepoCommitRequest;
    signal?: AbortSignal;
  }): Promise<{ result: AssetRepoCommitResult; savedAt?: string }>;
}

/** Queues the commit of a save as its pending row and its job, and polls the row. */
export function createAssetRepoCommitClient(
  options: AssetRepoCommitClientOptions
): AssetRepoCommitClient {
  const waitMs = options.waitMs ?? ASSET_REPO_COMMIT_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? ASSET_REPO_COMMIT_POLL_INTERVAL_MS;
  const unclaimedMs = options.unclaimedMs ?? JOB_UNCLAIMED_MS;
  const workerCheckIntervalMs = options.workerCheckIntervalMs ?? JOB_WORKER_CHECK_INTERVAL_MS;
  const saves = options.stores.configAssets;
  return {
    async commit(input) {
      const { clientInstanceId, assetId, operationRunId } = input;
      const address = { clientInstanceId, assetId, operationRunId };
      const begun = await saves.beginAssetRepoSave({ ...address, request: input.request });
      const { savedAt } = begun;
      if (begun.state === "swept") {
        return {
          result: {
            status: "refused",
            code: "save_not_pending",
            message: "This save was given up because it did not finish within a day. Save again."
          }
        };
      }
      if (begun.result && begun.result.status !== "failed") {
        return { result: begun.result, savedAt };
      }
      if (begun.state === "live") {
        return {
          result: {
            status: "refused",
            code: "save_not_pending",
            message: "This save is part of the repository already."
          }
        };
      }
      // The attempt before this one failed, and this one starts over.
      if (begun.result) {
        await saves.answerAssetRepoSave({ ...address, result: null });
      }
      const subject = saveSubject(assetId, operationRunId);
      const dedupeKey = subjectDedupeKey(assetRepoCommitJob.kind, subject);
      await options.stores.jobs.enqueue(
        assetRepoCommitJob,
        { assetId, operationRunId },
        { clientInstanceId, subject, dedupeKey, concurrencyKey: assetId }
      );
      const deadline = Date.now() + waitMs;
      let nextWorkerCheck = Date.now() + unclaimedMs;
      for (;;) {
        const save = await saves.getAssetRepoSave(address);
        if (!save) {
          return {
            result: { status: "failed", reason: "crashed", message: "The save is not available." }
          };
        }
        if (save.result) {
          return { result: save.result, savedAt };
        }
        let noWorker = false;
        if (Date.now() >= nextWorkerCheck) {
          nextWorkerCheck = Date.now() + workerCheckIntervalMs;
          noWorker = await noWorkerTakesJobs(options.stores.jobs, {
            clientInstanceId,
            kind: assetRepoCommitJob,
            unclaimedMs
          }).catch(() => false);
        }
        if (noWorker || input.signal?.aborted || Date.now() >= deadline) {
          const gaveUp: AssetRepoCommitResult =
            input.signal?.aborted && !isOperationTimeout(input.signal)
              ? { status: "failed", reason: "stopped", message: "The save was stopped." }
              : noWorker && !isOperationTimeout(input.signal)
                ? {
                    status: "failed",
                    reason: "no_worker",
                    message:
                      "No workspace command worker takes commits to repositories on this instance. An operator has to start that worker. Nothing was saved."
                  }
                : {
                    status: "failed",
                    reason: "timeout",
                    message:
                      "The commit was not made in time: the workers are busy, or it did not end. Nothing was saved. Save again."
                  };
          // The commit finds a result on its row and answers nothing. Where it was faster,
          // its result is the answer.
          if (await saves.answerAssetRepoSave({ ...address, result: gaveUp })) {
            await options.stores.jobs
              .withdraw(assetRepoCommitJob, { clientInstanceId, dedupeKey })
              .catch(() => undefined);
            return { result: gaveUp, savedAt };
          }
          continue;
        }
        await setTimeout(pollIntervalMs);
      }
    }
  };
}
