import { createHash } from "node:crypto";
import {
  htmlTitle,
  PAGE_MANIFEST_FILE,
  plainHtmlManifestFile,
  type PageBuildLimits,
  type PageFile
} from "@work-shape/catalyst-app-build";
import {
  createPageBuildId,
  defineJobHandler,
  defineJobKind,
  FILE_SET_MAX_FILE_BYTES,
  FILE_SET_MAX_FILES,
  FILE_SET_MAX_TOTAL_BYTES,
  fileSetObjectPrefix,
  isAppError,
  isOperationTimeout,
  isPageBuildId,
  JOB_UNCLAIMED_MS,
  JOB_WORKER_CHECK_INTERVAL_MS,
  noWorkerTakesJobs,
  readObjectBytes,
  subjectDedupeKey,
  isJsonObject,
  unknownToJsonValue,
  type JsonObject,
  type ClientInstanceId,
  type JobControl,
  type Logger,
  type ObjectStorage,
  type AssetBuildClient,
  type AssetBuildOutcome,
  type PageBuild,
  type PageBuildClient,
  type PageBuildFailure,
  type PageBuildId,
  type PageBuildResult,
  type PageBuildSourceFile,
  type PlatformStores,
  type RegisteredJobHandler
} from "@work-shape/catalyst-core";
import { z } from "zod";
import type { PageBuildRunner } from "./page-build-sandbox";
import { storeAssetFileSet, storePageFileSet } from "./page-file-sets";
import type { ChatServerOptions } from "../types";

// Building a Page when it is saved. The save writes a row with the snapshot of the folder and
// enqueues `page.bundle`; the handler reads the files, has them built by a command in the
// sandbox (`createSandboxPageBuild`), stores the file set and writes the result on the row,
// where the save reads it. The handler never loads a file of the Page as code. The process that
// serves the kind is the workspace command worker, the one process that reaches the sandbox.
//
// A write of an asset whose revisions hold files builds through the same job. Its source files
// lie in the `files` store, below the prefix of the file set the write named, and the build
// stores that file set for the asset. The write itself makes the revision.

/**
 * The lease of a running build. A worker that was killed is noticed after this long, and the
 * save that waits is told that the build was lost.
 */
export const PAGE_BUNDLE_LEASE_MS = 2 * 60 * 1000;
/** Three heartbeats may fail before the lease runs out. */
export const PAGE_BUNDLE_HEARTBEAT_MS = 30 * 1000;
/**
 * How many builds one worker process runs at once unless told otherwise. A build is one
 * container for a few seconds, so the number is bound by the memory of the sandbox's host: at
 * most this many times the memory the sandbox gives a command.
 */
export const PAGE_BUNDLE_DEFAULT_SLOTS = 2;
/** How many files of a snapshot are read from the object store at a time. */
const PAGE_BUNDLE_READ_CONCURRENCY = 8;
/** How often a save looks at its build's row. */
export const PAGE_BUILD_POLL_INTERVAL_MS = 250;
/**
 * How long a save waits for its build: the time a build may take, the time until a lost worker
 * is noticed, and room for builds queued before it. After it the save fails and the build is
 * told to store nothing.
 */
export const PAGE_BUILD_WAIT_MS = 5 * 60 * 1000;
/**
 * How long a write of an asset's files waits for its build. The write is one HTTP call, so the
 * wait is shorter than a save's: past it the call answers `build_timeout`, which its caller
 * repeats, and the build is told to store nothing.
 */
export const APP_BUILD_WAIT_MS = 60_000;
/** What a save is told when its build did not end within the wait although workers take builds. */
export const PAGE_BUILD_BUSY_MESSAGE =
  "The Page was not built in time: the workers that build Pages are busy with other builds, or its build did not end. Nothing was saved. Save the Page again.";
/** What a save is told when no worker takes builds. */
export const PAGE_BUILD_NO_WORKER_MESSAGE =
  "No workspace command worker takes Page builds on this instance: the build was not started. An operator has to start that worker. Nothing was saved.";

/** Ends the transaction that would publish a revision for a save that has its answer already. */
class BuildAlreadyAnswered extends Error {}

