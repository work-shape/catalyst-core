import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import postgres from "postgres";
import { afterEach, describe, expect, inject, it } from "vitest";
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
    const store = await createPlatformStore({ env: { DATABASE_URL: databaseUrl } });
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

  it("waits for the migration advisory lock while another session holds it", async () => {
    const databaseUrl = await emptyDatabase("lock");
    const holder = postgres(databaseUrl, { max: 1 });
    try {
      await holder`select pg_advisory_lock(hashtextextended('vivd-catalyst:postgres-store:migrations', 0))`;
      let settled = false;
      const migration = migrateDatabase({ databaseUrl }).finally(() => {
        settled = true;
      });
      await expect
        .poll(
          async () =>
            (await holder`select 1 from pg_locks where locktype = 'advisory' and not granted`)
              .length
        )
        .toBe(1);
      expect(settled).toBe(false);
      expect(await schemaObjects(databaseUrl)).toEqual([]);
      await holder`select pg_advisory_unlock(hashtextextended('vivd-catalyst:postgres-store:migrations', 0))`;
      expect(await migration).toEqual(committed);
    } finally {
      await holder.end();
    }
  });

  it("rolls a failed migration back and builds a concurrent index outside a transaction", async () => {
    const databaseUrl = await emptyDatabase("statements");
    const directory = mkdtempSync(join(tmpdir(), "catalyst-migration-boundary-"));
    directories.push(directory);
    mkdirSync(join(directory, "meta"));
    const entries = ["0000_table", "0001_index", "0002_broken"].map((tag, idx) => ({
      idx,
      version: "7",
      when: idx + 1,
      tag,
      breakpoints: true
    }));
    writeFileSync(join(directory, "meta/_journal.json"), JSON.stringify({ entries }));
    writeFileSync(join(directory, "0000_table.sql"), "create table probe (id text primary key);");
    writeFileSync(
      join(directory, "0001_index.sql"),
      "create index concurrently if not exists probe_id_idx on probe (id);"
    );
    writeFileSync(
      join(directory, "0002_broken.sql"),
      "create table half_applied (id text);--> statement-breakpoint\nselect missing_function();"
    );

    await expect(migrateDatabase({ databaseUrl, migrationsDirectory: directory })).rejects.toThrow(
      "missing_function"
    );
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      expect(
        await sql`select to_regclass('probe_id_idx')::text as index, to_regclass('half_applied')::text as half_applied`
      ).toEqual([{ index: "probe_id_idx", half_applied: null }]);
      expect(
        await sql`select created_at::int as applied from drizzle.__drizzle_migrations order by 1`
      ).toEqual([{ applied: 1 }, { applied: 2 }]);
    } finally {
      await sql.end();
    }
  });
});
