import { describe, expect, it } from "vitest";
import { DATA_STORE_ASSET_KIND } from "@vivd-catalyst/core";
import { eventually } from "./support/assertions";
import {
  INIT_SQL,
  init,
  finding,
  manifest,
  refusal,
  sqlState,
  useDataStoreWorld,
  type StoreFile
} from "./support/data-store-world";

// The migrations of a Data Store against real Postgres: they move forward only, each is
// applied whole or not at all, and the record of what was applied is the platform's. A
// migration is held to its transaction and to its role whatever its text says.

describe("the migrations of a Data Store", () => {
  const { db, publish, recordOf, settle, published, call, connect } =
    useDataStoreWorld("data_store_migrations");

  it("applies new migrations forward and never changes an applied one", async () => {
    const world = await published("migrations");
    const { id } = world;
    await call(world, "insert", { table: "findings", rows: [finding(1)] });
    const second: StoreFile = {
      path: "migrations/0002_reviewed.sql",
      text: "alter table findings add column reviewed boolean not null default false;"
    };

    await publish(world, [manifest(), init, second]);
    const atTwo = await settle(world, id, 2);
    expect(atTwo.migrations.map((migration) => migration.name)).toEqual(["init", "reviewed"]);
    expect(await call(world, "query", { sql: "select reviewed from findings" })).toMatchObject({
      rows: [{ reviewed: false }]
    });

    // A changed file that the store has applied refuses the publish, and nothing moves.
    const changed = { ...init, text: `${INIT_SQL}\n-- changed` };
    await expect(publish(world, [manifest(), changed, second])).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message:
        "The store has applied 'migrations/0001_init.sql' and the revision holds 'migrations/0001_init.sql' with other content. An applied migration is never changed: add a new migration instead.",
      details: { reason: "applied_migration_changed" }
    });
    await expect(publish(world, [manifest(), init])).rejects.toMatchObject({
      message: expect.stringContaining("has applied 'migrations/0002_reviewed.sql'")
    });
    const asset = await db.store.configAssets.getConfigAsset({
      clientInstanceId: world.clientInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name: "findings"
    });
    expect(asset?.publishedRevision).toBe(atTwo.targetRevision);
    expect(await recordOf(world, id)).toMatchObject({
      level: 2,
      targetRevision: atTwo.targetRevision
    });

    // A migration that fails leaves the level and says which file failed, without its SQL.
    const failing: StoreFile = {
      path: "migrations/0003_owner.sql",
      text: "alter table findings add column owner text; alter table nowhere add column x text;"
    };
    await publish(world, [manifest(), init, second, failing]);
    const failed = await eventually(async () => {
      await world.worker.runDue();
      const record = await recordOf(world, id);
      expect(record.failure).toBeDefined();
      return record;
    });
    expect(failed).toMatchObject({
      status: "ready",
      level: 2,
      failure: {
        code: "migration_failed",
        message:
          "'migrations/0003_owner.sql' names a table or view that does not exist (SQLSTATE 42P01)."
      }
    });
    // The failed file left nothing behind: its first statement was rolled back with it.
    expect(
      await refusal(call(world, "query", { sql: "select owner from findings" }))
    ).toMatchObject({
      message: "The query names a column that does not exist (SQLSTATE 42703)."
    });

    const fixed = { ...failing, text: "alter table findings add column owner text;" };
    await publish(world, [manifest(), init, second, fixed]);
    const atThree = await settle(world, id, 3);
    expect(atThree.failure).toBeUndefined();
    expect(
      await call(world, "query", { sql: "select owner, reviewed from findings" })
    ).toMatchObject({
      rows: [{ owner: null, reviewed: false }]
    });
  });

  // Text the check of a migration cannot read, such as a statement a block puts together,
  // meets the runner: it holds the migration in its transaction whatever the text says.
  const hidden = (statement: string, parts = 2) => {
    const cut = Math.ceil(statement.length / parts);
    const pieces = [statement.slice(0, cut), statement.slice(cut)].map(
      (piece) => `'${piece.replaceAll("'", "''")}'`
    );
    return `do $hidden$ begin execute ${pieces.join(" || ")}; end $hidden$;`;
  };
  const failureOf = (world: Awaited<ReturnType<typeof published>>) =>
    eventually(async () => {
      await world.worker.runDue();
      const record = await recordOf(world, world.id);
      expect(record.failure).toBeDefined();
      return record;
    });

  it("keeps a migration in one transaction when its text ends the transaction out of sight", async () => {
    const world = await published("atomic");
    const second = (text: string): StoreFile => ({ path: "migrations/0002_halves.sql", text });

    await publish(world, [
      manifest(),
      init,
      second(
        `create table half_a (id integer); ${hidden("commit")} create table half_b (id integer); select 1/0;`
      )
    ]);
    const failed = await failureOf(world);

    expect(failed).toMatchObject({
      level: 1,
      failure: {
        code: "migration_failed",
        message:
          "'migrations/0002_halves.sql' asks for something the database does not support (SQLSTATE 0A000)."
      }
    });
    // Nothing of the file stayed, so the corrected file applies.
    expect(await refusal(call(world, "query", { sql: "select * from half_a" }))).toMatchObject({
      details: { sqlState: "42P01" }
    });
    await publish(world, [
      manifest(),
      init,
      second("create table half_a (id integer); create table half_b (id integer);")
    ]);
    expect(await settle(world, world.id, 2)).toMatchObject({ level: 2 });
  });

  it("refuses a migration that changes the settings of its role, and holds the role to its password", async () => {
    const world = await published("own_role");
    const { record } = world;
    const settingsOf = async () =>
      (
        await db.sql<{ rolconfig: string[] }[]>`
          select rolconfig from pg_roles where rolname = ${record.roles.migration}`
      )[0]?.rolconfig;
    const before = await settingsOf();

    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_unbound.sql",
        text: hidden("alter role current_user set statement_timeout = 0")
      }
    ]);
    expect(await failureOf(world)).toMatchObject({
      level: 1,
      failure: {
        code: "migration_changed_role",
        message:
          "'migrations/0002_unbound.sql' changed the settings of a role of its store. Nothing of it was applied."
      }
    });
    expect(await settingsOf()).toEqual(before);

    // A password is the role's own to change and Postgres shows nobody that it did: after
    // every migration the platform sets the one it holds again.
    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_password.sql",
        text: hidden("alter role current_user password 'taken-over-by-a-migration'")
      }
    ]);
    await settle(world, world.id, 2);
    const takenOver = connect(record.location.database, {
      name: record.roles.migration,
      password: "taken-over-by-a-migration"
    });
    expect(await sqlState(takenOver`select 1`)).toBe("28P01");
  });

  it("ignores a row a migration wrote into the platform's record of applied migrations", async () => {
    const world = await published("ghost");

    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_ghost.sql",
        text: hidden(
          "insert into catalyst.migrations (number, name, sha256, proof) values (3, 'ghost', 'x', 'y')"
        )
      }
    ]);
    await settle(world, world.id, 2);
    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_ghost.sql",
        text: hidden(
          "insert into catalyst.migrations (number, name, sha256, proof) values (3, 'ghost', 'x', 'y')"
        )
      },
      { path: "migrations/0003_notes.sql", text: "create table notes (id integer);" }
    ]);

    const atThree = await settle(world, world.id, 3);
    expect(atThree.failure).toBeUndefined();
    expect(atThree.migrations.map((migration) => migration.name)).toEqual([
      "init",
      "ghost",
      "notes"
    ]);
  });
  it("reads its record whole, however many rows a migration added to it", async () => {
    const world = await published("flood");
    const flood: StoreFile = {
      path: "migrations/0002_flood.sql",
      // More rows than any bound on a read, each sorting before the platform's own, some
      // under a number no migration has. The name of the table is put together as it runs.
      text: [0, -1]
        .map((number) =>
          hidden(
            `insert into catalyst.migrations (number, name, sha256, proof) select ${number}, 'ghost', 'x', 'y' from generate_series(1, 6000)`
          )
        )
        .join("\n")
    };

    await publish(world, [manifest(), init, flood]);
    await settle(world, world.id, 2);
    await publish(world, [
      manifest(),
      init,
      flood,
      { path: "migrations/0003_notes.sql", text: "create table notes (id integer);" }
    ]);

    expect((await settle(world, world.id, 3)).failure).toBeUndefined();
  });

  it("runs nothing when the key of its record is lost or the record in the store falls short of the platform's", async () => {
    const next: StoreFile = {
      path: "migrations/0002_notes.sql",
      text: "create table notes (id integer);"
    };
    const stopped = async (
      label: string,
      lose: (id: string, database: string) => Promise<void>
    ) => {
      const world = await published(label);
      await lose(world.id, world.record.location.database);
      await publish(world, [manifest(), init, next]);
      const record = await failureOf(world);
      // Neither the first migration again nor the next one: the store is as it was.
      expect(await refusal(call(world, "query", { sql: "select * from notes" }))).toMatchObject({
        details: { sqlState: "42P01" }
      });
      return { level: record.level, failure: record.failure };
    };
    const keyLost = {
      level: 1,
      failure: {
        code: "ledger_key_lost",
        message:
          "The store has applied 1 migration and the key that signs its record of them cannot be read from the Secret Store. No migration was run. Restore the Secret Store key the record was written with."
      }
    };

    expect(
      await stopped("key_gone", async (id) => {
        await db.sql`delete from secrets where connection_asset_id = ${id} and subject = 'data_store:ledger'`;
      })
    ).toEqual(keyLost);
    expect(
      await stopped("key_unreadable", async (id) => {
        await db.sql`
          update secrets set ciphertext = decode(repeat('00', octet_length(ciphertext)), 'hex')
          where connection_asset_id = ${id} and subject = 'data_store:ledger'`;
      })
    ).toEqual(keyLost);
    expect(
      await stopped("ledger_short", async (_id, database) => {
        await connect(database)`delete from catalyst.migrations`;
      })
    ).toEqual({
      level: 1,
      failure: {
        code: "ledger_mismatch",
        message:
          "The platform has recorded 1 applied migration for the store and the record in the store's database holds 0 of them. No migration was run. The database was changed or restored apart from the platform's record."
      }
    });
  });

  it("refuses the migration whose deferred trigger changes its role when the transaction ends", async () => {
    const world = await published("deferred");
    const { record } = world;
    const settingsOf = async () =>
      (
        await db.sql<{ rolconfig: string[] }[]>`
          select rolconfig from pg_roles where rolname = ${record.roles.migration}`
      )[0]?.rolconfig;
    const before = await settingsOf();

    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_deferred.sql",
        text: `create table late (id integer);
          create function unbind() returns trigger language plpgsql as $f$
            begin execute 'alter ro' || 'le current_user set statement_timeout = 0'; return null; end $f$;
          create constraint trigger at_the_end after insert on late
            deferrable initially deferred for each row execute function unbind();
          insert into late values (1);`
      }
    ]);

    expect(await failureOf(world)).toMatchObject({
      level: 1,
      failure: { code: "migration_changed_role" }
    });
    expect(await settingsOf()).toEqual(before);
    expect(await refusal(call(world, "query", { sql: "select * from late" }))).toMatchObject({
      details: { sqlState: "42P01" }
    });
  });

  it("clears a setting a role carries for another database before a migration, and blames no later migration for it", async () => {
    const world = await published("per_database");
    const { record } = world;
    await db.sql.unsafe(
      `alter role "${record.roles.migration}" in database postgres set work_mem = '1MB'`
    );

    await publish(world, [
      manifest(),
      init,
      { path: "migrations/0002_notes.sql", text: "create table notes (id integer);" }
    ]);

    expect((await settle(world, world.id, 2)).failure).toBeUndefined();
    const [left] = await db.sql<{ count: number }[]>`
      select count(*)::integer as count from pg_db_role_setting s
      join pg_roles r on r.oid = s.setrole
      where r.rolname = ${record.roles.migration} and s.setdatabase <> 0`;
    expect(left?.count).toBe(0);
  });

  it("names an error of the author as what it is, not as transaction control", async () => {
    const world = await published("author_error");

    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_far.sql",
        text: "create table far as select * from elsewhere.public.findings;"
      }
    ]);

    expect((await failureOf(world)).failure).toEqual({
      code: "migration_failed",
      message:
        "'migrations/0002_far.sql' asks for something the database does not support (SQLSTATE 0A000)."
    });
  });
  it("looks at the roles with the database's own functions, whatever a migration put in their place", async () => {
    const world = await published("shadowed");

    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_shadow.sql",
        // A count of its own that finds nothing, ahead of the database's in the search path.
        text: `create function public.nothing(bigint) returns bigint language sql as 'select 0::bigint';
          create aggregate public.count(*) (sfunc = public.nothing, stype = bigint, initcond = '0');
          set search_path = public, pg_catalog;
          ${hidden("alter role current_user in database postgres set work_mem = '1MB'")}`
      }
    ]);

    expect(await failureOf(world)).toMatchObject({
      level: 1,
      failure: { code: "migration_changed_role" }
    });
  });

  it("applies a migration whose text holds the mark the platform wraps a migration in", async () => {
    const world = await published("own_mark");

    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_mark.sql",
        text: "do $catalyst_migration$ begin perform 1; end $catalyst_migration$;\ncreate table marked (note text default '$catalyst_migration$');"
      }
    ]);

    expect((await settle(world, world.id, 2)).failure).toBeUndefined();
  });

  it("measures the store after a migration that failed, too", async () => {
    const world = await published("measured_failure");
    await db.sql`update data_stores set size_measured_at = now() - interval '1 hour' where id = ${world.id}`;

    await publish(world, [
      manifest(),
      init,
      { path: "migrations/0002_fails.sql", text: "create table wide (id integer); select 1/0;" }
    ]);
    const failed = await failureOf(world);

    expect(Date.now() - Date.parse(String(failed.sizeMeasuredAt))).toBeLessThan(60_000);
  });
  it("refuses a migration that would leave the store over its size limit, and keeps nothing of it", async () => {
    const world = await published("too_large");
    const [size] = await db.sql<{ bytes: string }[]>`
      select pg_database_size(${world.record.location.database}::name)::text as bytes`;
    const limit = Number(size?.bytes) + 4 * 1024 ** 2;

    await publish(world, [
      manifest(),
      init,
      {
        path: "migrations/0002_bulk.sql",
        text: `create table bulk as
          select (select string_agg(md5((n * 1000 + i)::text), '') from generate_series(1, 60) i) as filler
          from generate_series(1, 8000) n;`
      }
    ]);
    // A publish sets the limit from the manifest; this one is set before the job runs.
    await db.sql`update data_stores set size_limit_bytes = ${limit} where id = ${world.id}`;

    expect(await failureOf(world)).toMatchObject({
      level: 1,
      failure: { code: "data_store_size_limit" }
    });
    expect(await refusal(call(world, "query", { sql: "select * from bulk" }))).toMatchObject({
      details: { sqlState: "42P01" }
    });
  });

  it("finds its signed rows by an index, in a record a migration filled with rows of its own", async () => {
    const world = await published("indexed");
    const inStore = connect(world.record.location.database);

    expect(
      await inStore`
        select indexdef from pg_indexes
        where schemaname = 'catalyst' and tablename = 'migrations' and indexdef like '%(proof)%'`
    ).toHaveLength(1);
    await inStore`
      insert into catalyst.migrations (number, name, sha256, proof)
      select n, 'ghost', 'x', md5(n::text) from generate_series(1, 300000) n`;
    await publish(world, [
      manifest(),
      init,
      { path: "migrations/0002_notes.sql", text: "create table notes (id integer);" }
    ]);

    expect((await settle(world, world.id, 2)).failure).toBeUndefined();
  });
});
