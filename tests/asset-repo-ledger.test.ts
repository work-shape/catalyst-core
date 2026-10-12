import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSET_REPO_OUTPUT_DIRECTORY,
  ASSET_REPO_REPOSITORY_DIRECTORY
} from "@vivd-catalyst/asset-repo";
import {
  assetObjectPrefix,
  createPlatformId,
  isAppError,
  readObjectBytes,
  type AssetRepoWrite,
  type ClientInstanceId,
  type ConfigAssetStore
} from "@vivd-catalyst/core";
import { commitFolder, materialise, testGit, type TestBundle } from "./support/asset-repo";
import { createConversationCleanupFixture } from "./support/conversation-cleanup-fixture";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { usePostgresSuite } from "./support/postgres-suite";

// The ledger of an asset's repository, against a real Postgres. It says which bundles make the
// repository and which commit the draft is at. A change that adds a commit is one transaction:
// the bundle row, the revision and the draft, and only when the draft is still the commit the
// change was made on.

const oid = (seed: string) => seed.repeat(40).slice(0, 40);
const key = (assetId: string, commit: string) =>
  `${assetObjectPrefix(assetId)}repo/${commit}.bundle`;

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

describe("the ledger of an asset's repository", () => {
  const db = usePostgresSuite("asset_repo");

  /** One asset on a client instance of its own, and the writes a save makes of it. */
  function arrange(label: string, kind = "app") {
    const clientInstanceId = db.clientInstance(label);
    const name = "rates";
    const assetId = createPlatformId("cfga");
    const address = { clientInstanceId, kind, name };
    /** The write that makes `commit` the draft, as a save that read revision `base` makes it. */
    const save = (
      store: ConfigAssetStore,
      base: { revision: number | null; commit: string | null },
      commit: string,
      more: Partial<AssetRepoWrite> & { validate?: () => Promise<void> } = {}
    ) => {
      const { validate, ...repository } = more;
      return store.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [`${kind}:${name}`]: base.revision },
        ...(validate ? { validate } : {}),
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
              tree: oid("e"),
              baseCommit: base.commit,
              bundle: {
                objectKey: key(assetId, commit),
                kind: base.commit === null ? "full" : "incremental",
                bytes: 100,
                sha256: oid("5")
              },
              ...repository
            }
          }
        ]
      });
    };
    const bundles = () => db.store.configAssets.listAssetRepoBundles({ clientInstanceId, assetId });
    const revisions = () => db.store.configAssets.listConfigAssetRevisions(address);
    const draft = () => db.store.configAssets.getConfigAsset(address);
    return { clientInstanceId, assetId, address, save, bundles, revisions, draft };
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
        objectKey: key(assetId, oid("a")),
        kind: "full",
        tipCommit: oid("a"),
        bytes: 100,
        sha256: oid("5"),
        createdAt: expect.any(String)
      }
    ]);
  });

  // Fails without the comparison of the base commit under the lock: both saves would land, and
  // the second would name a bundle that stands on a commit that is not the draft's parent.
  it("lets one of two saves from the same base win and tells the other that the draft moved", async () => {
    const { save, bundles, revisions, draft } = arrange("race");
    await save(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    const base = { revision: 1, commit: oid("a") };
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
      expect(await refusalOf(Promise.reject(lost[0]))).toMatchObject({
        code: "CONFLICT",
        reason: "draft_moved",
        draftCommit: outcomes[0]?.status === "fulfilled" ? left : right
      });
    }
    const written = await revisions();
    const rows = await bundles();
    expect(written).toHaveLength(6);
    // One bundle row per revision and none without: each row ends on the commit of a revision,
    // and stands on the commit of the revision before it.
    expect(rows.map((row) => row.tipCommit)).toEqual(written.map((revision) => revision.commit));
    expect(rows.slice(1).map((row) => row.prerequisiteCommit)).toEqual(
      written.slice(0, -1).map((revision) => revision.commit)
    );
    expect(rows.map((row) => row.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
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

  it("writes no bundle row when the write of the revision is refused", async () => {
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

  it("writes no revision when the bundle row cannot be written", async () => {
    // Two rows never name one object: a write that names a stored key again is refused whole.
    const { assetId, save, bundles, revisions, draft } = arrange("duplicate-key");
    await save(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    await expect(
      save(db.store.configAssets, { revision: 1, commit: oid("a") }, oid("b"), {
        bundle: {
          objectKey: key(assetId, oid("a")),
          kind: "incremental",
          bytes: 1,
          sha256: oid("5")
        }
      })
    ).rejects.toThrow();
    expect(await bundles()).toHaveLength(1);
    expect(await revisions()).toHaveLength(1);
    expect(await draft()).toMatchObject({ revision: 1, commit: oid("a") });
  });

  it("refuses the same save a second time and keeps one bundle row for it", async () => {
    const { save, bundles } = arrange("repeat");
    await save(db.store.configAssets, { revision: null, commit: null }, oid("a"));
    await save(db.store.configAssets, { revision: 1, commit: oid("a") }, oid("b"));
    expect(
      await refusalOf(save(db.store.configAssets, { revision: 1, commit: oid("a") }, oid("b")))
    ).toMatchObject({ reason: "draft_moved" });
    expect(await bundles()).toHaveLength(2);
  });

  it("refuses a first commit in an incremental bundle, and a later commit on an asset that is not there", async () => {
    const { assetId, save, bundles } = arrange("shape");
    expect(
      await refusalOf(
        save(db.store.configAssets, { revision: null, commit: null }, oid("a"), {
          bundle: {
            objectKey: key(assetId, oid("a")),
            kind: "incremental",
            bytes: 1,
            sha256: oid("5")
          }
        })
      )
    ).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      await refusalOf(save(db.store.configAssets, { revision: null, commit: oid("a") }, oid("b")))
    ).toMatchObject({ code: "CONFLICT", reason: "draft_moved" });
    expect(await bundles()).toEqual([]);
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
    const clientInstanceId: ClientInstanceId = fixture.clientInstanceId;
    const assetId = createPlatformId("cfga");
    const store = db.store.configAssets;
    const checkout = { conversationId: conversation.id, folder: "rates" };
    const write = (revision: number | null, baseCommit: string | null, commit: string) =>
      store.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "app:rates": revision },
        mutations: [
          {
            type: "upsert",
            kind: "app",
            name: "rates",
            config: { name: "rates" },
            draft: true,
            assetId,
            repository: {
              commit,
              tree: oid("e"),
              baseCommit,
              bundle: {
                objectKey: key(assetId, commit),
                kind: baseCommit === null ? "full" : "incremental",
                bytes: 1,
                sha256: oid("5")
              },
              checkout
            }
          }
        ]
      });
    const read = () => store.getAssetCheckout({ clientInstanceId, ...checkout });
    await write(null, null, oid("a"));
    expect(await read()).toEqual({ ...checkout, assetId, baseCommit: oid("a"), baseRevision: 1 });
    await write(1, oid("a"), oid("b"));
    expect(await read()).toEqual({ ...checkout, assetId, baseCommit: oid("b"), baseRevision: 2 });
    // A refused save leaves the folder on its base.
    await expect(write(1, oid("a"), oid("c"))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await read()).toMatchObject({ baseCommit: oid("b"), baseRevision: 2 });

    await store.removeConfigAsset({
      clientInstanceId,
      kind: "app",
      name: "rates",
      expectedRevision: 2
    });
    expect(await read()).toBeUndefined();
    expect(await store.listAssetRepoBundles({ clientInstanceId, assetId })).toEqual([]);
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
          bytes: Buffer.from(await readObjectBytes(objects, row.objectKey))
        }))
      );
    }

    // The order of a save: the bundle object first, then the transaction. A save that stops
    // between the two leaves an object no row names.
    it("leaves the draft where it was when a save stops after its bundle is written, and takes the repeated save as the same commit", async () => {
      const { assetId, save, bundles, revisions, draft } = arrange("crash");
      const objects = new MemoryObjectStorage();
      const first = await commitFolder(scratch, { files: source });
      if (first.result.status !== "committed" || !first.bundle) throw new Error("not committed");
      const firstBundle = first.bundle;
      await objects.put(key(assetId, first.result.commit), first.bundle.bytes);
      await save(db.store.configAssets, { revision: null, commit: null }, first.result.commit, {
        tree: first.result.tree
      });

      const edited = { ...source, "src/rates.ts": "export const rate = 2;\n" };
      const attempt = () =>
        commitFolder(scratch, {
          files: edited,
          bundles: [firstBundle],
          base: first.result.status === "committed" ? first.result.commit : null,
          time: 1_760_270_500
        });
      const stopped = await attempt();
      if (stopped.result.status !== "committed" || !stopped.bundle)
        throw new Error("not committed");
      await objects.put(key(assetId, stopped.result.commit), stopped.bundle.bytes);
      // The process stops here: no transaction.

      expect(await draft()).toMatchObject({ revision: 1, commit: first.result.commit });
      expect(await revisions()).toHaveLength(1);
      expect((await bundles()).map((row) => row.tipCommit)).toEqual([first.result.commit]);
      // A reader follows the ledger: the object nobody named is not part of the repository.
      const before = await materialise(scratch, {
        bundles: await ledgerBundles(objects, await bundles()),
        draft: first.result.commit,
        revisions: [{ number: 1, commit: first.result.commit }]
      });
      expect(before.result).toMatchObject({ status: "materialised", commits: 1 });

      const repeated = await attempt();
      if (repeated.result.status !== "committed" || !repeated.bundle)
        throw new Error("not committed");
      expect(repeated.result.commit).toBe(stopped.result.commit);
      expect(key(assetId, repeated.result.commit)).toBe(key(assetId, stopped.result.commit));
      await save(
        db.store.configAssets,
        { revision: 1, commit: first.result.commit },
        repeated.result.commit,
        { tree: repeated.result.tree }
      );
      expect(await draft()).toMatchObject({ revision: 2, commit: repeated.result.commit });
      const after = await materialise(scratch, {
        bundles: await ledgerBundles(objects, await bundles()),
        draft: repeated.result.commit,
        revisions: (await revisions()).map((revision) => ({
          number: revision.revision,
          commit: revision.commit ?? ""
        }))
      });
      expect(after.result).toMatchObject({ status: "materialised", commits: 2, revisions: 2 });
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
      await save(store, { revision: null, commit: null }, first.commit, { tree: first.tree });
      await store.publishConfigAssetRevision({ ...address, revision: 1 });
      const second = await committed(
        { ...source, "a.txt": "a\n" },
        [first.bundle],
        first.commit,
        2
      );
      await save(store, { revision: 1, commit: first.commit }, second.commit, {
        tree: second.tree
      });
      await store.discardConfigAssetDraft({ ...address, expectedRevision: 2 });
      expect(await draft()).toMatchObject({ revision: 1, commit: first.commit });

      const third = await committed({ ...source, "b.txt": "b\n" }, [first.bundle], first.commit, 3);
      await save(store, { revision: 1, commit: first.commit }, third.commit, { tree: third.tree });
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
