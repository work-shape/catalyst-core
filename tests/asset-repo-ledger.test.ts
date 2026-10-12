import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSET_REPO_OUTPUT_DIRECTORY,
  ASSET_REPO_REPOSITORY_DIRECTORY
} from "@vivd-catalyst/asset-repo";
import {
  assetRepoBundleObjectKey,
  createPlatformId,
  isAppError,
  readObjectBytes,
  type AssetRepoSaveBundle,
  type AssetRepoWrite,
  type ConfigAssetStore,
  type OperationRunId
} from "@vivd-catalyst/core";
import { commitFolder, materialise, testGit, type TestBundle } from "./support/asset-repo";
import { createConversationCleanupFixture } from "./support/conversation-cleanup-fixture";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { usePostgresSuite } from "./support/postgres-suite";

// The ledger of an asset's repository, against a real Postgres. It says which bundles make the
// repository and which commit the draft is at. A change that adds a commit is one transaction:
// the bundle row made live, the revision and the draft, and only when the draft is still the
// commit the change was made on. Before it, a save leaves a pending row that says when it was
// made and which object it put, so a second attempt builds the same commit and the sweeper
// finds what a save left behind.

const oid = (seed: string) => seed.repeat(40).slice(0, 40);
const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const runId = () => createPlatformId<"OperationRunId">("oprun");
const FAR_FUTURE = new Date("2100-01-01T00:00:00Z");

async function refusalOf(action: Promise<unknown>) {
  try {
    await action;
  } catch (error) {
    if (isAppError(error)) {
      const details: unknown = error.details;
      return {
        code: error.code,
        ...(typeof details === "object" && details !== null ? details : {})
      };
    }
    throw error;
  }
  throw new Error("Expected a refusal");
}

interface Base {
  revision: number | null;
  commit: string | null;
}

/** What a test says of one save beyond its base and its commit. */
interface SaveOptions {
  run?: OperationRunId;
  tree?: string;
  /** What the save names of its bundle, where that is not what the commit and the base give. */
  bundle?: Partial<AssetRepoSaveBundle>;
  checkout?: AssetRepoWrite["checkout"];
  validate?: () => Promise<void>;
}