/**
 * Builds one Page. One attempt: a build that failed half way is reported to the agent, which
 * saves again. One build per conversation at a time, in the order saved. No retry by hand:
 * the save that waited is gone by then.
 */
export const pageBundleJob = defineJobKind({
  kind: "page.bundle",
  payloadSchema: z.object({ buildId: z.string().min(1) }),
  maxAttempts: 1,
  backoff: { baseMs: 0, maxMs: 0 },
  leaseMs: PAGE_BUNDLE_LEASE_MS,
  heartbeatMs: PAGE_BUNDLE_HEARTBEAT_MS,
  concurrency: { perKey: 1 },
  manualRetry: false
});

export interface PageBundleJobsOptions {
  clientInstanceId: ClientInstanceId;
  stores: PlatformStores;
  /** The `files` store, where file sets are kept. */
  pages: NonNullable<ChatServerOptions["pages"]>;
  /**
   * The `workspaces` store, where the files an agent wrote are. An instance without Execution
   * Workspaces has none, and no save that could name a file of one.
   */
  workspaceObjects: ObjectStorage | undefined;
  logger: Logger;
  slots?: number;
  limits?: Partial<PageBuildLimits>;
  /** Builds the files in the sandbox. */
  build: PageBuildRunner;
}

/** The handler of `page.bundle`, for the process that serves it. */
export function createPageBundleJobs(options: PageBundleJobsOptions): {
  handlers: RegisteredJobHandler[];
} {
  const { build, limits } = options;
  const finish = (control: JobControl, buildId: PageBuildId, result: PageBuildResult) =>
    control.transaction((stores) =>
      stores.pages.finishPageBuild({
        clientInstanceId: options.clientInstanceId,
        buildId,
        result,
        finishedAt: new Date().toISOString()
      })
    );
  const unfinished = async (buildId: PageBuildId): Promise<PageBuild | undefined> => {
    const row = await options.stores.pages.getPageBuild({
      clientInstanceId: options.clientInstanceId,
      buildId
    });
    return row && !row.result ? row : undefined;
  };

  return {
    handlers: [
      defineJobHandler({
        kind: pageBundleJob,
        slots: options.slots ?? PAGE_BUNDLE_DEFAULT_SLOTS,
        async run(job, control) {
          const { buildId } = job.payload;
          // The job names its build three times: in the payload, as its subject and, through
          // the conversation, as its concurrency key. A job whose three do not agree was not
          // enqueued by a save, and nothing is done for it.
          if (!isPageBuildId(buildId) || job.subject !== buildId) {
            control.logger.warn({ jobId: job.id }, "A Page build job does not name its subject");
            return;
          }
          // A build with a result is finished: this is a job delivered again after the worker
          // that published stopped, or a save that gave up. Neither builds or stores anything.
          const row = await unfinished(buildId);
          if (!row) {
            return;
          }
          const { asset } = row.request;
          const { conversationId } = row;
          const key = asset ? asset.assetId : conversationId;
          if (key === undefined || job.concurrencyKey !== key) {
            control.logger.warn({ jobId: job.id }, "A Page build job is queued for another key");
            return;
          }
          // The files of an asset's write lie in the `files` store, where the write put them.
          const snapshot = await readSnapshot(
            asset ? options.pages.objects : options.workspaceObjects,
            row.request.files,
            control.signal
          );
          if (snapshot.status === "refused") {
            await finish(control, buildId, snapshot.result);
            return;
          }
          // An HTML file opened from a folder without a manifest is built as plain HTML.
          const { entry } = row.request;
          const plainEntry =
            entry !== undefined && !snapshot.files.some((file) => file.path === PAGE_MANIFEST_FILE)
              ? entry
              : undefined;
          const files =
            plainEntry === undefined
              ? snapshot.files
              : [...snapshot.files, plainHtmlManifestFile(plainEntry)];
          const outcome = await build({
            id: buildId,
            files,
            signal: control.signal,
            ...(limits ? { limits } : {})
          });
          if (outcome.status === "errors") {
            await finish(control, buildId, { status: "errors", errors: outcome.errors });
            return;
          }
          if (outcome.status === "failed") {
            control.logger.warn(
              { buildId, reason: outcome.reason, detail: outcome.detail },
              "A Page build gave no result"
            );
            await finish(control, buildId, { status: "failed", message: outcome.message });
            return;
          }
          const manifest = unknownToJsonValue(outcome.manifest);
          if (!isJsonObject(manifest) || !(await unfinished(buildId))) {
            return;
          }
          const content = {
            kitVersion: outcome.kitVersion,
            manifest,
            sourceFiles: files,
            builtFiles: outcome.files,
            signal: control.signal,
            ...(row.request.requestedByUserId
              ? { createdByUserId: row.request.requestedByUserId }
              : {})
          };
          try {
            if (asset) {
              // The source files are where the write put them: only the built ones are written.
              // The file set and the result of the build are one write, as below.
              await storeAssetFileSet(
                options,
                {
                  ...content,
                  assetId: asset.assetId,
                  fileSetId: asset.fileSetId,
                  writes: ["dist"]
                },
                (create) =>
                  control.transaction(async (stores) => {
                    const fileSet = await create(stores);
                    const written = await stores.pages.finishPageBuild({
                      clientInstanceId: options.clientInstanceId,
                      buildId,
                      result: { status: "stored", fileSetId: fileSet.id },
                      finishedAt: new Date().toISOString()
                    });
                    if (!written) {
                      throw new BuildAlreadyAnswered();
                    }
                    return fileSet;
                  })
              ).catch(async (error: unknown) => {
                // The write that asked for this build gave up or was refused: nothing names
                // the file set, so what this build wrote of it goes.
                await options.pages.objects
                  .deletePrefix(
                    fileSetObjectPrefix({ kind: "asset", id: asset.assetId }, asset.fileSetId)
                  )
                  .catch(() => undefined);
                throw error;
              });
              return;
            }
            if (conversationId === undefined) {
              return;
            }
            // The plain HTML manifest names its entry file, which is no name to keep.
            const title =
              plainEntry === undefined
                ? manifestName(manifest)
                : openedHtmlTitle(snapshot.files, plainEntry);
            await storePageFileSet(
              options,
              {
                conversationId,
                pageName: row.request.pageName,
                ...content
              },
              // The revision and the result of the build are one write. It happens while this
              // attempt holds the job, and only when the build has no result yet: a save that
              // gave up meanwhile gets no revision, and a second delivery of the job finds the
              // result and publishes nothing.
              (create, page) =>
                control.transaction(async (stores) => {
                  const fileSet = await create(stores);
                  const written = await stores.pages.finishPageBuild({
                    clientInstanceId: options.clientInstanceId,
                    buildId,
                    result: {
                      status: "saved",
                      pageId: page.id,
                      fileSetId: fileSet.id,
                      number: fileSet.number,
                      ...(title === undefined ? {} : { title })
                    },
                    finishedAt: new Date().toISOString()
                  });
                  if (!written) {
                    throw new BuildAlreadyAnswered();
                  }
                  return fileSet;
                })
            );
          } catch (error) {
            if (error instanceof BuildAlreadyAnswered) {
              return;
            }
            const refusal = storeRefusal(error);
            if (!refusal) {
              throw error;
            }
            await finish(control, buildId, refusal);
          }
        },
        async onExhausted(job, stores) {
          const { buildId } = job.payload;
          if (!isPageBuildId(buildId)) {
            return;
          }
          await stores.pages.finishPageBuild({
            clientInstanceId: options.clientInstanceId,
            buildId,
            result: {
              status: "failed",
              message: "The build did not finish: its worker stopped. Save the Page again."
            },
            finishedAt: new Date().toISOString()
          });
        }
      })
    ]
  };
}

