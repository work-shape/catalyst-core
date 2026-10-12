import { describe, expect, it } from "vitest";
import type { ConfigAssetStore } from "@vivd-catalyst/core";
import {
  arrangeAssetRepo,
  FAR_FUTURE,
  oid,
  refusalOf,
  runId,
  sha,
  type SaveOptions
} from "./support/asset-repo-ledger";
import { usePostgresSuite } from "./support/postgres-suite";

// A save of an asset's repository before it is part of it, against a real Postgres: the
// pending row that says when the save was made and which object it put, what makes it part of
// the repository, and the sweeper that gives up what did not finish and removes its object.

describe("a pending save of an asset's repository", () => {
  const db = usePostgresSuite("asset_repo_saves");
  const arrange = (
    label: string,
    kind?: string,
    clientInstanceId?: ReturnType<typeof db.clientInstance>
  ) => arrangeAssetRepo(db, label, kind, clientInstanceId);

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

  // A row that a rollback takes would leave its object in the store with nothing naming it.
  it("is written for itself: not on the stores of a transaction", async () => {
    const { clientInstanceId, assetId, bundleOf, rows } = arrange("own-transaction");
    const save = { clientInstanceId, assetId, operationRunId: runId() };
    const bundle = bundleOf({ revision: null, commit: null }, oid("a"));
    await db.store.configAssets.beginAssetRepoSave(save);
    for (const call of [
      (store: ConfigAssetStore) => store.beginAssetRepoSave({ ...save, operationRunId: runId() }),
      (store: ConfigAssetStore) => store.nameAssetRepoSaveBundle({ ...save, bundle }),
      (store: ConfigAssetStore) =>
        store.sweepAssetRepoSaves({
          olderThan: FAR_FUTURE,
          limit: 1,
          removeObject: () => Promise.resolve()
        })
    ]) {
      const inside = db.store.transaction(async (stores) => {
        await call(stores.configAssets);
      });
      await expect(inside).rejects.toThrow("outside of a transaction");
    }
    expect(await rows()).toEqual([{ state: "pending", object_key: null }]);
  });

  it("keeps the bundle it named, answers it to the next attempt and takes no other", async () => {
    const { clientInstanceId, assetId, bundleOf, pend } = arrange("named");
    const store = db.store.configAssets;
    const base = { revision: null, commit: null };
    const { operationRunId, bundle } = await pend(store, base, oid("a"));
    const save = { clientInstanceId, assetId, operationRunId };
    expect(await store.beginAssetRepoSave(save)).toMatchObject({ state: "pending", bundle });
    // The same bundle again changes nothing.
    await store.nameAssetRepoSaveBundle({ ...save, bundle });
    // Another pack of the same commit has another key, and the same key with another size is
    // not the same bundle. The object of the first may be in the store, so the save keeps it.
    for (const other of [
      bundleOf(base, oid("a"), { sha256: sha("6") }),
      { ...bundle, bytes: bundle.bytes + 1 }
    ]) {
      expect(
        await refusalOf(store.nameAssetRepoSaveBundle({ ...save, bundle: other }))
      ).toMatchObject({
        code: "CONFLICT",
        reason: "pending_bundle_differs",
        objectKey: bundle.objectKey
      });
    }
    expect(await store.beginAssetRepoSave(save)).toMatchObject({ bundle });
    // Two saves never name one object.
    expect(await refusalOf(pend(store, base, oid("a")))).toMatchObject({
      code: "CONFLICT",
      reason: "bundle_named_by_another_save"
    });
  });

  // Fails where the write compares the commit and the base alone: the row would become part
  // of the repository for an attempt that put other bytes, or none.
  it("becomes part of the repository only as the object the attempt put, and only when the store holds it", async () => {
    const { pend, settle, bundles, revisions, draft } = arrange("exact");
    const store = db.store.configAssets;
    const nothing = { revision: null, commit: null };
    const { operationRunId, bundle } = await pend(store, nothing, oid("a"));
    const attempt = (more: SaveOptions) =>
      refusalOf(settle(store, nothing, oid("a"), operationRunId, more));
    // An attempt that packed the commit differently, or names another size.
    expect(await attempt({ bundle: { sha256: sha("6") } })).toMatchObject({
      code: "CONFLICT",
      reason: "pending_bundle_differs",
      objectKey: bundle.objectKey
    });
    expect(await attempt({ bundle: { bytes: bundle.bytes + 1 } })).toMatchObject({
      code: "CONFLICT",
      reason: "pending_bundle_differs"
    });
    // The object is not in the store, or not whole.
    for (const size of [undefined, bundle.bytes - 1]) {
      expect(await attempt({ objectSize: () => Promise.resolve(size) })).toMatchObject({
        code: "CONFLICT",
        reason: "bundle_object_missing",
        objectKey: bundle.objectKey
      });
    }
    expect(await revisions()).toEqual([]);
    expect(await bundles()).toEqual([]);

    const asked: string[] = [];
    await settle(store, nothing, oid("a"), operationRunId, {
      objectSize: (objectKey) => {
        asked.push(objectKey);
        return Promise.resolve(bundle.bytes);
      }
    });
    expect(asked).toEqual([bundle.objectKey]);
    expect(await draft()).toMatchObject({ revision: 1, commit: oid("a") });
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

  it("is given up by the sweeper once it is old, and its object removed until the row goes a day later", async () => {
    const { pend, settle, save, bundles, revisions, sweep, rows, clientInstanceId, assetId } =
      arrange("sweep");
    const store = db.store.configAssets;
    await save(store, { revision: null, commit: null }, oid("a"));
    const base = { revision: 1, commit: oid("a") };
    const stale = await pend(store, base, oid("b"));
    const unnamed = { clientInstanceId, assetId, operationRunId: runId() };
    await store.beginAssetRepoSave(unnamed);
    await db.sql`update asset_repo_bundles set saved_at = now() - interval '25 hours' where asset_id = ${assetId} and state = 'pending'`;
    const young = await pend(store, base, oid("c"));
    const dayAgo = () => new Date(Date.now() - 24 * 60 * 60 * 1000);
    const states = async () => (await rows()).map((row) => row.state).sort();

    const begun = await store.beginAssetRepoSave({
      clientInstanceId,
      assetId,
      operationRunId: stale.operationRunId
    });
    expect(await sweep(dayAgo())).toEqual([stale.bundle.objectKey]);
    expect(await states()).toEqual(["live", "pending", "swept", "swept"]);
    // Given up: the old save cannot become part of the repository any more, and its run
    // is told so, with the time it began at.
    expect(await refusalOf(settle(store, base, oid("b"), stale.operationRunId))).toMatchObject({
      code: "CONFLICT",
      reason: "save_not_pending"
    });
    expect(
      await store.beginAssetRepoSave({
        clientInstanceId,
        assetId,
        operationRunId: stale.operationRunId
      })
    ).toMatchObject({ state: "swept", savedAt: begun.savedAt });
    expect(await revisions()).toHaveLength(1);

    // A put that was on its way writes the object again. The row is still there, so the
    // next pass removes it again.
    expect(await sweep(dayAgo())).toEqual([stale.bundle.objectKey]);
    expect(await states()).toEqual(["live", "pending", "swept", "swept"]);
    // A day after they were swept, the rows go.
    await db.sql`update asset_repo_bundles set swept_at = now() - interval '25 hours' where asset_id = ${assetId} and state = 'swept'`;
    expect(await sweep(dayAgo())).toEqual([stale.bundle.objectKey]);
    expect(await states()).toEqual(["live", "pending"]);

    // The young save and the repository are untouched.
    await settle(store, base, oid("c"), young.operationRunId);
    expect((await bundles()).map((row) => row.tipCommit)).toEqual([oid("a"), oid("c")]);
    expect(await sweep()).toEqual([]);
    expect(await bundles()).toHaveLength(2);
  });

  // Fails where the sweeper removes objects inside the transaction that removes the rows: a
  // failure after an object was removed brings its row back as pending, and the save that
  // put the object makes it part of the repository.
  it("stays given up when the sweeper fails after it removed the object, and is swept again", async () => {
    const { pend, settle, save, bundles, revisions, sweep, rows } = arrange("sweep-fails");
    const store = db.store.configAssets;
    await save(store, { revision: null, commit: null }, oid("a"));
    const base = { revision: 1, commit: oid("a") };
    const first = await pend(store, base, oid("b"));
    const second = await pend(store, base, oid("c"));
    const keys = [first.bundle.objectKey, second.bundle.objectKey].sort();

    // The object of the first is removed, then the store fails, then the process is gone.
    const removed: string[] = [];
    await expect(
      store.sweepAssetRepoSaves({
        olderThan: FAR_FUTURE,
        limit: 1000,
        removeObject: (object) => {
          if (!keys.includes(object.objectKey)) return Promise.resolve();
          if (removed.length === 1) return Promise.reject(new Error("the store is away"));
          removed.push(object.objectKey);
          return Promise.resolve();
        }
      })
    ).rejects.toThrow("the store is away");
    expect(removed).toHaveLength(1);

    // Neither save can be finished, whichever object is gone.
    for (const [commit, pending] of [
      [oid("b"), first],
      [oid("c"), second]
    ] as const) {
      expect(await refusalOf(settle(store, base, commit, pending.operationRunId))).toMatchObject({
        code: "CONFLICT",
        reason: "save_not_pending"
      });
    }
    expect(await revisions()).toHaveLength(1);
    expect(await bundles()).toHaveLength(1);
    // The object that was left is found again by its row.
    const left = keys.filter((key) => !removed.includes(key));
    expect(
      (await rows()).filter((row) => row.state === "swept").map((row) => row.object_key)
    ).toEqual(left);
    expect(await sweep()).toEqual(left);
    expect((await rows()).map((row) => row.state)).toEqual(["live"]);
  });

  it("is either given up or finished when both come at once, never both", async () => {
    const { pend, settle, save, bundles, revisions, assetId } = arrange("sweep-race");
    const store = db.store.configAssets;
    await save(store, { revision: null, commit: null }, oid("a"));
    let base = { revision: 1, commit: oid("a") };
    const outcomes = new Set<string>();
    for (let round = 0; round < 12; round += 1) {
      const commit = oid(`b${round.toString(16)}`);
      const { operationRunId, bundle } = await pend(store, base, commit);
      const removed: string[] = [];
      const [finished] = await Promise.allSettled([
        settle(store, base, commit, operationRunId),
        db.secondStore.configAssets.sweepAssetRepoSaves({
          olderThan: FAR_FUTURE,
          limit: 1000,
          removeObject: (object) => {
            if (object.assetId === assetId) removed.push(object.objectKey);
            return Promise.resolve();
          }
        })
      ]);
      const live = (await bundles()).map((row) => row.objectKey);
      if (finished.status === "fulfilled") {
        expect(removed).toEqual([]);
        expect(live).toContain(bundle.objectKey);
        base = { revision: base.revision + 1, commit };
      } else {
        expect(await refusalOf(Promise.reject(finished.reason))).toMatchObject({
          reason: "save_not_pending"
        });
        expect(removed).toEqual([bundle.objectKey]);
        expect(live).not.toContain(bundle.objectKey);
      }
      outcomes.add(finished.status);
    }
    expect(outcomes.size).toBeGreaterThan(0);
    expect(await revisions()).toHaveLength(base.revision);
  });

  // Fails where the sweeper holds the lock of a row while it calls the store: the save that
  // finishes that row waits, and with it every write of the instance.
  it("holds up no save while the sweeper waits for the object store", async () => {
    const slow = arrange("stuck");
    const other = arrange("stuck-other");
    const store = db.store.configAssets;
    const nothing = { revision: null, commit: null };
    await slow.save(store, nothing, oid("a"));
    const base = { revision: 1, commit: oid("a") };
    const old = await slow.pend(store, base, oid("b"));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = (): void => undefined;
    const inside = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const sweeping = db.secondStore.configAssets.sweepAssetRepoSaves({
      olderThan: FAR_FUTURE,
      limit: 1000,
      removeObject: async (object) => {
        if (object.assetId === slow.assetId) {
          entered();
          await gate;
        }
      }
    });
    await inside;
    // The store does not answer. The save of the row is refused at once, and other saves
    // of the instance and of others go through.
    expect(await refusalOf(slow.settle(store, base, oid("b"), old.operationRunId))).toMatchObject({
      reason: "save_not_pending"
    });
    await slow.save(store, base, oid("c"));
    await other.save(store, nothing, oid("a"));
    release();
    await sweeping;
    expect(await slow.draft()).toMatchObject({ revision: 2, commit: oid("c") });
  });

  it("is passed over by the sweeper while somebody holds its row", async () => {
    const held = arrange("held");
    const free = arrange("held-other");
    const store = db.store.configAssets;
    const nothing = { revision: null, commit: null };
    await held.pend(store, nothing, oid("a"));
    const other = await free.pend(store, nothing, oid("a"));
    const holding = await db.hold(
      (tx) => tx`select 1 from asset_repo_bundles where asset_id = ${held.assetId} for update`
    );
    try {
      expect(await free.sweep()).toEqual([other.bundle.objectKey]);
      expect((await held.rows()).map((row) => row.state)).toEqual(["pending"]);
    } finally {
      await holding.rollback();
    }
    expect(await held.sweep()).toHaveLength(1);
  });

  it("has its objects removed by its rows when the asset is removed, also by a release that did not know them", async () => {
    const { clientInstanceId, assetId, address, pend, settle, save, sweep, rows } =
      arrange("removed");
    const store = db.store.configAssets;
    const first = await save(store, { revision: null, commit: null }, oid("a")).then(() => rows());
    const pending = await pend(store, { revision: 1, commit: oid("a") }, oid("b"));
    const keys = [first[0]?.object_key, pending.bundle.objectKey].sort();
    await store.removeConfigAsset({ ...address, assetId, expectedRevision: 1 });
    // The process that removed the asset is gone before it removed anything from the store.
    expect((await rows()).map((row) => row.state)).toEqual(["swept", "swept"]);
    // The save that was on its way cannot be finished, and its run is told that it is over.
    expect(
      await refusalOf(
        settle(store, { revision: 1, commit: oid("a") }, oid("b"), pending.operationRunId)
      )
    ).toMatchObject({ code: "CONFLICT" });
    expect(
      await store.beginAssetRepoSave({
        clientInstanceId,
        assetId,
        operationRunId: pending.operationRunId
      })
    ).toMatchObject({ state: "swept" });
    // It may still put its object, after the remover emptied the prefix. The row is kept for
    // a day after it was swept, so a pass in that day removes the object again.
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await db.sql`update asset_repo_bundles set saved_at = now() - interval '25 hours' where asset_id = ${assetId}`;
    expect((await sweep(dayAgo)).sort()).toEqual(keys);
    expect((await sweep(dayAgo)).sort()).toEqual(keys);
    expect((await sweep()).sort()).toEqual(keys);
    expect(await rows()).toEqual([]);

    // An earlier release removes the asset row and knows nothing of the bundle rows.
    const old = arrange("removed-old");
    await old.save(store, { revision: null, commit: null }, oid("c"));
    const [live] = await old.rows();
    await db.sql`delete from config_assets where id = ${old.assetId}`;
    expect((await old.rows()).map((row) => row.state)).toEqual(["live"]);
    expect(await old.sweep()).toEqual([live?.object_key]);
    expect(await old.rows()).toEqual([]);
  });
});
