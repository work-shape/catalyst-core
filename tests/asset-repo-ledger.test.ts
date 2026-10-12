import { describe, expect, it } from "vitest";
import { createConversationCleanupFixture } from "./support/conversation-cleanup-fixture";
import { arrangeAssetRepo, oid, refusalOf, runId, sha } from "./support/asset-repo-ledger";
import { usePostgresSuite } from "./support/postgres-suite";

// The ledger of an asset's repository, against a real Postgres. It says which bundles make the
// repository and which commit the draft is at. A change that adds a commit is one transaction:
// the bundle row made live, the revision and the draft, and only when the draft is still the
// commit the change was made on. Before it, a save leaves a pending row that says when it was
// made and which object it put, so a second attempt builds the same commit and the sweeper
// finds what a save left behind.

describe("the ledger of an asset's repository", () => {
  const db = usePostgresSuite("asset_repo");
  const arrange = (
    label: string,
    kind?: string,
    clientInstanceId?: ReturnType<typeof db.clientInstance>
  ) => arrangeAssetRepo(db, label, kind, clientInstanceId);

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
    expect(
      await refusalOf(
        settle(store, base, oid("f"), other.operationRunId, {
          bundle: { objectKey: other.bundle.objectKey }
        })
      )
    ).toMatchObject({ code: "VALIDATION_FAILED" });
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

  it("refuses a batch that writes the asset of a commit a second time", async () => {
    const { clientInstanceId, assetId, pend, save, bundles, revisions, draft } = arrange("mixed");
    const store = db.store.configAssets;
    await save(store, { revision: null, commit: null }, oid("a"));
    const base = { revision: 1, commit: oid("a") };
    const { operationRunId, bundle } = await pend(store, base, oid("b"));
    const upsert = {
      type: "upsert" as const,
      kind: "app",
      name: "rates",
      config: { name: "rates" },
      draft: true as const
    };
    const repository = {
      commit: oid("b"),
      tree: oid("e"),
      baseCommit: oid("a"),
      operationRunId,
      bundle
    };
    for (const mutations of [
      [{ ...upsert, assetId, repository }, upsert],
      [upsert, { ...upsert, assetId, repository }],
      [
        { ...upsert, assetId, repository },
        { type: "delete" as const, kind: "app", name: "rates" }
      ]
    ]) {
      expect(
        await refusalOf(
          store.applyConfigAssetMutations({
            clientInstanceId,
            baseRevisions: { "app:rates": 1 },
            repositoryObjectSize: () => Promise.resolve(bundle.bytes),
            mutations
          })
        )
      ).toMatchObject({ code: "VALIDATION_FAILED" });
    }
    // The draft still names its commit, and the bundle is not part of the repository.
    expect(await draft()).toMatchObject({ revision: 1, commit: oid("a") });
    expect(await revisions()).toHaveLength(1);
    expect(await bundles()).toHaveLength(1);
  });

  // Fails where a write without a commit passes: the draft would be a revision that names no
  // commit, and no save could stand on it any more.
  it("refuses a write without a commit on an asset that has a repository, and the next save goes on", async () => {
    const { clientInstanceId, save, draft, revisions } = arrange("plain");
    const store = db.store.configAssets;
    await save(store, { revision: null, commit: null }, oid("a"));
    expect(
      await refusalOf(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: { "app:rates": 1 },
          mutations: [
            {
              type: "upsert",
              kind: "app",
              name: "rates",
              config: { name: "rates", title: "renamed" },
              draft: true
            }
          ]
        })
      )
    ).toMatchObject({ code: "VALIDATION_FAILED", reason: "repository_write_without_commit" });
    expect(await revisions()).toHaveLength(1);
    await save(store, { revision: 1, commit: oid("a") }, oid("b"));
    expect(await draft()).toMatchObject({ revision: 2, commit: oid("b") });
  });

  // A deleted asset keeps its revisions, and so its history: the tombstone names the last
  // commit, and the asset comes back on it.
  it("brings a deleted asset back on the commit it was deleted at", async () => {
    const { clientInstanceId, save, bundles, draft, rows } = arrange("softdelete");
    const store = db.store.configAssets;
    await save(store, { revision: null, commit: null }, oid("a"));
    await save(store, { revision: 1, commit: oid("a") }, oid("b"));
    await store.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "app:rates": 2 },
      mutations: [{ type: "delete", kind: "app", name: "rates" }]
    });
    expect(await draft()).toMatchObject({ status: "deleted", revision: 3, commit: oid("b") });
    expect((await rows()).map((row) => row.state)).toEqual(["live", "live"]);
    // Neither a first commit nor a write without one starts it over.
    expect(await refusalOf(save(store, { revision: 3, commit: null }, oid("d")))).toMatchObject({
      code: "CONFLICT",
      reason: "draft_moved",
      draftCommit: oid("b")
    });
    expect(
      await refusalOf(
        store.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: { "app:rates": 3 },
          mutations: [
            { type: "upsert", kind: "app", name: "rates", config: { name: "rates" }, draft: true }
          ]
        })
      )
    ).toMatchObject({ code: "VALIDATION_FAILED", reason: "repository_write_without_commit" });
    await save(store, { revision: 3, commit: oid("b") }, oid("c"));
    expect(await draft()).toMatchObject({ status: "active", revision: 4, commit: oid("c") });
    expect((await bundles()).map((row) => [row.sequence, row.kind, row.tipCommit])).toEqual([
      [1, "full", oid("a")],
      [2, "incremental", oid("b")],
      [3, "incremental", oid("c")]
    ]);
  });

  it("holds the form of a bundle row by itself", async () => {
    const { clientInstanceId, assetId, pend } = arrange("constraints");
    await pend(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    await db.store.configAssets.beginAssetRepoSave({
      clientInstanceId,
      assetId,
      operationRunId: runId()
    });
    for (const set of [
      "state = 'live'",
      "state = 'live', sequence = 1",
      "state = 'swept'",
      "object_key = 'x'",
      "tip_commit = 'not-a-commit'",
      `tip_commit = '${oid("A")}'`,
      "prerequisite_commit = 'nope', kind = 'incremental'",
      "sha256 = 'nope'",
      `sha256 = '${sha("a").slice(1)}'`,
      "bytes = 0",
      "bytes = -5"
    ]) {
      await expect(
        db.sql.unsafe(`update asset_repo_bundles set ${set} where asset_id = '${assetId}'`),
        set
      ).rejects.toThrow(/check constraint/u);
    }
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
      assetId,
      expectedRevision: 2
    });
    expect(await read()).toBeUndefined();
    expect(await store.listAssetRepoBundles({ clientInstanceId, assetId })).toEqual([]);
    // No row of the asset can become part of a repository any more.
    expect(
      await db.sql`select 1 from asset_repo_bundles where asset_id = ${assetId} and state <> 'swept'`
    ).toEqual([]);
  });
});