type BuildRefusal = Extract<PageBuildResult, { status: "errors" | "failed" }>;

type Snapshot = { status: "read"; files: PageFile[] } | { status: "refused"; result: BuildRefusal };

/**
 * Reads the files of a snapshot. The limits of a file set are checked on the sizes the snapshot
 * names before a byte is read, and each file is checked against the size and hash it was
 * snapshotted with, so the build sees the folder as it was at the save.
 */
async function readSnapshot(
  objects: ObjectStorage | undefined,
  files: readonly PageBuildSourceFile[],
  signal: AbortSignal
): Promise<Snapshot> {
  if (!objects) {
    return {
      status: "refused",
      result: { status: "failed", message: "This instance has no store of the files to build." }
    };
  }
  const total = files.reduce((sum, file) => sum + file.byteSize, 0);
  const tooLarge = files.find((file) => file.byteSize > FILE_SET_MAX_FILE_BYTES);
  if (files.length > FILE_SET_MAX_FILES || total > FILE_SET_MAX_TOTAL_BYTES || tooLarge) {
    return {
      status: "refused",
      result: {
        status: "errors",
        errors: [
          {
            file: tooLarge?.path ?? "app.yaml",
            code: "file_set_too_large",
            message: `The folder has ${files.length} files and ${total} bytes. A Page holds at most ${FILE_SET_MAX_FILES} files (FILE_SET_MAX_FILES) of at most ${FILE_SET_MAX_FILE_BYTES} bytes each (FILE_SET_MAX_FILE_BYTES) and ${FILE_SET_MAX_TOTAL_BYTES} bytes together (FILE_SET_MAX_TOTAL_BYTES), source and built files counted together.`
          }
        ]
      }
    };
  }
  const read: PageFile[] = [];
  const changed: string[] = [];
  const pending = files.map((file, index) => ({ file, index }));
  await Promise.all(
    Array.from({ length: PAGE_BUNDLE_READ_CONCURRENCY }, async () => {
      for (let next = pending.shift(); next; next = pending.shift()) {
        signal.throwIfAborted();
        const bytes = await readObjectBytes(objects, next.file.objectKey).catch(() => undefined);
        if (
          !bytes ||
          bytes.byteLength !== next.file.byteSize ||
          createHash("sha256").update(bytes).digest("hex") !== next.file.checksum
        ) {
          changed.push(next.file.path);
          continue;
        }
        read[next.index] = { path: next.file.path, bytes };
      }
    })
  );
  if (changed.length > 0) {
    return {
      status: "refused",
      result: {
        status: "failed",
        message: `The file '${changed.sort()[0]}' changed or was removed while the Page was saved. Save the Page again.`
      }
    };
  }
  return { status: "read", files: read };
}

