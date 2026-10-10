import { createHash } from "node:crypto";
import {
  DEFAULT_PAGE_BUILD_LIMITS,
  runPageBuild,
  type PageBuildLimits,
  type PageBuildOutcome,
  type PageFile
} from "@vivd-catalyst/app-build";
import {
  createPageBuildId,
  defineJobHandler,
  defineJobKind,
  FILE_SET_MAX_FILE_BYTES,
  FILE_SET_MAX_FILES,
  FILE_SET_MAX_TOTAL_BYTES,
  isAppError,
  isPageBuildId,
  readObjectBytes,
  subjectDedupeKey,
  isJsonObject,
  unknownToJsonValue,
  type ClientInstanceId,
  type JobControl,
  type Logger,
  type ObjectStorage,
  type PageBuild,
  type PageBuildClient,
  type PageBuildId,
  type PageBuildSourceFile,
  type PageSaveOutcome,
  type PlatformStores,
  type RegisteredJobHandler
} from "@vivd-catalyst/core";
import { z } from "zod";
import { storePageFileSet } from "./page-file-sets";
import type { ChatServerOptions } from "./types";

// Building a Page when it is saved. The save writes a row with the snapshot of the folder and
// enqueues `page.bundle`; the handler reads the files, has them built in a process of their own
// (`runPageBuild`), stores the file set and writes the result on the row, where the save reads
// it. The handler never loads a file of the Page as code, and neither does the build.

/**
 * The lease of a running build. A worker that was killed is noticed after this long, and the
 * save that waits is told that the build was lost.
 */
export const PAGE_BUNDLE_LEASE_MS = 2 * 60 * 1000;
/** Three heartbeats may fail before the lease runs out. */
export const PAGE_BUNDLE_HEARTBEAT_MS = 30 * 1000;
/**
 * How many builds one worker process runs at once unless told otherwise. A build is one extra
 * process with its own heap for a few seconds, so the number is bound by the memory of the
 * worker's host: at most this many times `PAGE_BUILD_MAX_HEAP_MB`.
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
  /** Replaces the build process. For tests. */
  build?: (input: {
    files: readonly PageFile[];
    signal: AbortSignal;
    limits: Partial<PageBuildLimits>;
  }) => Promise<PageBuildOutcome>;
}

/** The handler of `page.bundle`, for the process that serves it. */
export function createPageBundleJobs(options: PageBundleJobsOptions): {
  handlers: RegisteredJobHandler[];
} {
  const build = options.build ?? runPageBuild;
  const limits = { ...DEFAULT_PAGE_BUILD_LIMITS, ...options.limits };
  const finish = (control: JobControl, buildId: PageBuildId, result: PageSaveOutcome) =>
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
          const row = isPageBuildId(buildId) ? await unfinished(buildId) : undefined;
          if (!row || !isPageBuildId(buildId)) {
            // The save gave up, or the conversation is gone.
            return;
          }
          const snapshot = await readSnapshot(
            options.workspaceObjects,
            row.request.files,
            control.signal
          );
          if (snapshot.status === "refused") {
            await finish(control, buildId, snapshot.result);
            return;
          }
          const outcome = await build({ files: snapshot.files, signal: control.signal, limits });
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
          try {
            const { page, fileSet } = await storePageFileSet(options, {
              conversationId: row.conversationId,
              pageName: row.request.pageName,
              kitVersion: outcome.kitVersion,
              manifest,
              sourceFiles: snapshot.files,
              builtFiles: outcome.files,
              ...(row.request.requestedByUserId
                ? { createdByUserId: row.request.requestedByUserId }
                : {})
            });
            await finish(control, buildId, {
              status: "saved",
              pageId: page.id,
              fileSetId: fileSet.id,
              number: fileSet.number
            });
          } catch (error) {
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

type Snapshot =
  { status: "read"; files: PageFile[] } | { status: "refused"; result: PageSaveOutcome };

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
      result: { status: "failed", message: "This instance has no store of workspace files." }
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
function storeRefusal(error: unknown): PageSaveOutcome | undefined {
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
  stores: Pick<PlatformStores, "pages" | "transaction">;
  waitMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
}

/**
 * Queues a build as its row and the `page.bundle` job, in one transaction, and polls the row
 * for the result. The row is removed when the save has its answer.
 */
export function createPageBuildClient(options: PageBuildClientOptions): PageBuildClient {
  const waitMs = options.waitMs ?? PAGE_BUILD_WAIT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? PAGE_BUILD_POLL_INTERVAL_MS;
  const now = options.now ?? (() => new Date());
  return {
    async build(input) {
      const buildId = createPageBuildId();
      const address = { clientInstanceId: input.clientInstanceId, buildId };
      await options.stores.transaction(async (tx) => {
        await tx.pages.createPageBuild({
          clientInstanceId: input.clientInstanceId,
          id: buildId,
          conversationId: input.conversationId,
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
            concurrencyKey: input.conversationId
          }
        );
      });
      const deadline = Math.min(
        Date.now() + waitMs,
        input.deadline?.getTime() ?? Number.POSITIVE_INFINITY
      );
      try {
        for (;;) {
          const row = await options.stores.pages.getPageBuild(address);
          if (!row) {
            return { status: "failed", message: "The conversation of the Page is not available." };
          }
          if (row.result) {
            return row.result;
          }
          if (input.signal?.aborted || Date.now() >= deadline) {
            const gaveUp: PageSaveOutcome = {
              status: "failed",
              message: input.signal?.aborted
                ? "The save was stopped before the Page was built."
                : "The Page was not built in time. No worker took the build, or it is still queued behind others. Save the Page again."
            };
            // The build finds a result on its row and stores nothing. When it was faster, its
            // result is the answer.
            const written = await options.stores.pages.finishPageBuild({
              ...address,
              result: gaveUp,
              finishedAt: now().toISOString()
            });
            if (written) {
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
