import { withTestSql } from "./support/test-sql";
import { waitUntil } from "./support/assertions";
import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { afterAll, describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  createPlatformId,
  type ConfigAssetMutation,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { ASSET_RELEASE_SYNC_MAX_ITEMS } from "@work-shape/catalyst-api-contract";
import { createTestInstance } from "./support/test-instance";

// What one write of the store answers and costs: the revisions it gave, the check it runs
// under its lock, the asset each base revision counts, and the statements a batch takes.

describe("one batch of the asset store", () => {
  let store: Pick<PlatformStores, "configAssets"> & { close?: () => Promise<void> };
  const statements: string[] = [];

  beforeAll(async () => {
    store = (
      await createTestInstance({
        postgres: { onStatement: (statement) => statements.push(statement) }
      })
    ).stores;
  });

  afterAll(async () => {
    await store?.close?.();
  });

  const skill = (name: string, content: string) => ({ name, content });
  const put = (
    name: string,
    content: string
  ): Extract<ConfigAssetMutation, { type: "upsert" }> => ({
    type: "upsert",
    kind: "skill",
    name,
    config: skill(name, content)
  });

  // Fails without the change: the store answered no revision, and its callers took the
  // active revision plus one, which is wrong once a draft was discarded.
  it("answers the revision it gave each asset, also after a draft was discarded", async () => {
    const clientInstanceId = createClientInstanceId();
    const assets = store.configAssets;
    const write = (base: number | null, content: string) =>
      assets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:guide": base },
        mutations: [{ ...put("guide", content), draft: true }]
      });
    const created = await write(null, "one");
    expect(created.revisions).toEqual({ "skill:guide": 1 });
    expect(created.assetIds).toEqual({ "skill:guide": expect.stringMatching(/^cfga_/u) });
    const guideId = created.assetIds["skill:guide"] ?? "";
    const first = await assets.getConfigAssetRevision({
      clientInstanceId,
      kind: "skill",
      name: "guide",
      revision: 1
    });
    // Fails without the id in the publish: the pointer moved to whatever revision had the
    // number, also one of a name that was removed and created again after the check.
    await expect(
      assets.publishConfigAssetRevision({
        clientInstanceId,
        kind: "skill",
        name: "guide",
        assetId: guideId,
        revision: 1,
        revisionId: "cfgr_another"
      })
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "revision_changed" } });
    await assets.publishConfigAssetRevision({
      clientInstanceId,
      kind: "skill",
      name: "guide",
      assetId: guideId,
      revision: 1,
      revisionId: first?.id ?? ""
    });
    expect((await write(1, "two")).revisions).toEqual({ "skill:guide": 2 });
    await assets.discardConfigAssetDraft({
      clientInstanceId,
      kind: "skill",
      name: "guide",
      assetId: guideId,
      expectedRevision: 2
    });

    // The draft is at revision 1 again, and the number 2 is never used twice.
    const next = await write(1, "three");
    expect(next.revisions).toEqual({ "skill:guide": 3 });
    await expect(
      assets.getConfigAsset({ clientInstanceId, kind: "skill", name: "guide" })
    ).resolves.toMatchObject({ revision: 3, config: { content: "three" } });
    // A delete of what is not there wrote nothing and answers no revision.
    const absent = await assets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:never": null },
      mutations: [{ type: "delete", kind: "skill", name: "never" }]
    });
    expect(absent.revisions).toEqual({});
  });

  // Fails without the asset id in the three writes: each resolved the name again under its
  // lock, so a right checked on an asset that was then removed opened the asset created under
  // the name after it, at the same revision number and with nobody asked.
  it("refuses a publish, a discard and a removal of another asset than the one that was read", async () => {
    const clientInstanceId = createClientInstanceId();
    const assets = store.configAssets;
    const create = async () => {
      const written = await assets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:guide": null },
        mutations: [{ ...put("guide", "one"), draft: true }]
      });
      return written.assetIds["skill:guide"] ?? "";
    };
    const address = { clientInstanceId, kind: "skill" as const, name: "guide" };
    const authorized = await create();
    await assets.removeConfigAsset({ ...address, assetId: authorized, expectedRevision: 1 });
    const recreated = await create();
    expect(recreated).not.toBe(authorized);
    const revision = await assets.getConfigAssetRevision({ ...address, revision: 1 });
    const changed = { code: "CONFLICT", details: { reason: "revision_changed" } };

    await expect(
      assets.publishConfigAssetRevision({
        ...address,
        assetId: authorized,
        revision: 1,
        revisionId: revision?.id ?? ""
      })
    ).rejects.toMatchObject(changed);
    await expect(
      assets.discardConfigAssetDraft({ ...address, assetId: authorized, expectedRevision: 1 })
    ).rejects.toMatchObject(changed);
    await expect(
      assets.removeConfigAsset({ ...address, assetId: authorized, expectedRevision: 1 })
    ).rejects.toMatchObject(changed);
    await expect(assets.getConfigAsset(address)).resolves.toMatchObject({ id: recreated });
  });

  // Fails without the change: a base was a number alone, so another asset of the same name at
  // the same number was written over.
  it("refuses a base revision that was read of another asset of the name", async () => {
    const clientInstanceId = createClientInstanceId();
    const assets = store.configAssets;
    const { assetIds } = await assets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:guide": null },
      mutations: [put("guide", "this database")]
    });

    await expect(
      assets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:guide": 1, "skill:beside": null },
        baseAssetIds: { "skill:guide": "cfga_of_another_database" },
        mutations: [put("guide", "stale"), put("beside", "new")]
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "asset_replaced", assets: [{ kind: "skill", name: "guide" }] }
    });
    await expect(
      assets.getConfigAsset({ clientInstanceId, kind: "skill", name: "guide" })
    ).resolves.toMatchObject({ revision: 1, config: { content: "this database" } });
    await expect(
      assets.getConfigAsset({ clientInstanceId, kind: "skill", name: "beside" })
    ).resolves.toBeUndefined();
    // The id it was read of passes.
    await assets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:guide": 1 },
      baseAssetIds: assetIds,
      mutations: [put("guide", "same asset")]
    });
  });

  // Fails without the change: the store had no check under its lock, so what a write left
  // was checked only against a set another write could change before it was written.
  it("asks the check of a write under the lock every asset write takes", async () => {
    const clientInstanceId = createClientInstanceId();
    const assets = store.configAssets;
    await assets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:one": null, "skill:two": null },
      mutations: [put("one", "1"), put("two", "1")]
    });

    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen: string[] = [];
    const first = assets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { "skill:one": 1 },
      mutations: [put("one", "2")],
      async validate(locked) {
        seen = (await locked.listActiveConfigAssets()).map((asset) => asset.name).sort();
        await held;
      }
    });
    // Another write of another asset waits for the first, whose check has not ended.
    let secondDone = false;
    const second = assets
      .applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:two": 1 },
        mutations: [{ type: "delete", kind: "skill", name: "two" }],
        async validate(locked) {
          // It sees what the first one wrote.
          const one = (await locked.listActiveConfigAssets()).find(({ name }) => name === "one");
          expect(one).toMatchObject({ revision: 2 });
        }
      })
      .then(() => {
        secondDone = true;
      });
    await withTestSql((sql) =>
      waitUntil(
        async () =>
          (
            await sql`select pid from pg_stat_activity
              where datname = current_database() and wait_event_type = 'Lock'
                and query ilike '%config_asset%'`
          ).length > 0,
        "the concurrent asset write waits on the held lock"
      )
    );
    expect(secondDone).toBe(false);
    expect(seen).toEqual(["one", "two"]);
    release();
    await first;
    await second;

    // A check that throws refuses the write, and nothing of it is stored.
    await expect(
      assets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { "skill:one": 2, "skill:three": null },
        mutations: [put("one", "3"), put("three", "1")],
        validate: () => Promise.reject(new Error("the set would be invalid"))
      })
    ).rejects.toThrow("the set would be invalid");
    await expect(
      assets.getConfigAsset({ clientInstanceId, kind: "skill", name: "one" })
    ).resolves.toMatchObject({ revision: 2 });
    await expect(
      assets.getConfigAsset({ clientInstanceId, kind: "skill", name: "three" })
    ).resolves.toBeUndefined();
  });

  // Fails without the change: each item cost two reads, a read of its highest revision and
  // two writes under the lock, so a release of 2,000 items took about 10,000 statements.
  it("writes a release of the largest size in a number of statements that does not grow with its items", async () => {
    const clientInstanceId = createClientInstanceId();
    const assets = store.configAssets;
    const names = Array.from(
      { length: ASSET_RELEASE_SYNC_MAX_ITEMS },
      (_, index) => `guide-${String(index).padStart(4, "0")}`
    );
    const batch = async (
      label: string,
      base: (name: string) => number | null,
      mutations: ConfigAssetMutation[]
    ) => {
      statements.length = 0;
      const started = performance.now();
      const result = await assets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: Object.fromEntries(
          mutations.flatMap((mutation) =>
            mutation.type === "setDefaultAgent"
              ? []
              : [[`skill:${mutation.name}`, base(mutation.name)]]
          )
        ),
        mutations
      });
      const milliseconds = Math.round(performance.now() - started);
      const count = statements.length;
      console.info(
        `asset store batch (${label}): ${mutations.length} items, ${count} statements, ${milliseconds} ms`
      );
      return { result, count, milliseconds };
    };

    const created = await batch(
      "create",
      () => null,
      names.map((name) => put(name, "one"))
    );
    const updated = await batch(
      "update",
      () => 1,
      names.map((name) => put(name, "two"))
    );
    const mixed = await batch(
      "delete half, update half",
      () => 2,
      names.map((name, index) =>
        index % 2 === 0 ? { type: "delete", kind: "skill", name } : put(name, "three")
      )
    );
    const small = await batch(
      "200 updates",
      () => 3,
      names
        .filter((_, index) => index % 2 === 1)
        .slice(0, 200)
        .map((name) => put(name, "four"))
    );

    // The lock, the rows and the highest revisions in one read each, then one statement per
    // table and 500 rows. Ten times the items cost a few statements more, not ten times.
    expect(created.count).toBeLessThanOrEqual(20);
    expect(updated.count).toBeLessThanOrEqual(20);
    expect(mixed.count).toBeLessThanOrEqual(22);
    expect(small.count).toBeLessThanOrEqual(12);
    expect(updated.count - small.count).toBeLessThanOrEqual(8);
    // Generous: it holds the batch to seconds on a loaded machine, not to a benchmark.
    expect(updated.milliseconds).toBeLessThan(20_000);

    expect(Object.keys(updated.result.revisions)).toHaveLength(ASSET_RELEASE_SYNC_MAX_ITEMS);
    expect(new Set(Object.values(updated.result.revisions))).toEqual(new Set([2]));
    const left = await assets.listActiveConfigAssets({ clientInstanceId, kind: "skill" });
    expect(left).toHaveLength(ASSET_RELEASE_SYNC_MAX_ITEMS / 2);
    expect(left.find(({ name }) => name === "guide-0001")).toMatchObject({
      revision: 4,
      config: { content: "four" }
    });
    expect(left.find(({ name }) => name === "guide-1999")).toMatchObject({
      revision: 3,
      config: { content: "three" }
    });
    await expect(
      assets.getConfigAsset({ clientInstanceId, kind: "skill", name: "guide-0000" })
    ).resolves.toMatchObject({ status: "deleted", revision: 3, config: null });
  });
});

function createClientInstanceId() {
  return asClientInstanceId(createPlatformId("client"));
}
