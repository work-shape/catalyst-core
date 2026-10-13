import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  assetRepoSweepJob,
  createAssetRepoCommitClient,
  createAssetRepoJobs,
  createSandboxAssetRepo,
  type AssetRepoCommitRunner
} from "@vivd-catalyst/chat-server";
import { ASSET_REPO_MAX_BUNDLE_BYTES } from "@vivd-catalyst/asset-repo";
import {
  createPlatformId,
  readObjectBytes,
  scheduleDedupeKey,
  type AssetRepoCommitRequest,
  type AssetRepoCommitResult,
  type JobWorker,
  type Logger,
  type OperationRunId
} from "@vivd-catalyst/core";
import { createPostgresJobWorker } from "@vivd-catalyst/postgres-store";
import { LocalWorkspaceCommandProcessExecutor } from "@vivd-catalyst/tool-execution";
import { assetRepoCommandFromSource } from "./support/asset-repo";
import { runId } from "./support/asset-repo-ledger";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { usePostgresSuite } from "./support/postgres-suite";

// The first caller of the repository store, against a real Postgres, the executor's job worker
// and the command with the git of this machine: a save has its commit made by the job, the
// bundle is named on the pending row before its object is put, the bundles of the ledger are
// read with their hash checked before the command sees them, and the sweeper removes what a
// save that never finished left.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silent;
  }
};
const encoder = new TextEncoder();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** A store that tells the test what the ledger held when an object was put. */
class WatchedObjectStorage extends MemoryObjectStorage {
  beforePut: ((key: string) => Promise<void>) | undefined;
  override async put(...args: Parameters<MemoryObjectStorage["put"]>): Promise<void> {
    await this.beforePut?.(args[0]);
    await super.put(...args);
  }
}

