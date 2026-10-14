import { describe, expect, it } from "vitest";
import { eventually } from "./support/assertions";
import { init, manifest, refusal, sqlState, useDataStoreWorld } from "./support/data-store-world";

// pgvector in the database of a store (ADR-0023): the platform's role creates it, only where
// it is asked to, and no role of a store can create it, here or in another store. The suite's
// server is the instance's Postgres image, which the checks start.

describe("pgvector in a Data Store", () => {
  const {
    db,
    platformDatabase,
    setup,
    publish,
    recordOf,
    published,
    connect,
    takeOver,
    platformRole
  } = useDataStoreWorld("data_store_vector");
  const signal = new AbortController().signal;

  const vectorIn = async (database: string) =>
    (
      await connect(database)<{ extversion: string }[]>`
        select extversion from pg_extension where extname = 'vector'`
    ).map((row) => row.extversion);

  it("is created by the platform's role in the store it is asked for and in no other database", async () => {
    const [offered] = await db.sql<{ version: string; trusted: boolean }[]>`
      select v.version, v.trusted
      from pg_available_extensions e
      join pg_available_extension_versions v on v.name = e.name and v.version = e.default_version
      where e.name = 'vector'`;
    expect(
      offered,
      "the server of the checks is the instance's image, which has pgvector"
    ).toBeDefined();

    const semantic = await published("vector_semantic");
    const plain = await published("vector_plain");
    await semantic.dataStores.ensureVectorExtension(semantic.id, signal);
    // A second attempt, as a retried job makes it, finds what is there.
    await semantic.dataStores.ensureVectorExtension(semantic.id, signal);

    expect(await vectorIn(semantic.record.location.database)).toEqual([offered?.version]);
    expect(await vectorIn(plain.record.location.database)).toEqual([]);
    expect(await vectorIn(platformDatabase())).toEqual([]);

    // The store's own roles use it: the migration role makes a table with an embedding and
    // the app role ranks by cosine distance.
    const migration = connect(
      semantic.record.location.database,
      await takeOver(semantic.record.roles.migration)
    );
    await migration`create table chunks (id integer primary key, embedding halfvec(3) not null)`;
    const app = connect(
      semantic.record.location.database,
      await takeOver(semantic.record.roles.app)
    );
    await app`insert into chunks values (1, '[1,0,0]'), (2, '[0,1,0]'), (3, '[0.9,0.1,0]')`;
    const nearest = await app<{ id: number }[]>`
      select id from chunks order by embedding <=> '[1,0.05,0]' limit 2`;
    expect(nearest.map((row) => row.id)).toEqual([1, 3]);
    // It is the platform's: no role of the store changes or drops it.
    expect(await sqlState(app`drop extension vector`)).toBe("42501");
    expect(await sqlState(migration`drop extension vector`)).toBe("42501");
    expect(await sqlState(migration`alter extension vector update`)).toBe("42501");
  });

  it("cannot be created by a role of a store, trusted or not", async () => {
    const plain = await published("vector_store_roles");
    const { database } = plain.record.location;
    for (const role of [plain.record.roles.app, plain.record.roles.migration]) {
      const [privilege] = await db.sql<{ create: boolean }[]>`
        select has_database_privilege(${role}, ${database}, 'CREATE') as create`;
      expect(privilege?.create, role).toBe(false);
    }
    const migration = connect(database, await takeOver(plain.record.roles.migration));
    expect(await sqlState(migration`create extension vector`)).toBe("42501");
    expect(await vectorIn(database)).toEqual([]);
  });

  it("stops with a reason when the platform's role may not create it, and finds what the operator made", async () => {
    const [offered] = await db.sql<{ version: string; trusted: boolean }[]>`
      select v.version, v.trusted from pg_available_extensions e
      join pg_available_extension_versions v on v.name = e.name and v.version = e.default_version
      where e.name = 'vector'`;
    // On the instance's image it is not trusted, so only a superuser creates it.
    expect(offered?.trusted).toBe(false);
    // A platform role as an operator's instance may have one: no superuser, with what
    // provisioning needs (the README of the package names it).
    const { name, databaseUrl } = await platformRole();
    await db.sql.unsafe(`alter role "${name}" createdb createrole`);
    await db.sql.unsafe(`alter database "${platformDatabase()}" owner to "${name}"`);
    const world = await setup("vector_not_superuser", {}, databaseUrl);
    const id = await publish(world, [manifest(), init]);
    const record = await eventually(async () => {
      await world.worker.runDue();
      const current = await recordOf(world, id);
      expect(current.status).toBe("ready");
      return current;
    });

    await expect(world.dataStores.ensureVectorExtension(id, signal)).rejects.toMatchObject({
      code: "vector_extension_not_permitted",
      message: expect.stringContaining("only a superuser creates it")
    });
    expect(await vectorIn(record.location.database)).toEqual([]);

    // The operator follows the reason, as a superuser in the store's database, and the next
    // attempt finds the extension there.
    await connect(record.location.database)`create extension vector with schema public`;
    await expect(world.dataStores.ensureVectorExtension(id, signal)).resolves.toBeUndefined();
    expect(await vectorIn(record.location.database)).toEqual([offered?.version]);
  });

  it("is refused for a store that does not exist", async () => {
    const world = await setup("vector_unknown");
    expect(
      await refusal(world.dataStores.ensureVectorExtension("ast_unknown", signal))
    ).toMatchObject({ code: "NOT_FOUND" });
  });
});
