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
          "'migrations/0002_halves.sql' holds a statement that cannot run in the one transaction of a migration, such as one that ends it (SQLSTATE 0A000). Nothing of it was applied."
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
});