describe("the commit of a save of an asset's repository as a job", () => {
  const db = usePostgresSuite("asset_repo_jobs");
  let scratch: string;
  let command: string;
  const workers: JobWorker[] = [];

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "asset-repo-jobs-test-"));
    command = `'${process.execPath}' '${await assetRepoCommandFromSource()}'`;
  });
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  function arrange(
    label: string,
    options: {
      worker?: boolean;
      now?: () => Date;
      unclaimedMs?: number;
      /** Makes the commits in place of the command. */
      commit?: AssetRepoCommitRunner;
    } = {}
  ) {
    const clientInstanceId = db.clientInstance(label);
    const assetId = createPlatformId("cfga");
    const objects = new WatchedObjectStorage();
    const sandboxed = createSandboxAssetRepo({
      sandbox: new LocalWorkspaceCommandProcessExecutor(),
      tempRoot: join(scratch, label),
      command
    });
    let commits = 0;
    const commit: AssetRepoCommitRunner = (input) => {
      commits += 1;
      return (options.commit ?? sandboxed)(input);
    };
    const jobs = createAssetRepoJobs({
      clientInstanceId,
      stores: db.store,
      objects,
      workspaceObjects: undefined,
      logger: silent,
      commit,
      ...(options.now ? { now: options.now } : {})
    });
    const worker = createPostgresJobWorker({
      stores: db.store,
      clientInstanceId,
      logger: silent,
      handlers: jobs.handlers
    });
    workers.push(worker);
    if (options.worker !== false) {
      worker.start();
    }
    const client = createAssetRepoCommitClient({
      stores: db.store,
      pollIntervalMs: 20,
      ...(options.unclaimedMs === undefined
        ? {}
        : { unclaimedMs: options.unclaimedMs, workerCheckIntervalMs: 20, waitMs: 5_000 })
    });
    /** Puts the files of a folder where a write of an asset's files puts them. */
    const folder = async (
      contents: Record<string, string>,
      baseCommit: string | null
    ): Promise<AssetRepoCommitRequest> => {
      const files = [];
      for (const [path, text] of Object.entries(contents)) {
        const bytes = encoder.encode(text);
        const objectKey = `assets/${assetId}/incoming/${sha256(bytes)}`;
        await objects.put(objectKey, bytes);
        files.push({ path, objectKey, byteSize: bytes.byteLength, checksum: sha256(bytes) });
      }
      return { store: "files", files, baseCommit, author: "usr_author", message: "Save rates" };
    };
    const save = (request: AssetRepoCommitRequest, operationRunId: OperationRunId = runId()) =>
      client
        .commit({ clientInstanceId, assetId, operationRunId, request })
        .then((answer) => ({ ...answer, operationRunId }));
    /** The write of the revision that names the commit: what the caller does with a result. */
    const write = (
      result: AssetRepoCommitResult,
      operationRunId: OperationRunId,
      base: { revision: number | null; commit: string | null }
    ) => {
      if (result.status !== "committed") {
        throw new Error(`Not committed: ${JSON.stringify(result)}`);
      }
      return db.store.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "app:rates": base.revision },
        repositoryObjectSize: (key) => objects.head(key).then((head) => head.size),
        mutations: [
          {
            type: "upsert",
            kind: "app",
            name: "rates",
            config: { name: "rates" },
            draft: true,
            assetId,
            repository: {
              commit: result.commit,
              tree: result.tree,
              baseCommit: base.commit,
              operationRunId,
              bundle: result.bundle
            }
          }
        ]
      });
    };
    const rows = () =>
      db.sql<{ state: string; object_key: string | null; request: unknown; result: unknown }[]>`
        select state, object_key, request, result from asset_repo_bundles
        where asset_id = ${assetId} order by created_at, object_key`;
    return {
      clientInstanceId,
      assetId,
      objects,
      worker,
      folder,
      save,
      write,
      rows,
      commits: () => commits
    };
  }

  function committed(result: AssetRepoCommitResult) {
    if (result.status !== "committed") {
      throw new Error(`Not committed: ${JSON.stringify(result)}`);
    }
    return result;
  }

  it("makes the commit, names its bundle before the object is put, and the revision takes it", async () => {
    const { assetId, clientInstanceId, objects, folder, save, write, rows } = arrange("commit");
    const seen: { key: string; named: (string | null)[] }[] = [];
    objects.beforePut = async (key) => {
      if (key.endsWith(".bundle")) {
        seen.push({ key, named: (await rows()).map((row) => row.object_key) });
      }
    };
    const first = await save(await folder({ "app.yaml": "name: rates\n", "a.txt": "1" }, null));
    const one = committed(first.result);
    expect(one.files).toBe(2);
    // When the object was put, its row named it.
    expect(seen).toEqual([{ key: one.bundle.objectKey, named: [one.bundle.objectKey] }]);
    expect(sha256(await readObjectBytes(objects, one.bundle.objectKey))).toBe(one.bundle.sha256);
    expect(await rows()).toMatchObject([{ state: "pending", request: null }]);
    await write(first.result, first.operationRunId, { revision: null, commit: null });

    // The second save stands on the first: the bundle of the ledger is read and handed over.
    const second = await save(
      await folder({ "app.yaml": "name: rates\n", "a.txt": "2" }, one.commit)
    );
    const two = committed(second.result);
    expect(two.commit).not.toBe(one.commit);
    await write(second.result, second.operationRunId, { revision: 1, commit: one.commit });
    expect(
      await db.store.configAssets.listAssetRepoBundles({ clientInstanceId, assetId })
    ).toMatchObject([
      { sequence: 1, kind: "full", tipCommit: one.commit, objectKey: one.bundle.objectKey },
      {
        sequence: 2,
        kind: "incremental",
        tipCommit: two.commit,
        prerequisiteCommit: one.commit,
        objectKey: two.bundle.objectKey
      }
    ]);
    const draft = await db.store.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name: "rates"
    });
    expect(draft).toMatchObject({ revision: 2, commit: two.commit, tree: two.tree });
    // The files of a save are not kept on its row once it ended.
    expect((await rows()).map((row) => row.request)).toEqual([null, null]);
  }, 60_000);

  // Fails where the worker hands the command whatever the store holds under the key.
  it("starts no command for a bundle that is not the bytes the ledger recorded", async () => {
    const { objects, folder, save, write, commits } = arrange("hash");
    const first = await save(await folder({ "a.txt": "1" }, null));
    const one = committed(first.result);
    await write(first.result, first.operationRunId, { revision: null, commit: null });
    const original = await readObjectBytes(objects, one.bundle.objectKey);
    const sameSize = new Uint8Array(original);
    sameSize[sameSize.byteLength - 1] = (sameSize[sameSize.byteLength - 1] ?? 0) ^ 1;
    const longer = new Uint8Array(original.byteLength + 1);
    longer.set(original);
    for (const bytes of [sameSize, longer, original.subarray(0, original.byteLength - 1)]) {
      await objects.put(one.bundle.objectKey, bytes);
      const before = commits();
      const next = await save(await folder({ "a.txt": "2" }, one.commit));
      expect(next.result).toMatchObject({ status: "refused", code: "bundle_hash_mismatch" });
      expect(commits()).toBe(before);
    }
    await objects.delete(one.bundle.objectKey);
    expect((await save(await folder({ "a.txt": "2" }, one.commit))).result).toMatchObject({
      status: "refused",
      code: "bundle_hash_mismatch"
    });
    // With the bytes the ledger recorded the same save is made.
    await objects.put(one.bundle.objectKey, original);
    expect((await save(await folder({ "a.txt": "2" }, one.commit))).result).toMatchObject({
      status: "committed"
    });
  }, 60_000);

  it("builds the same commit when its Operation Run tries again after a stop, and the sweeper removes what never finished", async () => {
    let now = new Date();
    const { assetId, objects, folder, save, write, rows, clientInstanceId } = arrange("retry", {
      now: () => now
    });
    const request = await folder({ "a.txt": "1" }, null);
    // The first attempt stops after its object is in the store and before it answers.
    let stopped = 0;
    const put = objects.put.bind(objects);
    objects.put = async (...args) => {
      await put(...args);
      if (args[0].endsWith(".bundle") && stopped === 0) {
        stopped += 1;
        throw new Error("the worker stopped");
      }
    };
    const operationRunId = runId();
    const first = await save(request, operationRunId);
    expect(first.result).toMatchObject({ status: "failed", reason: "crashed" });
    const [left] = await rows();
    expect(left).toMatchObject({ state: "pending" });
    expect(objects.has(left?.object_key ?? "")).toBe(true);
    // The draft did not move: there is no asset yet.
    expect(
      await db.store.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name: "rates" })
    ).toBeUndefined();

    // A second later the same run tries again and builds the commit of the time of its row.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const again = await save(request, operationRunId);
    const result = committed(again.result);
    expect(result.bundle.objectKey).toBe(left?.object_key);
    expect(again.savedAt).toBe(first.savedAt);
    expect(await rows()).toHaveLength(1);
    await write(again.result, operationRunId, { revision: null, commit: null });

    // A save that is committed and never written as a revision is given up a day later.
    const orphan = committed((await save(await folder({ "a.txt": "2" }, result.commit))).result);
    expect(objects.has(orphan.bundle.objectKey)).toBe(true);
    const sweep = async () => {
      await db.store.jobs.enqueue(
        assetRepoSweepJob,
        {},
        { clientInstanceId, dedupeKey: scheduleDedupeKey(assetRepoSweepJob.kind) }
      );
      for (let waited = 0; waited < 200; waited += 1) {
        const [tick] = await db.sql<{ n: number }[]>`
          select count(*)::int as n from platform_jobs
          where client_instance_id = ${clientInstanceId} and kind = ${assetRepoSweepJob.kind}
            and status in ('queued', 'running')`;
        if (!tick?.n) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error("The sweep did not end");
    };
    await sweep();
    expect(objects.has(orphan.bundle.objectKey)).toBe(true);
    now = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await sweep();
    expect(objects.has(orphan.bundle.objectKey)).toBe(false);
    expect(objects.has(result.bundle.objectKey)).toBe(true);
    // Its row is gone with it: the clock of this test is a day past the moment it was swept.
    expect((await rows()).map((row) => row.state)).toEqual(["live"]);
    expect(
      await db.store.configAssets.listAssetRepoBundles({ clientInstanceId, assetId })
    ).toHaveLength(1);
  }, 60_000);

  it("answers the commit's refusal with the path and keeps it for the run", async () => {
    const { folder, save, commits, rows, objects } = arrange("refused");
    const operationRunId = runId();
    const request = await folder({ "a.txt": "1", ".git/config": "[core]\n" }, null);
    const first = await save(request, operationRunId);
    expect(first.result).toMatchObject({
      status: "refused",
      code: "path_refused",
      path: ".git/config"
    });
    expect(await rows()).toMatchObject([{ state: "pending", object_key: null }]);
    const before = commits();
    expect((await save(request, operationRunId)).result).toEqual(first.result);
    expect(commits()).toBe(before);
    // A file that is not what the save recorded is no refusal of the folder: the save failed.
    const changed = await folder({ "b.txt": "1" }, null);
    await objects.put(changed.files[0]?.objectKey ?? "", encoder.encode("2"));
    expect((await save(changed)).result).toMatchObject({ status: "failed", reason: "store" });
    // A folder larger than a repository takes is refused on the sizes it names alone.
    const large = await folder({ "c.txt": "1" }, null);
    const [file] = large.files;
    expect(
      (await save({ ...large, files: file ? [{ ...file, byteSize: 3 * 1024 * 1024 }] : [] })).result
    ).toMatchObject({ status: "refused", code: "file_too_large", path: "c.txt" });
  }, 60_000);

  it("refuses a save that would leave more history than a repository takes, and puts nothing", async () => {
    const { objects, folder, save, rows } = arrange("history", {
      commit: async () => ({
        status: "committed",
        commit: "a".repeat(40),
        tree: "b".repeat(40),
        files: 1,
        bundle: {
          kind: "full",
          prerequisite: null,
          sha256: "c".repeat(64),
          bytes: new Uint8Array(ASSET_REPO_MAX_BUNDLE_BYTES + 1)
        }
      })
    });

    const { result } = await save(await folder({ "a.txt": "1" }, null));

    expect(result).toMatchObject({
      status: "refused",
      code: "history_too_large",
      message: expect.stringContaining("ASSET_REPO_MAX_BUNDLE_BYTES")
    });
    expect(objects.keys().filter((key) => key.endsWith(".bundle"))).toEqual([]);
    expect(await rows()).toMatchObject([{ state: "pending", object_key: null }]);
  });

  it("says that no worker takes commits, and the run can try again", async () => {
    const waiting = arrange("no-worker", { worker: false, unclaimedMs: 100 });
    const operationRunId = runId();
    const request = await waiting.folder({ "a.txt": "1" }, null);
    const first = await waiting.save(request, operationRunId);
    expect(first.result).toMatchObject({ status: "failed", reason: "no_worker" });
    expect(await waiting.rows()).toMatchObject([
      { state: "pending", result: { status: "failed", reason: "no_worker" } }
    ]);
    expect(waiting.commits()).toBe(0);
    waiting.worker.start();
    expect((await waiting.save(request, operationRunId)).result).toMatchObject({
      status: "committed"
    });
  }, 60_000);

  it("removes nothing for a row that names an object that is no bundle of its asset", async () => {
    const { clientInstanceId, assetId, objects, worker } = arrange("foreign-key", {
      worker: false
    });
    await objects.put("users/usr_1/secret", encoder.encode("x"));
    await db.sql`
      insert into asset_repo_bundles
        (asset_id, operation_run_id, client_instance_id, state, saved_at, created_at, swept_at,
         object_key, kind, tip_commit, bytes, sha256)
      values (${assetId}, 'oprun_foreign', ${clientInstanceId}, 'swept', now(), now(), now(),
        'users/usr_1/secret', 'full', ${"a".repeat(40)}, 1, ${"b".repeat(64)})`;
    await db.store.jobs.enqueue(
      assetRepoSweepJob,
      {},
      { clientInstanceId, dedupeKey: scheduleDedupeKey(assetRepoSweepJob.kind) }
    );
    await worker.runDue();
    expect(objects.has("users/usr_1/secret")).toBe(true);
  });
});
