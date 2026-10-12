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

  it("keeps a reader of a store from seeing or ending another session", async () => {
    const world = await published("sessions");
    const denied = "needs a privilege its role does not hold (SQLSTATE 42501).";

    for (const sql of [
      "select pg_terminate_backend(pid) from pg_stat_activity",
      "select pg_cancel_backend(pg_backend_pid())",
      "select pid from pg_stat_get_activity(null)",
      "select pid from pg_stat_activity",
      "select pg_stat_get_backend_activity(backend) from pg_stat_get_backend_idset() backend",
      "select pg_stat_get_backend_pid(1)"
    ]) {
      expect(await refusal(call(world, "query", { sql })), sql).toMatchObject({
        message: `The query ${denied}`
      });
    }
  });

  // What a suite that shares the server needs after this one ran: the tests of the executor
  // make accounts of their own, which reach the server as every account does.
  it("changes no grant of the server's own databases, so an account of another suite still connects", async () => {
    const grants = () =>
      db.sql<{ datname: string; acl: string | null }[]>`
        select datname, datacl::text as acl from pg_database
        where datname in ('postgres', 'template1') order by datname`;
    const before = await grants();

    await published("server_grants");

    expect(await grants()).toEqual(before);
    const account = await platformRole();
    for (const database of ["postgres", "template1"]) {
      const url = new URL(account.databaseUrl);
      expect(
        await sqlState(connect(database, { name: url.username, password: url.password })`select 1`)
      ).toBe("no error");
    }
  });

  it("names on the store's record what the server leaves open, at every job, and clears what is closed", async () => {
    const world = await published("conditions");
    const { record } = world;
    // Any database of the server but the store's own counts, not two names.
    const [other] = await db.sql<{ open: boolean }[]>`
      select coalesce(bool_or(has_database_privilege(${record.roles.app}, d.oid, 'CONNECT')), false) as open
      from pg_database d where d.datname <> ${record.location.database} and d.datallowconn`;
    const found = other?.open ? ["server_databases_open"] : [];
    expect(record.conditions).toEqual(found);

    // As if an operator had closed one thing and opened another since: the next job says so.
    await db.sql`
      update data_stores set conditions = '["sessions_open", "temp_files_unbounded"]'::jsonb
      where id = ${world.id}`;
    await publish(world, [
      manifest(),
      init,
      { path: "migrations/0002_notes.sql", text: "create table notes (id integer);" }
    ]);
    expect((await settle(world, world.id, 2)).conditions).toEqual(found);

    // A platform role that is no superuser can neither take the session functions from the
    // store nor bound the temporary files of its roles.
    const { name, databaseUrl } = await platformRole();
    await db.sql.unsafe(`alter role "${name}" createdb createrole`);
    await db.sql.unsafe(`alter database "${platformDatabase()}" owner to "${name}"`);
    const plain = await setup("conditions_plain", {}, databaseUrl);
    const plainRecord = await settle(plain, await publish(plain, [manifest(), init]), 1);
    expect(plainRecord.conditions).toEqual([...found, "sessions_open", "temp_files_unbounded"]);
  });

  it("derives nothing from a password a role wrote, however it is made up", async () => {
    const world = await published("verifier");
    const { record } = world;
    await call(world, "query", { sql: "select 1 as one" });
    // A verifier of the right form that asks for four million rounds in place of 4,096.
    // Postgres itself works such a verifier out once when it is set, which shows what
    // working it out costs: the platform must not pay that on every call, in its one thread.
    const costly = `SCRAM-SHA-256$4000000:${"A".repeat(22)}==$${"A".repeat(43)}=:${"A".repeat(43)}=`;
    const setting = Date.now();
    await db.sql.unsafe(`alter role "${record.roles.app}" password '${costly}'`);
    const derivation = Date.now() - setting;

    const started = Date.now();
    await call(world, "query", { sql: "select 1 as one" });

    expect(Date.now() - started).toBeLessThan(derivation / 2);
    const [held] = await db.sql<{ verifier: string }[]>`
      select rolpassword as verifier from pg_authid where rolname = ${record.roles.app}`;
    // The role has the platform's password again, with the rounds the platform writes.
    expect(held?.verifier).toMatch(/^SCRAM-SHA-256\$4096:/u);
  });

  it("takes an error a statement of the store raises for what it is, and runs the call once", async () => {
    const refusing = {
      path: "migrations/0002_refusing.sql",
      text: `create sequence calls;
        create function refuse() returns trigger language plpgsql as $f$
          begin
            perform nextval('calls');
            raise exception 'no' using errcode = '28P01';
          end $f$;
        create trigger refuses after insert on findings for each row execute function refuse();`
    };
    const world = await published("raised", [manifest(), init, refusing]);

    expect(
      await refusal(call(world, "insert", { table: "findings", rows: [finding(1)] }))
    ).toMatchObject({ details: { sqlState: "28P01" } });
    // A sequence keeps what a transaction that was rolled back took from it.
    expect(
      await call(world, "query", { sql: "select last_value::integer as calls from calls" })
    ).toMatchObject({ rows: [{ calls: 1 }] });
  });

  it("gives the roles back what a trigger of the store took, before the next call runs as one", async () => {
    const hijack = {
      path: "migrations/0002_hijack.sql",
      text: `create function hijack() returns trigger language plpgsql as $f$
          begin
            execute 'alter ro' || 'le current_user password ' || quote_literal('set-by-a-trigger');
            execute 'alter ro' || 'le current_user set statement_timeout = 0';
            return new;
          end $f$;
        create trigger hijacks after insert on findings for each row execute function hijack();`
    };
    const world = await published("trigger", [manifest(), init, hijack]);
    const { record } = world;
    const settingsOf = async () =>
      (
        await db.sql<{ rolconfig: string[] }[]>`
          select rolconfig from pg_roles where rolname = ${record.roles.app}`
      )[0]?.rolconfig;
    const before = await settingsOf();
    const stolen = () =>
      sqlState(
        connect(record.location.database, {
          name: record.roles.app,
          password: "set-by-a-trigger"
        })`select 1`
      );

    // The insert runs the trigger as the app role, which may change its own password.
    await call(world, "insert", { table: "findings", rows: [finding(1)] });
    await call(world, "query", { sql: "select 1 as one" });

    expect(await settingsOf()).toEqual(before);
    expect(await stolen()).toBe("28P01");
  });

  it("sets a password again when Postgres refuses the one the platform holds, and runs the call", async () => {
    // A platform role that is no superuser is shown no password, so it learns of a changed
    // one only when a new connection is refused.
    const { name, databaseUrl } = await platformRole();
    await db.sql.unsafe(`alter role "${name}" createdb createrole`);
    await db.sql.unsafe(`alter database "${platformDatabase()}" owner to "${name}"`);
    const world = await setup("refused_password", {}, databaseUrl);
    const record = await settle(world, await publish(world, [manifest(), init]), 1);
    await call(world, "query", { sql: "select 1 as one" });

    await takeOver(record.roles.app);
    await db.sql`
      select pg_terminate_backend(pid) from pg_stat_activity where usename = ${record.roles.app}`;

    expect(await call(world, "query", { sql: "select 1 as one" })).toMatchObject({
      rows: [{ one: 1 }]
    });
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
    expect(await sqlState(migration`select * from catalyst.migrations`)).toBe("42501");
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