/** What the store said when it refused a built Page, as the result of the save. */
function storeRefusal(error: unknown): BuildRefusal | undefined {
  if (!isAppError(error)) {
    return undefined;
  }
  if (error.code === "NOT_FOUND") {
    return { status: "failed", message: "The conversation of the Page is not available." };
  }
  if (error.code !== "VALIDATION_FAILED") {
    return undefined;
  }
  const details = isRecord(error.details) ? error.details : {};
  return {
    status: "errors",
    errors: [
      {
        file: typeof details.file === "string" ? details.file : "app.yaml",
        message: error.message,
        ...(typeof details.reason === "string" ? { code: details.reason } : {})
      }
    ]
  };
}

export interface PageBuildClientOptions {
  stores: Pick<PlatformStores, "pages" | "jobs" | "transaction">;
  waitMs?: number;
  /** Replaces `APP_BUILD_WAIT_MS`, the wait of the build of an asset's files. For tests. */
  assetWaitMs?: number;
  /** Replaces `JOB_UNCLAIMED_MS`. For tests. */
  unclaimedMs?: number;
  /** Replaces `JOB_WORKER_CHECK_INTERVAL_MS`. For tests. */
  workerCheckIntervalMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
}

/**
 * Queues a build as its row and the `page.bundle` job, in one transaction, and polls the row
 * for the result. The row is removed when the save has its answer.
 */
