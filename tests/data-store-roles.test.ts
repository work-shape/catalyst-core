import { describe, expect, it } from "vitest";
import { eventually } from "./support/assertions";
import {
  finding,
  init,
  manifest,
  refusal,
  sqlState,
  useDataStoreWorld
} from "./support/data-store-world";

// The boundary of a Data Store is in Postgres: what the platform's own role needs to make a
// store, what the app role and the migration role of a store can and cannot do, and the
// limits Postgres itself holds them to. Each refusal is attempted as that role.

describe("the roles of a Data Store", () => {
  const {
    db,
    platformDatabase,
    setup,
    publish,
    recordOf,
    settle,
    published,
    call,
    connect,
    takeOver,
    platformRole
  } = useDataStoreWorld("data_store_roles");

  it("provisions as a platform role that is no superuser, once it has what the README names", async () => {
    // The role an operator's instance connects as: it may log in and nothing more, and
    // `PUBLIC` connects to the platform database as on a server nobody hardened.
    const { name, databaseUrl } = await platformRole();
    await db.sql.unsafe(`grant connect on database "${platformDatabase()}" to public`);
    const world = await setup("platform_role", {}, databaseUrl);
    const attempt = async (sizeLimit: string) => {
      const id = await publish(world, [manifest(`sizeLimit: ${sizeLimit}\n`), init]);
      const sizeLimitBytes = Number(sizeLimit.replace("GB", "")) * 1024 ** 3;
      return eventually(async () => {
        await world.worker.runDue();
        const record = await recordOf(world, id);
        expect(record.sizeLimitBytes).toBe(sizeLimitBytes);
        expect(record.status === "ready" || record.failure !== undefined).toBe(true);
        return record;
      });
    };

    expect(await attempt("1GB")).toMatchObject({
      status: "provisioning",
      failure: {
        code: "platform_role_lacks_privilege",
        message:
          "The platform's database role may not create the database or the roles of a Data Store. Grant it CREATEDB and CREATEROLE; publishing the store again then provisions it."
      }
    });

    await db.sql.unsafe(`alter role "${name}" createdb createrole`);
    expect(await attempt("2GB")).toMatchObject({
      status: "provisioning",
      failure: { code: "platform_database_open" }
    });

    await db.sql.unsafe(`alter database "${platformDatabase()}" owner to "${name}"`);
    const ready = await attempt("3GB");
    expect(ready.status).toBe("ready");
    expect(ready.failure).toBeUndefined();
    await settle(world, ready.id, 1);
    await call(world, "insert", { table: "findings", rows: [finding(1)] });
    expect(
      await call(world, "query", { sql: "select count(*)::integer as count from findings" })
    ).toMatchObject({ rows: [{ count: 1 }] });
  });

  it("lets the app role read and write rows and nothing else", async () => {
    const world = await published("app_role");
    const other = await setup("app_role_other");
    const otherRecord = await settle(other, await publish(other, [manifest(), init]), 1);
    const { record } = world;
    // Through the platform: the app role does not read the store's own bookkeeping.
    expect(
      await refusal(call(world, "query", { sql: "select * from catalyst.migrations" }))
    ).toMatchObject({
      message: "The query needs a privilege its role does not hold (SQLSTATE 42501)."
    });

    const appRole = await takeOver(record.roles.app);
    const app = connect(record.location.database, appRole);
    await app`insert into findings (run_id, client_id, rule_id, revision, severity)
      values ('r', 'c', 'rule', 1, 'info')`;
    expect(await app`select client_id from findings`).toHaveLength(1);
    await app`update findings set severity = 'error'`;

    const denied = "42501";
    expect(await sqlState(app`create table other (id integer)`)).toBe(denied);
    expect(await sqlState(app`create temporary table scratch (id integer)`)).toBe(denied);
    expect(await sqlState(app`alter table findings add column note text`)).toBe(denied);
    expect(await sqlState(app`drop table findings`)).toBe(denied);
    expect(await sqlState(app`truncate findings`)).toBe(denied);
    expect(await sqlState(app`create schema mine`)).toBe(denied);
    expect(await sqlState(app`create role intruder`)).toBe(denied);
    expect(await sqlState(app`insert into catalyst.migrations values (9, 'x', 'y')`)).toBe(denied);

    // Neither the platform's database nor another store's lets the role in.
    expect(await sqlState(connect(platformDatabase(), appRole)`select 1`)).toBe(denied);
    expect(await sqlState(connect(otherRecord.location.database, appRole)`select 1`)).toBe(denied);
  });

  it("lets the migration role change the schema and keeps it out of the platform database", async () => {
    const world = await published("migration_role");
    const { record } = world;
    const migrationRole = await takeOver(record.roles.migration);
    expect(await sqlState(connect(platformDatabase(), migrationRole)`select 1`)).toBe("42501");

    const migration = connect(record.location.database, migrationRole);
    await migration`create table notes (id integer)`;
    expect(await sqlState(migration`create schema mine`)).toBe("42501");
    expect(await sqlState(migration`delete from catalyst.migrations`)).toBe("42501");
    expect(await sqlState(migration`create role intruder`)).toBe("42501");
    // What the migration role creates, the app role reads and writes without a grant per table.
    const inStore = connect(record.location.database);
    const [privilege] = await inStore<{ reads: boolean; writes: boolean; alters: boolean }[]>`
      select has_table_privilege(${record.roles.app}, 'public.notes', 'SELECT') as reads,
        has_table_privilege(${record.roles.app}, 'public.notes', 'INSERT') as writes,
        has_table_privilege(${record.roles.app}, 'public.notes', 'TRUNCATE') as alters`;
    expect(privilege).toEqual({ reads: true, writes: true, alters: false });
  });

  it("holds each role to the statement timeout and connection limit Postgres keeps for it", async () => {
    const world = await published("role_limits");
    const { record } = world;
    // The limits are the role's own settings. Shortened here so that the test meets them soon.
    await db.sql.unsafe(`alter role "${record.roles.app}" set statement_timeout = 200`);
    await db.sql.unsafe(`alter role "${record.roles.app}" connection limit 1`);

    const appRole = await takeOver(record.roles.app);
    const first = connect(record.location.database, appRole);
    expect(await sqlState(first`select pg_sleep(5)`)).toBe("57014");
    expect(await sqlState(connect(record.location.database, appRole)`select 1`)).toBe("53300");
  });

  it("opens no more connections to a store than the pool cap of release config, under 50 calls at once", async () => {
    const most = async (label: string, limits?: { poolMaxConnections: number }) => {
      const world = await setup(label, limits);
      const record = await settle(world, await publish(world, [manifest(), init]), 1);
      let seen = 0;
      let sampling = true;
      const sample = (async () => {
        while (sampling) {
          const [open] = await db.sql<{ count: number }[]>`
            select count(*)::integer as count from pg_stat_activity
            where usename = ${record.roles.app}`;
          seen = Math.max(seen, open?.count ?? 0);
        }
      })();
      const answers = await Promise.all(
        Array.from({ length: 50 }, () =>
          call(world, "query", { sql: "select pg_sleep(0.1)::text as slept" })
        )
      );
      sampling = false;
      await sample;
      // Every call waited for one of the connections and was answered.
      expect(answers).toHaveLength(50);
      return seen;
    };

    // Five by default, as the spec has it, and what the operator names otherwise.
    expect(await most("pool_default")).toBe(5);
    expect(await most("pool_lowered", { poolMaxConnections: 2 })).toBe(2);
  });
});
