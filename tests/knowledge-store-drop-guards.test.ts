import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  DATA_STORE_JOB_KINDS,
  KNOWLEDGE_BASE_ASSET_KIND,
  type BuiltinKnowledgeTarget,
  type DataStoreRecord,
  type JobControl,
  type Logger
} from "@work-shape/catalyst-core";
import { deferred, required } from "./support/assertions";
import { useDataStoreWorld } from "./support/data-store-world";

// The drop of the store a deleted Knowledge Base owned, at the seam of the package: it drops
// only the database and the roles the store's id gives and no other record names, and a
// provisioning that a delete overtakes leaves nothing behind. Each job here runs by hand, so a
// test holds it at a step of its own choosing.

const silent: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => silent
};

describe("the drop of a Knowledge Base's store", () => {
  const { db, setup, published, recordOf, connect } = useDataStoreWorld("kb_store_drop");

  type World = Awaited<ReturnType<typeof setup>>;

  /** A Knowledge Base without a backend, written as a draft so that its asset has an id. */
  async function target(world: World, name: string): Promise<BuiltinKnowledgeTarget> {
    const key = `${KNOWLEDGE_BASE_ASSET_KIND}:${name}`;
    const written = await db.store.configAssets.applyConfigAssetMutations({
      clientInstanceId: world.clientInstanceId,
      baseRevisions: { [key]: null },
      mutations: [
        {
          type: "upsert",
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name,
          config: { name, title: name, description: "Documents.", methods: ["keyword"] },
          draft: true
        }
      ]
    });
    return {
      backend: "builtin",
      assetId: required(written.assetIds[key]),
      name,
      methods: ["keyword"]
    };
  }

  /** Publishing the Knowledge Base: the record of its store and its provisioning job. */
  const make = (world: World, kb: BuiltinKnowledgeTarget) =>
    db.store.transaction((stores) => world.dataStores.knowledgeBackend.grant(stores, kb));
  /** Deleting the Knowledge Base: the store retired and its drop queued. */
  const remove = (world: World, kb: BuiltinKnowledgeTarget) =>
    db.store.transaction((stores) => world.dataStores.knowledgeBackend.retire(stores, kb));

  /**
   * One attempt of a job of the store, run by hand. With `hold`, the attempt waits before its
   * transaction of that number until `release` is called; `held` resolves once it waits there.
   */
  async function attempt(world: World, kind: string, storeId: string, hold?: number) {
    const handler = required(world.dataStores.jobHandlers.find((each) => each.kind.kind === kind));
    const job = await db.store.jobs.enqueue(
      handler.kind,
      { storeId },
      { clientInstanceId: world.clientInstanceId, dedupeKey: `test:${randomUUID()}` }
    );
    const held = deferred<void>();
    const gate = deferred<void>();
    let transactions = 0;
    const control: JobControl = {
      leaseToken: randomUUID(),
      signal: new AbortController().signal,
      attempt: 1,
      logger: silent,
      async transaction(work) {
        transactions += 1;
        if (transactions === hold) {
          held.resolve();
          await gate.promise;
        }
        return db.store.transaction(work);
      }
    };
    const run = handler.bind(job).run(control);
    // A rejection is read by the test that awaits `run`; until then it is not unhandled.
    run.catch(() => undefined);
    return { run, held: held.promise, release: () => gate.resolve() };
  }

  async function objectsOf(names: Pick<DataStoreRecord, "location" | "roles">) {
    const server = connect("postgres");
    const databases =
      await server`select 1 from pg_database where datname = ${names.location.database}`;
    const roles = await server<{ name: string }[]>`
      select rolname as name from pg_roles
      where rolname = any(${[names.roles.app, names.roles.migration]}) order by 1`;
    return { database: databases.length === 1, roles: roles.map((role) => role.name) };
  }

  /** The object ids of the store's database and roles: a store made again has new ones. */
  async function oidsOf(names: Pick<DataStoreRecord, "location" | "roles">) {
    const server = connect("postgres");
    const [row] = await server<
      { database: string | null; app: string | null; migration: string | null }[]
    >`
      select
        (select oid::text from pg_database where datname = ${names.location.database}) as database,
        (select oid::text from pg_roles where rolname = ${names.roles.app}) as app,
        (select oid::text from pg_roles where rolname = ${names.roles.migration}) as migration`;
    return required(row);
  }

  it("drops nothing of another store a re-pointed record names", async () => {
    const other = await published("drop_repoint");
    const kb = await target(other, "repointed");
    await make(other, kb);
    const own = await recordOf(other, kb.assetId);
    await required(await attempt(other, DATA_STORE_JOB_KINDS.provision, kb.assetId)).run;
    expect(await objectsOf(own)).toMatchObject({ database: true });

    // The record of the Knowledge Base's store is pointed at the database of a store of its own.
    await db.store.dataStores.putDataStore({
      ...(await recordOf(other, kb.assetId)),
      location: other.record.location,
      roles: other.record.roles
    });
    await remove(other, kb);
    const dropped = await attempt(other, DATA_STORE_JOB_KINDS.drop, kb.assetId);

    await expect(dropped.run).rejects.toMatchObject({
      details: { reason: "store_names_not_its_own" }
    });
    expect(await objectsOf(other.record)).toEqual({
      database: true,
      roles: [other.record.roles.app, other.record.roles.migration].sort()
    });
    expect(await recordOf(other, other.id)).toMatchObject({ status: "ready" });
    expect(await recordOf(other, kb.assetId)).toMatchObject({ status: "retired" });
    const audit = await db.store.audit.listAuditEvents({
      clientInstanceId: other.clientInstanceId,
      type: "data_store.dropped"
    });
    expect(audit).toEqual([
      expect.objectContaining({
        status: "failed",
        subject: kb.assetId,
        reason: "store_names_not_its_own"
      })
    ]);

    // Its own database and roles stay too: an operator settles the record.
    expect(await objectsOf(own)).toMatchObject({ database: true });
  });

  it("drops nothing another store's record names", async () => {
    const other = await published("drop_shared");
    const kb = await target(other, "shared");
    await make(other, kb);
    const own = await recordOf(other, kb.assetId);
    await required(await attempt(other, DATA_STORE_JOB_KINDS.provision, kb.assetId)).run;

    // The record of a store of its own names the Knowledge Base store's database.
    await db.store.dataStores.putDataStore({
      ...other.record,
      location: own.location,
      roles: own.roles
    });
    await remove(other, kb);
    const dropped = await attempt(other, DATA_STORE_JOB_KINDS.drop, kb.assetId);

    await expect(dropped.run).rejects.toMatchObject({ details: { reason: "store_names_shared" } });
    expect(await objectsOf(own)).toEqual({
      database: true,
      roles: [own.roles.app, own.roles.migration].sort()
    });
  });

  it("leaves nothing when the drop is done before a held provisioning goes on", async () => {
    const world = await setup("drop_after_claim");
    const kb = await target(world, "overtaken");
    await make(world, kb);
    const record = await recordOf(world, kb.assetId);

    // Provisioning has claimed the store and waits before it makes anything.
    const provisioning = await attempt(world, DATA_STORE_JOB_KINDS.provision, kb.assetId, 2);
    await provisioning.held;
    await remove(world, kb);
    await (
      await attempt(world, DATA_STORE_JOB_KINDS.drop, kb.assetId)
    ).run;
    expect(
      await db.store.dataStores.getDataStore({
        clientInstanceId: world.clientInstanceId,
        id: kb.assetId
      })
    ).toBeUndefined();

    provisioning.release();
    await provisioning.run;

    expect(await objectsOf(record)).toEqual({ database: false, roles: [] });
  });

  it("leaves nothing when a held provisioning goes on while the drop is under way", async () => {
    const world = await setup("drop_under_way");
    const kb = await target(world, "underway");
    await make(world, kb);
    const record = await recordOf(world, kb.assetId);

    const provisioning = await attempt(world, DATA_STORE_JOB_KINDS.provision, kb.assetId, 2);
    await provisioning.held;
    await remove(world, kb);
    // The drop dropped what there was and waits before it removes the record.
    const dropping = await attempt(world, DATA_STORE_JOB_KINDS.drop, kb.assetId, 3);
    await dropping.held;

    provisioning.release();
    await provisioning.run;
    dropping.release();
    await dropping.run;

    expect(await objectsOf(record)).toEqual({ database: false, roles: [] });
    expect(
      await db.store.dataStores.getDataStore({
        clientInstanceId: world.clientInstanceId,
        id: kb.assetId
      })
    ).toBeUndefined();
  });

  it("provisions a store made again while a held provisioning was about to write, with its own database and roles", async () => {
    const world = await setup("drop_made_again");
    const kb = await target(world, "again");
    await make(world, kb);
    const first = await recordOf(world, kb.assetId);

    // Provisioning made everything, read the record again, and waits before it writes it ready.
    const provisioning = await attempt(world, DATA_STORE_JOB_KINDS.provision, kb.assetId, 4);
    await provisioning.held;
    const old = await oidsOf(first);
    expect(old).toEqual({
      database: expect.any(String),
      app: expect.any(String),
      migration: expect.any(String)
    });
    // The Knowledge Base is deleted, its store dropped, and it is published again.
    await remove(world, kb);
    await (
      await attempt(world, DATA_STORE_JOB_KINDS.drop, kb.assetId)
    ).run;
    await make(world, kb);
    const second = await recordOf(world, kb.assetId);
    expect(second).toMatchObject({ status: "provisioning" });
    expect(second.createdAt).not.toBe(first.createdAt);

    provisioning.release();
    await expect(provisioning.run).rejects.toMatchObject({
      details: { reason: "store_made_again" }
    });
    // The job's next attempt provisions the new record.
    await (
      await attempt(world, DATA_STORE_JOB_KINDS.provision, kb.assetId)
    ).run;

    expect(await recordOf(world, kb.assetId)).toMatchObject({
      status: "ready",
      createdAt: second.createdAt
    });
    const made = await oidsOf(second);
    expect(made).toEqual({
      database: expect.any(String),
      app: expect.any(String),
      migration: expect.any(String)
    });
    expect(made.database).not.toBe(old.database);
    expect(made.app).not.toBe(old.app);
    expect(made.migration).not.toBe(old.migration);
  });
});