export function createPageBuildClient(
  options: PageBuildClientOptions
): PageBuildClient & AssetBuildClient {
  const waitMs = options.waitMs ?? PAGE_BUILD_WAIT_MS;
  const assetWaitMs = options.assetWaitMs ?? APP_BUILD_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? PAGE_BUILD_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  const unclaimedMs = options.unclaimedMs ?? JOB_UNCLAIMED_MS;
  const workerCheckIntervalMs = options.workerCheckIntervalMs ?? JOB_WORKER_CHECK_INTERVAL_MS;
  /** Queues one build and waits for how it ended. `key` orders the builds of one owner. */
  const run = async (input: {
    clientInstanceId: ClientInstanceId;
    conversationId?: PageBuild["conversationId"];
    key: string;
    request: PageBuild["request"];
    waitMs: number;
    signal?: AbortSignal;
    deadline?: Date;
  }): Promise<PageBuildResult> => {
    {
      const buildId = createPageBuildId();
      const address = { clientInstanceId: input.clientInstanceId, buildId };
      await options.stores.transaction(async (tx) => {
        await tx.pages.createPageBuild({
          clientInstanceId: input.clientInstanceId,
          id: buildId,
          ...(input.conversationId ? { conversationId: input.conversationId } : {}),
          request: input.request,
          createdAt: now().toISOString()
        });
        await tx.jobs.enqueue(
          pageBundleJob,
          { buildId },
          {
            clientInstanceId: input.clientInstanceId,
            subject: buildId,
            dedupeKey: subjectDedupeKey(pageBundleJob.kind, buildId),
            concurrencyKey: input.key
          }
        );
      });
      const deadline = Math.min(
        Date.now() + input.waitMs,
        input.deadline?.getTime() ?? Number.POSITIVE_INFINITY
      );
      let nextWorkerCheck = Date.now() + unclaimedMs;
      try {
        for (;;) {
          const row = await options.stores.pages.getPageBuild(address);
          if (!row) {
            return { status: "failed", message: "The build is not available any more." };
          }
          if (row.result) {
            return row.result;
          }
          let noWorker = false;
          if (Date.now() >= nextWorkerCheck) {
            nextWorkerCheck = Date.now() + workerCheckIntervalMs;
            noWorker = await noWorkerTakesJobs(options.stores.jobs, {
              clientInstanceId: input.clientInstanceId,
              kind: pageBundleJob,
              unclaimedMs
            }).catch(() => false);
          }
          if (noWorker || input.signal?.aborted || Date.now() >= deadline) {
            const gaveUp: PageBuildFailure =
              input.signal?.aborted && !isOperationTimeout(input.signal)
                ? {
                    status: "failed",
                    reason: "stopped",
                    message: "The save was stopped before the Page was built."
                  }
                : noWorker && !isOperationTimeout(input.signal)
                  ? { status: "failed", reason: "no_worker", message: PAGE_BUILD_NO_WORKER_MESSAGE }
                  : { status: "failed", reason: "timeout", message: PAGE_BUILD_BUSY_MESSAGE };
            // The build finds a result on its row and stores nothing. When it was faster, its
            // result is the answer.
            const written = await options.stores.pages.finishPageBuild({
              ...address,
              result: gaveUp,
              finishedAt: now().toISOString()
            });
            if (written) {
              // A build no worker claimed yet is withdrawn. One that runs finds the result on
              // its row and stores nothing.
              await options.stores.jobs
                .withdraw(pageBundleJob, {
                  clientInstanceId: input.clientInstanceId,
                  dedupeKey: subjectDedupeKey(pageBundleJob.kind, buildId)
                })
                .catch(() => undefined);
              return gaveUp;
            }
            continue;
          }
          await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
      } finally {
        await options.stores.pages.deletePageBuild(address).catch(() => undefined);
      }
    }
  };
  /** A build row holds the result of its own kind of build. Another one is no result. */
  const foreign: PageBuildFailure = {
    status: "failed",
    message: "The build ended with a result of another kind of build."
  };
  return {
    async build(input) {
      const result = await run({
        ...input,
        key: input.conversationId,
        waitMs
      });
      return result.status === "stored" ? foreign : result;
    },
    async buildAsset(input): Promise<AssetBuildOutcome> {
      const result = await run({
        ...input,
        key: input.request.asset.assetId,
        waitMs: assetWaitMs
      });
      return result.status === "saved" ? foreign : result;
    }
  };
}

/** The name a folder's own manifest gives it. The build checked that it is text. */
function manifestName(manifest: JsonObject): string | undefined {
  return typeof manifest.name === "string" ? manifest.name : undefined;
}

/** What the `<title>` of the HTML file a plain folder opens says. */
function openedHtmlTitle(files: readonly PageFile[], entry: string): string | undefined {
  const html = files.find((file) => file.path === entry);
  return html === undefined ? undefined : htmlTitle(html.bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
