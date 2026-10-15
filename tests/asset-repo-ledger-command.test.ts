import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSET_REPO_OUTPUT_DIRECTORY,
  ASSET_REPO_REPOSITORY_DIRECTORY
} from "@work-shape/catalyst-asset-repo";
import {
  readObjectBytes,
  type ConfigAssetStore,
  type OperationRunId
} from "@work-shape/catalyst-core";
import { commitFolder, materialise, testGit, type TestBundle } from "./support/asset-repo";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { arrangeAssetRepo, FAR_FUTURE, runId } from "./support/asset-repo-ledger";
import { usePostgresSuite } from "./support/postgres-suite";

// The ledger and the command together, with an object store: the whole of a save as a worker
// makes it, and what a reader that follows the ledger gets.

describe("the ledger of an asset's repository, with the command and an object store", () => {
  const db = usePostgresSuite("asset_repo_command");
  const arrange = (
    label: string,
    kind?: string,
    clientInstanceId?: ReturnType<typeof db.clientInstance>
  ) => arrangeAssetRepo(db, label, kind, clientInstanceId);

  let scratch: string;
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "asset-repo-ledger-test-"));
  });
  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const source = { "app.yaml": "id: rates\n", "src/rates.ts": "export const rate = 1;\n" };

  /** The bundles the ledger names, read from the object store, as the worker reads them. */
  async function ledgerBundles(
    objects: MemoryObjectStorage,
    rows: Awaited<ReturnType<ConfigAssetStore["listAssetRepoBundles"]>>
  ): Promise<TestBundle[]> {
    return Promise.all(
      rows.map(async (row) => ({
        file: `${row.sequence}.bundle`,
        tip: row.tipCommit,
        prerequisite: row.prerequisiteCommit ?? null,
        bytes: Buffer.from(await readObjectBytes(objects, row.objectKey)),
        // What the ledger recorded goes into the request, and the command compares it.
        recorded: { sha256: row.sha256, bytes: row.bytes }
      }))
    );
  }

  /** What the ledger records of a bundle the command wrote. */
  const recorded = (bundle: TestBundle) => ({
    bytes: bundle.bytes.byteLength,
    sha256: createHash("sha256").update(bundle.bytes).digest("hex")
  });

  // The order of a save: the pending row with its time, the commit, the name of the bundle,
  // the object, then the transaction. A save may stop after any of them.
  it("leaves the draft where it was when a save stops after its bundle is written, takes the repeated save as the same commit, and sweeps a save nobody repeats", async () => {
    const { clientInstanceId, assetId, pend, settle, bundles, revisions, draft } = arrange("crash");
    const store = db.store.configAssets;
    const objects = new MemoryObjectStorage();
    const first = await commitFolder(scratch, { files: source });
    if (first.result.status !== "committed" || !first.bundle) throw new Error("not committed");
    const firstCommit = first.result.commit;
    const firstBundle = first.bundle;
    const nothing = { revision: null, commit: null };
    const firstSave = await pend(store, nothing, firstCommit, { bundle: recorded(firstBundle) });
    await objects.put(firstSave.bundle.objectKey, firstBundle.bytes);
    const objectSize = async (objectKey: string) =>
      objects.has(objectKey) ? objects.bytes(objectKey).byteLength : undefined;
    await settle(store, nothing, firstCommit, firstSave.operationRunId, {
      tree: first.result.tree,
      bundle: recorded(firstBundle),
      objectSize
    });
    const base = { revision: 1, commit: firstCommit };

    /** One attempt of the save of an Operation Run, up to and with the put of its object. */
    const attempt = async (run: OperationRunId, files: Record<string, string>) => {
      const begun = await store.beginAssetRepoSave({
        clientInstanceId,
        assetId,
        operationRunId: run
      });
      const commit = await commitFolder(scratch, {
        files,
        bundles: await ledgerBundles(objects, await bundles()),
        base: firstCommit,
        // The time of the commit is the one the ledger holds for the run.
        time: new Date(begun.savedAt).getTime() / 1000
      });
      if (commit.result.status !== "committed" || !commit.bundle) throw new Error("not committed");
      const named = await pend(store, base, commit.result.commit, {
        run,
        bundle: recorded(commit.bundle)
      });
      await objects.put(named.bundle.objectKey, commit.bundle.bytes);
      return {
        ...commit.result,
        objectKey: named.bundle.objectKey,
        bundle: recorded(commit.bundle)
      };
    };

    const edited = { ...source, "src/rates.ts": "export const rate = 2;\n" };
    const run = runId();
    const stopped = await attempt(run, edited);
    // The process stops here: no transaction.

    expect(await draft()).toMatchObject({ revision: 1, commit: firstCommit });
    expect(await revisions()).toHaveLength(1);
    expect((await bundles()).map((row) => row.tipCommit)).toEqual([firstCommit]);
    // A reader follows the ledger: the object of a pending save is not part of the repository.
    const before = await materialise(scratch, {
      bundles: await ledgerBundles(objects, await bundles()),
      draft: firstCommit,
      revisions: [{ number: 1, commit: firstCommit }]
    });
    expect(before.result).toMatchObject({ status: "materialised", commits: 1 });

    // The second attempt is made later. It reads the time of the first from the ledger.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const repeated = await attempt(run, edited);
    expect(repeated.commit).toBe(stopped.commit);
    expect(repeated.objectKey).toBe(stopped.objectKey);
    // Another run of the same save is another commit, as it has a time of its own.
    const abandoned = await attempt(runId(), edited);
    expect(abandoned.commit).not.toBe(stopped.commit);

    await settle(store, base, repeated.commit, run, {
      tree: repeated.tree,
      bundle: repeated.bundle,
      objectSize
    });
    expect(await draft()).toMatchObject({ revision: 2, commit: repeated.commit });
    const after = await materialise(scratch, {
      bundles: await ledgerBundles(objects, await bundles()),
      draft: repeated.commit,
      revisions: (await revisions()).map((revision) => ({
        number: revision.revision,
        commit: revision.commit ?? ""
      }))
    });
    expect(after.result).toMatchObject({ status: "materialised", commits: 2, revisions: 2 });

    // The save nobody repeats left an object no revision names. The sweeper finds it by its
    // pending row and removes it, and nothing else.
    expect(objects.has(abandoned.objectKey)).toBe(true);
    await store.sweepAssetRepoSaves({
      olderThan: FAR_FUTURE,
      limit: 1000,
      removeObject: (object) =>
        object.assetId === assetId ? objects.delete(object.objectKey) : Promise.resolve()
    });
    expect(objects.keys().sort()).toEqual((await bundles()).map((row) => row.objectKey).sort());
  });

  it("continues from the published commit after the draft was discarded", async () => {
    const { address, assetId, save, bundles, revisions, draft } = arrange("discard");
    const store = db.store.configAssets;
    const committed = async (
      files: Record<string, string>,
      from: TestBundle[],
      base: string | null,
      time: number
    ) => {
      const commit = await commitFolder(scratch, { files, bundles: from, base, time });
      if (commit.result.status !== "committed" || !commit.bundle) throw new Error("not committed");
      return { ...commit.result, bundle: commit.bundle };
    };
    const first = await committed(source, [], null, 1);
    await save(store, { revision: null, commit: null }, first.commit, {
      tree: first.tree,
      bundle: recorded(first.bundle)
    });
    const revisionId = (await revisions()).find((revision) => revision.revision === 1)?.id ?? "";
    await store.publishConfigAssetRevision({ ...address, assetId, revision: 1, revisionId });
    const second = await committed({ ...source, "a.txt": "a\n" }, [first.bundle], first.commit, 2);
    await save(store, { revision: 1, commit: first.commit }, second.commit, {
      tree: second.tree,
      bundle: recorded(second.bundle)
    });
    await store.discardConfigAssetDraft({ ...address, assetId, expectedRevision: 2 });
    expect(await draft()).toMatchObject({ revision: 1, commit: first.commit });

    const third = await committed({ ...source, "b.txt": "b\n" }, [first.bundle], first.commit, 3);
    await save(store, { revision: 1, commit: first.commit }, third.commit, {
      tree: third.tree,
      bundle: recorded(third.bundle)
    });
    expect(await draft()).toMatchObject({ revision: 3, commit: third.commit });
    // Every bundle stands on the commit of a revision, so the three apply in ledger order,
    // and the discarded revision stays reachable by its ref.
    const rows = await bundles();
    const bytes = new Map(
      [first, second, third].map((commit) => [commit.commit, commit.bundle.bytes])
    );
    const { result, directory } = await materialise(scratch, {
      bundles: rows.map((row) => ({
        file: `${row.sequence}.bundle`,
        tip: row.tipCommit,
        prerequisite: row.prerequisiteCommit ?? null,
        bytes: bytes.get(row.tipCommit) ?? Buffer.alloc(0)
      })),
      draft: third.commit,
      revisions: (await revisions()).map((revision) => ({
        number: revision.revision,
        commit: revision.commit ?? ""
      }))
    });
    expect(result).toMatchObject({ status: "materialised", commits: 3, revisions: 3 });
    const repository = join(
      directory,
      ASSET_REPO_OUTPUT_DIRECTORY,
      ASSET_REPO_REPOSITORY_DIRECTORY
    );
    expect(await testGit(repository, ["rev-parse", "refs/revisions/2"])).toBe(second.commit);
    expect(await testGit(repository, ["rev-parse", "refs/heads/draft^"])).toBe(first.commit);
  });
});
