import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, inject, it, vi } from "vitest";
import { createPlatformStore } from "@vivd-catalyst/client-assembly";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";
import { PostgresFixtures } from "./support/postgres-fixtures";

const migrationsDirectory = resolve("packages/postgres-store/migrations");
const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));
const journal: { entries: { tag: string }[] } = JSON.parse(
  readFileSync(join(migrationsDirectory, "meta/_journal.json"), "utf8")
);
const committed = journal.entries.map((entry) => entry.tag);

describe("the migration boundary", () => {
  const databases: string[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const databaseUrl of databases.splice(0)) await fixtures.drop(databaseUrl);
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  async function emptyDatabase(name: string): Promise<string> {
    const databaseUrl = await fixtures.database(`migration-boundary:${name}`, false);
    databases.push(databaseUrl);
    return databaseUrl;
  }

  /** How an API or a worker opens its store when it starts. */
  async function start(databaseUrl: string): Promise<void> {
    const store = await createPlatformStore({
      env: { DATABASE_URL: databaseUrl },
      poolSize: 2
    });
    await store.close?.();
  }

  async function schemaObjects(databaseUrl: string) {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      return await sql`
        select n.nspname as schema, c.relname as name
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')
        union all
        select nspname, '' from pg_namespace where nspname = 'drizzle'
      `;
    } finally {
      await sql.end();
    }
  }

  /** A copy of the committed migrations that ends after `count` of them. */
  function committedThrough(count: number): string {
    const directory = mkdtempSync(join(tmpdir(), "catalyst-migration-boundary-"));
    directories.push(directory);
    cpSync(migrationsDirectory, directory, { recursive: true });
    writeFileSync(
      join(directory, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, count) })
    );
    return directory;
  }

  it("stops startup on an unmigrated database with every missing name and runs no DDL", async () => {
    const databaseUrl = await emptyDatabase("unmigrated");
    const failure = await start(databaseUrl).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "DatabaseBehindError", missingMigrations: committed });
    expect(String(failure)).toContain("Run the migration step before starting");
    expect(String(failure)).toContain(committed.join(", "));
    expect(await schemaObjects(databaseUrl)).toEqual([]);
  });

  it("names the migrations a database behind lacks, and starts once they are applied", async () => {
    const databaseUrl = await emptyDatabase("behind");
    const behind = committed.length - 2;
    expect(
      await migrateDatabase({ databaseUrl, migrationsDirectory: committedThrough(behind) })
    ).toEqual(committed.slice(0, behind));
    const before = await schemaObjects(databaseUrl);

    await expect(start(databaseUrl)).rejects.toMatchObject({
      missingMigrations: committed.slice(behind)
    });
    expect(await schemaObjects(databaseUrl)).toEqual(before);

    expect(await migrateDatabase({ databaseUrl })).toEqual(committed.slice(behind));
    expect(await migrateDatabase({ databaseUrl })).toEqual([]);
    await expect(start(databaseUrl)).resolves.toBeUndefined();
  });

  it("starts on a database that is ahead of this release", async () => {
    const databaseUrl = await emptyDatabase("ahead");
    await migrateDatabase({ databaseUrl });
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`create table from_a_newer_release (id text primary key)`;
      await sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('newer-release', 9999999999999)`;
    } finally {
      await sql.end();
    }
    await expect(start(databaseUrl)).resolves.toBeUndefined();
    expect(await migrateDatabase({ databaseUrl })).toEqual([]);
  });

  it("applies every migration once when two migration steps race", async () => {
    const databaseUrl = await emptyDatabase("race");
    const results = await Promise.all([
      migrateDatabase({ databaseUrl }),
      migrateDatabase({ databaseUrl }),
      migrateDatabase({ databaseUrl })
    ]);
    expect(results.filter((applied) => applied.length > 0)).toEqual([committed]);
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      expect(await sql`select 1 from drizzle.__drizzle_migrations`).toHaveLength(committed.length);
    } finally {
      await sql.end();
    }
  });

  const takeMigrationLock =
    "select pg_advisory_lock(hashtextextended('vivd-catalyst:postgres-store:migrations', 0))";

  it("waits for the migration advisory lock while another session holds it", async () => {
    const databaseUrl = await emptyDatabase("lock");
    const holder = postgres(databaseUrl, { max: 1 });
    let migration: Promise<string[]> | undefined;
    try {
      await holder.unsafe(takeMigrationLock);
      let settled = false;
      const lines: string[] = [];
      migration = migrateDatabase({ databaseUrl, log: (line) => lines.push(line) }).finally(() => {
        settled = true;
      });
      // It says once that it waits: by then it has asked for the lock and was refused.
      await vi.waitFor(() =>
        expect(lines).toEqual(["Waiting for the migration lock: another migration step holds it."])
      );
      // The run asks for the lock again every 100 ms and holds no statement open meanwhile: a
      // session blocked in pg_advisory_lock would deadlock with a concurrent index build. Only
      // this database's locks are read: pg_locks lists every database of the server, and the
      // other test files wait for advisory locks of their own.
      expect(
        await holder`
          select 1 from pg_locks
          where locktype = 'advisory' and not granted
            and database = (select oid from pg_database where datname = current_database())
        `
      ).toHaveLength(0);
      expect(settled).toBe(false);
      expect(await schemaObjects(databaseUrl)).toEqual([]);
      // It says again every 30 seconds that it waits: here the clock is moved on.
      const realNow = Date.now.bind(Date);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 31_000);
      try {
        await vi.waitFor(() => expect(lines).toHaveLength(2));
      } finally {
        clock.mockRestore();
      }
      expect(lines[1]).toMatch(/^Still waiting for the migration lock after 3[12] s\.$/u);
      await holder`select pg_advisory_unlock(hashtextextended('vivd-catalyst:postgres-store:migrations', 0))`;
      expect(await migration).toEqual(committed);
    } finally {
      await holder.end();
      // A failed expectation must not leave the run going while its database is dropped.
      await migration?.catch(() => undefined);
    }
  });

  // Fails without the check before each request for the lock: the next request went to the dead
  // session, the driver threw a TypeError outside every promise, and the run never settled.
  it("fails when the server ends its session while it waits for the migration lock", async () => {
    const databaseUrl = await emptyDatabase("lock-wait-cut");
    const holder = postgres(databaseUrl, { max: 1 });
    try {
      await holder.unsafe(takeMigrationLock);
      const lines: string[] = [];
      const outcome = migrateDatabase({ databaseUrl, log: (line) => lines.push(line) }).then(
        () => undefined,
        (error: unknown) => error
      );
      await vi.waitFor(() => expect(lines).toHaveLength(1));
      expect(
        await holder`
          select pg_terminate_backend(pid) as ended from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
        `
      ).toEqual([{ ended: true }]);
      const error = await outcome;
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error ? error.message : "").toBe(
        "The database connection ended while the run waited for the migration lock."
      );
      expect(await schemaObjects(databaseUrl)).toEqual([]);
    } finally {
      await holder.end();
    }
  });

  /** A migrations directory of its own: one file per entry, in order. */
  function migrations(files: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), "catalyst-migration-boundary-"));
    directories.push(directory);
    mkdirSync(join(directory, "meta"));
    const entries = Object.keys(files).map((tag, idx) => ({
      idx,
      version: "7",
      when: idx + 1,
      tag,
      breakpoints: true
    }));
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ entries }));
    for (const [tag, text] of Object.entries(files))
      writeFileSync(join(directory, `${tag}.sql`), text);
    return directory;
  }

  async function read<T>(
    databaseUrl: string,
    query: (sql: postgres.Sql) => Promise<T>
  ): Promise<T> {
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      return await query(sql);
    } finally {
      await sql.end();
    }
  }

  const indexes = (databaseUrl: string) =>
    read(
      databaseUrl,
      (sql) => sql<{ name: string; valid: boolean }[]>`
        select c.relname as name, i.indisvalid as valid
        from pg_index i join pg_class c on c.oid = i.indexrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' order by 1
      `
    );
  const applied = (databaseUrl: string) =>
    read(databaseUrl, async (sql) =>
      (
        await sql<{ applied: number }[]>`
          select created_at::int as applied from drizzle.__drizzle_migrations order by 1
        `
      ).map((row) => row.applied)
    );

  it("names the migration that failed and rolls it back", async () => {
    const databaseUrl = await emptyDatabase("failure");
    const migrationsDirectory = migrations({
      "0000_table": "create table probe (id text primary key);",
      // A comment that mentions CONCURRENTLY must not take the migration out of its transaction.
      "0001_broken":
        "-- Not built CONCURRENTLY: the table is new.\ncreate table half_applied (id text);--> statement-breakpoint\nselect missing_function();"
    });
    await expect(migrateDatabase({ databaseUrl, migrationsDirectory })).rejects.toThrow(
      /^Migration 0001_broken failed: .*missing_function/u
    );
    expect(
      await read(
        databaseUrl,
        (sql) =>
          sql`select to_regclass('probe')::text as probe, to_regclass('half_applied')::text as half_applied`
      )
    ).toEqual([{ probe: "probe", half_applied: null }]);
    expect(await applied(databaseUrl)).toEqual([1]);
  });

  /** Ends the backend that runs `marker` once it shows up, as a failover or an operator would. */
  async function terminateBackendRunning(databaseUrl: string, marker: string): Promise<void> {
    await read(databaseUrl, async (sql) => {
      for (;;) {
        const ended = await sql<{ ended: boolean }[]>`
          select pg_terminate_backend(pid) as ended from pg_stat_activity
          where pid <> pg_backend_pid() and state = 'active' and query like ${`%${marker}%`}
        `;
        if (ended.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    });
  }

  // Fails without the guarded cleanup: the rollback and the unlock were sent to the dead session,
  // the driver threw a TypeError outside every promise, and the run never settled.
  it.each([
    ["in its transaction", "select pg_sleep(60) /* cut_in_transaction */;"],
    [
      "in a concurrent index build",
      "create index concurrently if not exists cut_idx on probe (id);--> statement-breakpoint\nselect pg_sleep(60) /* cut_in_build */;"
    ]
  ])("names the migration whose connection the server ended %s", async (_where, statement) => {
    const databaseUrl = await emptyDatabase("connection-cut");
    const migrationsDirectory = migrations({
      "0000_table": "create table probe (id text primary key);",
      "0001_cut": statement
    });
    const run = migrateDatabase({ databaseUrl, migrationsDirectory });
    const outcome = run.then(
      () => undefined,
      (error: unknown) => error
    );
    await terminateBackendRunning(databaseUrl, "pg_sleep(60) /* cut_in_");
    const error = await outcome;
    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : "").toMatch(
      /^Migration 0001_cut failed: the database connection ended \((?:CONNECTION_CLOSED|PostgresError): /u
    );
    expect(await applied(databaseUrl)).toEqual([1]);
  });

  it("runs every statement on the session that holds the advisory lock", async () => {
    const databaseUrl = await emptyDatabase("session");
    const heldByThisSession =
      "select count(*)::int from pg_locks where locktype = 'advisory' and granted and pid = pg_backend_pid()";
    const migrationsDirectory = migrations({
      "0000_first": `create table lock_probe (held int);--> statement-breakpoint\ninsert into lock_probe ${heldByThisSession};`,
      "0001_second": `insert into lock_probe ${heldByThisSession};`,
      "0002_index": "create index concurrently if not exists lock_probe_idx on lock_probe (held);",
      "0003_third": `insert into lock_probe ${heldByThisSession};`
    });
    await migrateDatabase({ databaseUrl, migrationsDirectory });
    expect(await read(databaseUrl, (sql) => sql`select held from lock_probe`)).toEqual([
      { held: 1 },
      { held: 1 },
      { held: 1 }
    ]);
    expect(await indexes(databaseUrl)).toEqual([{ name: "lock_probe_idx", valid: true }]);
  });

  it("rebuilds a concurrent index that a failed run left invalid", async () => {
    const databaseUrl = await emptyDatabase("invalid-index");
    const migrationsDirectory = migrations({
      "0000_table":
        "create table duplicates (value int);--> statement-breakpoint\ninsert into duplicates values (1), (1);",
      "0001_unique":
        "create unique index concurrently if not exists duplicates_value_idx on duplicates (value);"
    });
    await expect(migrateDatabase({ databaseUrl, migrationsDirectory })).rejects.toThrow(
      /^Migration 0001_unique failed: /u
    );
    expect(await indexes(databaseUrl)).toEqual([{ name: "duplicates_value_idx", valid: false }]);
    expect(await applied(databaseUrl)).toEqual([1]);

    // Not repaired yet: the rerun fails again instead of skipping the index that exists.
    await expect(migrateDatabase({ databaseUrl, migrationsDirectory })).rejects.toThrow(
      /^Migration 0001_unique failed: /u
    );
    await read(
      databaseUrl,
      (sql) => sql`delete from duplicates where ctid = (select min(ctid) from duplicates)`
    );
    expect(await migrateDatabase({ databaseUrl, migrationsDirectory })).toEqual(["0001_unique"]);
    expect(await indexes(databaseUrl)).toEqual([{ name: "duplicates_value_idx", valid: true }]);
    expect(await applied(databaseUrl)).toEqual([1, 2]);
  });

  it("does not record a concurrent index migration while the schema holds an invalid index", async () => {
    const databaseUrl = await emptyDatabase("invalid-left");
    const migrationsDirectory = migrations({
      "0000_table":
        "create table duplicates (value int, other int);--> statement-breakpoint\ninsert into duplicates values (1, 1), (1, 2);",
      "0001_index":
        "create index concurrently if not exists duplicates_other_idx on duplicates (other);"
    });
    await migrateDatabase({
      databaseUrl,
      migrationsDirectory: migrations({
        "0000_table":
          "create table duplicates (value int, other int);--> statement-breakpoint\ninsert into duplicates values (1, 1), (1, 2);"
      })
    });
    await read(databaseUrl, async (sql) => {
      await expect(
        sql.unsafe("create unique index concurrently left_invalid_idx on duplicates (value)")
      ).rejects.toThrow();
    });
    await expect(migrateDatabase({ databaseUrl, migrationsDirectory })).rejects.toThrow(
      "Migration 0001_index failed: it left an invalid index (left_invalid_idx)"
    );
    expect(await applied(databaseUrl)).toEqual([1]);
  });
});