describe("the ledger of an asset's repository", () => {
  const db = usePostgresSuite("asset_repo");

  /** One asset on a client instance of its own, and the steps a save of it takes. */
  function arrange(label: string, kind = "app", clientInstanceId = db.clientInstance(label)) {
    const name = "rates";
    const assetId = createPlatformId("cfga");
    const address = { clientInstanceId, kind, name };
    const bundleOf = (base: Base, commit: string, more: Partial<AssetRepoSaveBundle> = {}) => {
      const named = {
        kind: base.commit === null ? ("full" as const) : ("incremental" as const),
        tipCommit: commit,
        ...(base.commit === null ? {} : { prerequisiteCommit: base.commit }),
        bytes: 100,
        sha256: sha("5"),
        ...more
      };
      return {
        objectKey: assetRepoBundleObjectKey({ assetId, commit, sha256: named.sha256 }),
        ...named
      };
    };
    /** The first two steps of a save: the pending row, then the name of its bundle. */
    const pend = async (
      store: ConfigAssetStore,
      base: Base,
      commit: string,
      more: SaveOptions = {}
    ) => {
      const operationRunId = more.run ?? runId();
      const save = { clientInstanceId, assetId, operationRunId };
      const begun = await store.beginAssetRepoSave(save);
      const bundle = bundleOf(base, commit, more.bundle);
      await store.nameAssetRepoSaveBundle({ ...save, bundle });
      return { operationRunId, savedAt: begun.savedAt, bundle };
    };
    /** The last step: the transaction that makes `commit` the draft, as a save that read `base`. */
    const settle = (
      store: ConfigAssetStore,
      base: Base,
      commit: string,
      operationRunId: OperationRunId,
      more: SaveOptions = {}
    ) =>
      store.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [`${kind}:${name}`]: base.revision },
        ...(more.validate ? { validate: more.validate } : {}),
        mutations: [
          {
            type: "upsert",
            kind,
            name,
            config: { name },
            draft: true,
            assetId,
            repository: {
              commit,
              tree: more.tree ?? oid("e"),
              baseCommit: base.commit,
              operationRunId,
              ...(more.checkout ? { checkout: more.checkout } : {})
            }
          }
        ]
      });
    /** A whole save. */
    const save = async (
      store: ConfigAssetStore,
      base: Base,
      commit: string,
      more: SaveOptions = {}
    ) => {
      const { operationRunId } = await pend(store, base, commit, more);
      return settle(store, base, commit, operationRunId, more);
    };
    const bundles = () => db.store.configAssets.listAssetRepoBundles({ clientInstanceId, assetId });
    const revisions = () => db.store.configAssets.listConfigAssetRevisions(address);
    const draft = () => db.store.configAssets.getConfigAsset(address);
    /** Sweeps every pending save and answers the objects of this asset that were removed. */
    const sweep = async (olderThan = FAR_FUTURE) => {
      const removed: string[] = [];
      await db.store.configAssets.sweepPendingAssetRepoSaves({
        olderThan,
        limit: 1000,
        removeObject: (object) => {
          if (object.assetId === assetId) removed.push(object.objectKey);
          return Promise.resolve();
        }
      });
      return removed;
    };
    return {
      clientInstanceId,
      assetId,
      address,
      bundleOf,
      pend,
      settle,
      save,
      bundles,
      revisions,
      draft,
      sweep
    };
  }

  it("writes the first commit as revision 1 with one full bundle row", async () => {
    const { assetId, save, bundles, revisions, draft } = arrange("first");
    await save(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    expect(await draft()).toMatchObject({
      id: assetId,
      revision: 1,
      commit: oid("a"),
      tree: oid("e")
    });
    expect(await revisions()).toMatchObject([{ revision: 1, commit: oid("a"), tree: oid("e") }]);
    expect(await bundles()).toEqual([
      {
        assetId,
        sequence: 1,
        // The key holds the commit and the hash of the bytes, so no put replaces other bytes.
        objectKey: `assets/${assetId}/repo/${oid("a")}-${sha("5")}.bundle`,
        kind: "full",
        tipCommit: oid("a"),
        bytes: 100,
        sha256: sha("5"),
        createdAt: expect.any(String)
      }
    ]);
  });

  // Fails without the comparison of the base commit under the lock: both saves would land, and
  // the second would name a bundle that stands on a commit that is not the draft's parent.
  it("lets one of two saves from the same base win, tells the other that the draft moved and leaves its bundle to the sweeper", async () => {
    const { save, bundleOf, bundles, revisions, draft, sweep } = arrange("race");
    await save(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    const base = { revision: 1, commit: oid("a") };
    const lostKeys: string[] = [];
    for (let round = 0; round < 5; round += 1) {
      const current = await draft();
      const from =
        round === 0 ? base : { revision: current?.revision ?? 0, commit: current?.commit ?? "" };
      const left = oid(`b${round}`);
      const right = oid(`c${round}`);
      const outcomes = await Promise.allSettled([
        save(db.store.configAssets, from, left),
        save(db.secondStore.configAssets, from, right)
      ]);
      const won = outcomes.filter((outcome) => outcome.status === "fulfilled");
      const lost = outcomes.flatMap((outcome): unknown[] =>
        outcome.status === "rejected" ? [outcome.reason] : []
      );
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      const leftWon = outcomes[0]?.status === "fulfilled";
      expect(await refusalOf(Promise.reject(lost[0]))).toMatchObject({
        code: "CONFLICT",
        reason: "draft_moved",
        draftCommit: leftWon ? left : right
      });
      lostKeys.push(bundleOf(from, leftWon ? right : left).objectKey);
    }
    const written = await revisions();
    const rows = await bundles();
    expect(written).toHaveLength(6);
    // One bundle of the repository per revision and none without: each ends on the commit of a
    // revision, and stands on the commit of the revision before it.
    expect(rows.map((row) => row.tipCommit)).toEqual(written.map((revision) => revision.commit));
    expect(rows.slice(1).map((row) => row.prerequisiteCommit)).toEqual(
      written.slice(0, -1).map((revision) => revision.commit)
    );
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
    // The bundles of the saves that lost are still pending, so the sweeper finds each of them
    // without a listing of the store, and it takes nothing of the repository.
    expect((await sweep()).sort()).toEqual(lostKeys.sort());
    expect(await bundles()).toEqual(rows);
  });

  it("refuses a save whose base is an earlier commit although it names the current revision", async () => {
    const { save, bundles } = arrange("stale-commit");
    await save(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    await save(db.store.configAssets, { revision: 1, commit: oid("a") }, oid("b"));
    expect(
      await refusalOf(save(db.store.configAssets, { revision: 2, commit: oid("a") }, oid("c")))
    ).toMatchObject({ code: "CONFLICT", reason: "draft_moved", draftCommit: oid("b") });
    expect(await bundles()).toHaveLength(2);
  });

  it("adds no bundle to the repository when the write of the revision is refused", async () => {
    const { save, bundles, revisions } = arrange("atomic");
    await save(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    await expect(
      save(db.store.configAssets, { revision: 1, commit: oid("a") }, oid("b"), {
        validate: () => Promise.reject(new Error("refused by the kind"))
      })
    ).rejects.toThrow("refused by the kind");
    expect(await bundles()).toHaveLength(1);
    expect(await revisions()).toHaveLength(1);
  });

  it("writes no revision for a save that has no pending bundle", async () => {
    const { clientInstanceId, assetId, save, settle, bundles, revisions, draft } =
      arrange("no-pending");
    const store = db.store.configAssets;
    await save(store, { revision: null, commit: null }, oid("a"));
    const base = { revision: 1, commit: oid("a") };
    // A run that never began, and one that began and named no bundle.
    const begun = runId();
    await store.beginAssetRepoSave({ clientInstanceId, assetId, operationRunId: begun });
    for (const run of [runId(), begun]) {
      expect(await refusalOf(settle(store, base, oid("b"), run))).toMatchObject({
        code: "CONFLICT",
        reason: "save_not_pending"
      });
    }
    expect(await bundles()).toHaveLength(1);
    expect(await revisions()).toHaveLength(1);
    expect(await draft()).toMatchObject({ revision: 1, commit: oid("a") });
  });

  it("refuses the same save a second time and keeps one bundle for it", async () => {
    const { pend, settle, save, bundles } = arrange("repeat");
    const store = db.store.configAssets;
    await save(store, { revision: null, commit: null }, oid("a"));
    const base = { revision: 1, commit: oid("a") };
    const { operationRunId } = await pend(store, base, oid("b"));
    await settle(store, base, oid("b"), operationRunId);
    expect(await refusalOf(settle(store, base, oid("b"), operationRunId))).toMatchObject({
      reason: "draft_moved"
    });
    expect(await bundles()).toHaveLength(2);
    // The bundle is part of the repository now, and its save cannot name another.
    expect(await refusalOf(pend(store, base, oid("c"), { run: operationRunId }))).toMatchObject({
      code: "CONFLICT",
      reason: "save_not_pending"
    });
  });

  it("refuses a bundle that is not the one of the commit on its base", async () => {
    const { clientInstanceId, assetId, bundleOf, pend, settle, save, bundles } = arrange("shape");
    const store = db.store.configAssets;
    const nothing = { revision: null, commit: null };
    // A first commit in an incremental bundle.
    const incremental = await pend(store, nothing, oid("a"), {
      bundle: { kind: "incremental", prerequisiteCommit: oid("9") }
    });
    expect(
      await refusalOf(settle(store, nothing, oid("a"), incremental.operationRunId))
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    // A later commit on an asset that is not there.
    expect(
      await refusalOf(save(store, { revision: null, commit: oid("a") }, oid("b")))
    ).toMatchObject({ code: "CONFLICT", reason: "draft_moved" });
    expect(await bundles()).toEqual([]);

    await save(store, nothing, oid("c"));
    const base = { revision: 1, commit: oid("c") };
    // A bundle that ends on another commit, and one that stands on another.
    const other = await pend(store, base, oid("d"));
    expect(await refusalOf(settle(store, base, oid("f"), other.operationRunId))).toMatchObject({
      code: "VALIDATION_FAILED"
    });
    const elsewhere = await pend(store, { revision: 1, commit: oid("9") }, oid("1"));
    expect(await refusalOf(settle(store, base, oid("1"), elsewhere.operationRunId))).toMatchObject({
      code: "VALIDATION_FAILED"
    });
    // A second first commit.
    const again = await pend(store, nothing, oid("2"));
    expect(
      await refusalOf(settle(store, { revision: 1, commit: null }, oid("2"), again.operationRunId))
    ).toMatchObject({ code: "CONFLICT" });
    expect(await bundles()).toHaveLength(1);

    // The name of a bundle is checked where it is given.
    const save3 = { clientInstanceId, assetId, operationRunId: runId() };
    await store.beginAssetRepoSave(save3);
    const good = bundleOf(base, oid("3"));
    for (const bundle of [
      { ...good, objectKey: `assets/${assetId}/repo/${oid("3")}.bundle` },
      { ...good, objectKey: bundleOf(base, oid("4")).objectKey },
      { ...good, kind: "full" as const }
    ]) {
      expect(await refusalOf(store.nameAssetRepoSaveBundle({ ...save3, bundle }))).toMatchObject({
        code: "VALIDATION_FAILED"
      });
    }
  });

  describe("a pending save", () => {
    it("holds one time for every attempt of its Operation Run, in whole seconds", async () => {
      const { clientInstanceId, assetId } = arrange("time");
      const save = { clientInstanceId, assetId, operationRunId: runId() };
      // Two attempts that start at once, on two connections: one row, one time.
      const [left, right] = await Promise.all([
        db.store.configAssets.beginAssetRepoSave(save),
        db.secondStore.configAssets.beginAssetRepoSave(save)
      ]);
      expect(left).toEqual({
        assetId,
        operationRunId: save.operationRunId,
        state: "pending",
        savedAt: expect.any(String)
      });
      expect(right).toEqual(left);
      expect(new Date(left.savedAt).getTime() % 1000).toBe(0);
      await db.sql`update asset_repo_bundles set saved_at = '2026-10-12T08:00:00Z' where operation_run_id = ${save.operationRunId}`;
      const later = await db.store.configAssets.beginAssetRepoSave(save);
      expect(later.savedAt).toBe("2026-10-12T08:00:00.000Z");
      // Another run of the same asset is another save with a time of its own.
      const other = await db.store.configAssets.beginAssetRepoSave({
        ...save,
        operationRunId: runId()
      });
      expect(other.savedAt).not.toBe(later.savedAt);
    });

    it("answers the bundle it named to the next attempt, and takes another only in place of it", async () => {
      const { clientInstanceId, assetId, bundleOf, pend } = arrange("named");
      const store = db.store.configAssets;
      const base = { revision: null, commit: null };
      const { operationRunId, bundle } = await pend(store, base, oid("a"));
      const save = { clientInstanceId, assetId, operationRunId };
      expect(await store.beginAssetRepoSave(save)).toMatchObject({ state: "pending", bundle });
      // The same bundle again changes nothing.
      await store.nameAssetRepoSaveBundle({ ...save, bundle });
      // Another pack of the same commit has another key. The object of the first would be
      // left in the store with no row, so the save says that it removed it.
      const repacked = bundleOf(base, oid("a"), { sha256: sha("6") });
      expect(
        await refusalOf(store.nameAssetRepoSaveBundle({ ...save, bundle: repacked }))
      ).toMatchObject({
        code: "CONFLICT",
        reason: "pending_bundle_differs",
        objectKey: bundle.objectKey
      });
      await store.nameAssetRepoSaveBundle({
        ...save,
        bundle: repacked,
        replaces: bundle.objectKey
      });
      expect(await store.beginAssetRepoSave(save)).toMatchObject({ bundle: repacked });
      // Two saves never name one object.
      expect(
        await refusalOf(pend(store, base, oid("a"), { bundle: { sha256: sha("6") } }))
      ).toMatchObject({
        code: "CONFLICT",
        reason: "bundle_named_by_another_save"
      });
    });

    it("is not another instance's to read or to name", async () => {
      const { assetId, pend } = arrange("mine");
      const { operationRunId, bundle } = await pend(
        db.store.configAssets,
        { revision: null, commit: null },
        oid("a")
      );
      const foreign = { clientInstanceId: db.clientInstance("theirs"), assetId, operationRunId };
      expect(await refusalOf(db.store.configAssets.beginAssetRepoSave(foreign))).toMatchObject({
        code: "CONFLICT"
      });
      expect(
        await refusalOf(db.store.configAssets.nameAssetRepoSaveBundle({ ...foreign, bundle }))
      ).toMatchObject({ code: "CONFLICT", reason: "save_not_pending" });
    });

    it("is removed by the sweeper once it is old, object first, and cannot be finished after", async () => {
      const { pend, settle, save, bundles, revisions, sweep, clientInstanceId, assetId } =
        arrange("sweep");
      const store = db.store.configAssets;
      await save(store, { revision: null, commit: null }, oid("a"));
      const base = { revision: 1, commit: oid("a") };
      const stale = await pend(store, base, oid("b"));
      const unnamed = { clientInstanceId, assetId, operationRunId: runId() };
      await store.beginAssetRepoSave(unnamed);
      await db.sql`update asset_repo_bundles set saved_at = now() - interval '25 hours' where asset_id = ${assetId} and state = 'pending'`;
      const young = await pend(store, base, oid("c"));
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // An object that cannot be removed keeps its row, so it is tried again.
      await expect(
        store.sweepPendingAssetRepoSaves({
          olderThan: dayAgo,
          limit: 1000,
          removeObject: (object) =>
            object.assetId === assetId
              ? Promise.reject(new Error("the store is away"))
              : Promise.resolve()
        })
      ).rejects.toThrow("the store is away");
      const pending = () =>
        db.sql`select 1 from asset_repo_bundles where asset_id = ${assetId} and state = 'pending'`;
      expect(await pending()).toHaveLength(3);

      expect(await sweep(dayAgo)).toEqual([stale.bundle.objectKey]);
      expect(await pending()).toHaveLength(1);
      // Swept: the old save cannot become part of the repository any more.
      expect(await refusalOf(settle(store, base, oid("b"), stale.operationRunId))).toMatchObject({
        code: "CONFLICT",
        reason: "save_not_pending"
      });
      expect(await revisions()).toHaveLength(1);
      // The young save and the repository are untouched.
      await settle(store, base, oid("c"), young.operationRunId);
      expect((await bundles()).map((row) => row.tipCommit)).toEqual([oid("a"), oid("c")]);
      expect(await sweep()).toEqual([]);
      expect(await bundles()).toHaveLength(2);
    });

    // Fails without the lock of the row in the sweeper: the save would make a row live whose
    // object the sweeper is removing.
    it("is either swept or finished when both come at once, never both", async () => {
      const { pend, settle, save, bundles, assetId } = arrange("sweep-race");
      const store = db.store.configAssets;
      await save(store, { revision: null, commit: null }, oid("a"));
      const base = { revision: 1, commit: oid("a") };
      const { operationRunId } = await pend(store, base, oid("b"));
      let removed = 0;
      let finishing: Promise<unknown> = Promise.resolve();
      await db.secondStore.configAssets.sweepPendingAssetRepoSaves({
        olderThan: FAR_FUTURE,
        limit: 1000,
        removeObject: async (object) => {
          if (object.assetId !== assetId) return;
          removed += 1;
          // The save arrives while the object is being removed, and waits for the row.
          finishing = settle(store, base, oid("b"), operationRunId).catch(
            (error: unknown) => error
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      });
      expect(removed).toBe(1);
      expect(await refusalOf(Promise.reject(await finishing))).toMatchObject({
        code: "CONFLICT",
        reason: "save_not_pending"
      });
      expect(await bundles()).toHaveLength(1);
    });
  });

  it("keeps the commit of a revision empty for an asset without a repository", async () => {
    const clientInstanceId = db.clientInstance("plain");
    await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:plain": null },
      mutations: [{ type: "upsert", kind: "skill", name: "plain", config: { name: "plain" } }]
    });
    const [revision] = await db.store.configAssets.listConfigAssetRevisions({
      clientInstanceId,
      kind: "skill",
      name: "plain"
    });
    expect(revision).toBeDefined();
    expect(revision).not.toHaveProperty("commit");
    expect(revision).not.toHaveProperty("tree");
  });

  it("knows no kind: the repository of a workflow is the same rows", async () => {
    const { save, bundles, draft } = arrange("neutral", "workflow");
    await save(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    await save(db.store.configAssets, { revision: 1, commit: oid("a") }, oid("b"));
    expect(await draft()).toMatchObject({ kind: "workflow", revision: 2, commit: oid("b") });
    expect((await bundles()).map((row) => row.kind)).toEqual(["full", "incremental"]);
  });

  it("binds the folder at the first commit, moves it with a save and removes it with the asset", async () => {
    const fixture = await createConversationCleanupFixture(db, "checkout");
    const author = await fixture.createUser("author");
    const conversation = await fixture.createConversation(author, "checkout");
    const { clientInstanceId, assetId, save, pend } = arrange(
      "checkout",
      "app",
      fixture.clientInstanceId
    );
    const store = db.store.configAssets;
    const checkout = { conversationId: conversation.id, folder: "rates" };
    const write = (revision: number | null, baseCommit: string | null, commit: string) =>
      save(store, { revision, commit: baseCommit }, commit, { checkout });
    const read = () => store.getAssetCheckout({ clientInstanceId, ...checkout });
    await write(null, null, oid("a"));
    expect(await read()).toEqual({ ...checkout, assetId, baseCommit: oid("a"), baseRevision: 1 });
    await write(1, oid("a"), oid("b"));
    expect(await read()).toEqual({ ...checkout, assetId, baseCommit: oid("b"), baseRevision: 2 });
    // A refused save leaves the folder on its base.
    await expect(write(1, oid("a"), oid("c"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await read()).toMatchObject({ baseCommit: oid("b"), baseRevision: 2 });

    await pend(store, { revision: 2, commit: oid("b") }, oid("d"));
    await store.removeConfigAsset({
      clientInstanceId,
      kind: "app",
      name: "rates",
      expectedRevision: 2
    });
    expect(await read()).toBeUndefined();
    expect(await store.listAssetRepoBundles({ clientInstanceId, assetId })).toEqual([]);
    // The rows of the asset are gone, those of saves that did not finish among them.
    expect(await db.sql`select 1 from asset_repo_bundles where asset_id = ${assetId}`).toEqual([]);
  });

  describe("with the command and an object store", () => {
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
      const { clientInstanceId, assetId, pend, settle, bundles, revisions, draft } =
        arrange("crash");
      const store = db.store.configAssets;
      const objects = new MemoryObjectStorage();
      const first = await commitFolder(scratch, { files: source });
      if (first.result.status !== "committed" || !first.bundle) throw new Error("not committed");
      const firstCommit = first.result.commit;
      const firstBundle = first.bundle;
      const nothing = { revision: null, commit: null };
      const firstSave = await pend(store, nothing, firstCommit, { bundle: recorded(firstBundle) });
      await objects.put(firstSave.bundle.objectKey, firstBundle.bytes);
      await settle(store, nothing, firstCommit, firstSave.operationRunId, {
        tree: first.result.tree
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
        if (commit.result.status !== "committed" || !commit.bundle)
          throw new Error("not committed");
        const named = await pend(store, base, commit.result.commit, {
          run,
          bundle: recorded(commit.bundle)
        });
        await objects.put(named.bundle.objectKey, commit.bundle.bytes);
        return { ...commit.result, objectKey: named.bundle.objectKey };
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

      await settle(store, base, repeated.commit, run, { tree: repeated.tree });
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
      await store.sweepPendingAssetRepoSaves({
        olderThan: FAR_FUTURE,
        limit: 1000,
        removeObject: (object) =>
          object.assetId === assetId ? objects.delete(object.objectKey) : Promise.resolve()
      });
      expect(objects.keys().sort()).toEqual((await bundles()).map((row) => row.objectKey).sort());
    });

    it("continues from the published commit after the draft was discarded", async () => {
      const { address, save, bundles, revisions, draft } = arrange("discard");
      const store = db.store.configAssets;
      const committed = async (
        files: Record<string, string>,
        from: TestBundle[],
        base: string | null,
        time: number
      ) => {
        const commit = await commitFolder(scratch, { files, bundles: from, base, time });
        if (commit.result.status !== "committed" || !commit.bundle)
          throw new Error("not committed");
        return { ...commit.result, bundle: commit.bundle };
      };
      const first = await committed(source, [], null, 1);
      await save(store, { revision: null, commit: null }, first.commit, {
        tree: first.tree,
        bundle: recorded(first.bundle)
      });
      await store.publishConfigAssetRevision({ ...address, revision: 1 });
      const second = await committed(
        { ...source, "a.txt": "a\n" },
        [first.bundle],
        first.commit,
        2
      );
      await save(store, { revision: 1, commit: first.commit }, second.commit, {
        tree: second.tree,
        bundle: recorded(second.bundle)
      });
      await store.discardConfigAssetDraft({ ...address, expectedRevision: 2 });
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
});
