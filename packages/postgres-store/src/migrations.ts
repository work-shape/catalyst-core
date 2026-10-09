import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres, { type Sql } from "postgres";

const committedMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const migrationLockKey = "vivd-catalyst:postgres-store:migrations";

interface CommittedMigration {
  name: string;
  /** The journal timestamp. It orders migrations and is what the database records as applied. */
  when: number;
  hash: string;
  statements: string[];
}

export interface MigrateDatabaseInput {
  databaseUrl: string;
  /** Defaults to the migrations committed with this package. */
  migrationsDirectory?: string;
}

/**
 * The one way a database reaches the committed schema. It holds a Postgres advisory lock for the
 * whole run, so two callers apply every migration once, and returns the names it applied in order.
 */
export async function migrateDatabase(input: MigrateDatabaseInput): Promise<string[]> {
  const migrations = readCommittedMigrations(input.migrationsDirectory);
  // One connection: the advisory lock belongs to the session that runs the migrations.
  const sql = postgres(input.databaseUrl, { max: 1, onnotice() {} });
  try {
    await sql`select pg_advisory_lock(hashtextextended(${migrationLockKey}, 0))`;
    try {
      await sql`create schema if not exists drizzle`;
      await sql`
        create table if not exists drizzle.__drizzle_migrations (
          id serial primary key,
          hash text not null,
          created_at bigint
        )
      `;
      const lastApplied = await readLastAppliedMigration(sql);
      const applied: string[] = [];
      for (const migration of migrations) {
        if (lastApplied !== undefined && migration.when <= lastApplied) continue;
        await applyMigration(sql, migration);
        applied.push(migration.name);
      }
      return applied;
    } finally {
      await sql`select pg_advisory_unlock(hashtextextended(${migrationLockKey}, 0))`;
    }
  } finally {
    await sql.end();
  }
}

/**
 * Stops a process whose database lacks committed migrations. It only reads: a database that is
 * behind is migrated by the explicit migration step, and one that is ahead belongs to a newer
 * release this process may still serve.
 */
export async function assertDatabaseMigrated(sql: Sql): Promise<void> {
  const lastApplied = await readLastAppliedMigration(sql);
  const missing = readCommittedMigrations()
    .filter((migration) => lastApplied === undefined || migration.when > lastApplied)
    .map((migration) => migration.name);
  if (missing.length > 0) throw new DatabaseBehindError(missing);
}

export class DatabaseBehindError extends Error {
  readonly missingMigrations: readonly string[];

  constructor(missingMigrations: readonly string[]) {
    super(
      `The database is behind this release. Run the migration step before starting. Missing migrations: ${missingMigrations.join(", ")}`
    );
    this.name = "DatabaseBehindError";
    this.missingMigrations = missingMigrations;
  }
}

async function applyMigration(sql: Sql, migration: CommittedMigration): Promise<void> {
  const record = () =>
    sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${migration.hash}, ${migration.when})`;
  // Postgres refuses a concurrent index build inside a transaction. The migration lint admits
  // such a migration only when every statement can be repeated after a partial run.
  if (migration.statements.some((statement) => /\bconcurrently\b/iu.test(statement))) {
    for (const statement of migration.statements) await sql.unsafe(statement);
    await record();
    return;
  }
  await sql.unsafe("begin");
  try {
    for (const statement of migration.statements) await sql.unsafe(statement);
    await record();
    await sql.unsafe("commit");
  } catch (error) {
    await sql.unsafe("rollback");
    throw error;
  }
}

async function readLastAppliedMigration(sql: Sql): Promise<number | undefined> {
  const [table] = await sql<{ name: string | null }[]>`
    select to_regclass('drizzle.__drizzle_migrations')::text as name
  `;
  if (!table?.name) return undefined;
  const [last] = await sql<{ created_at: string | null }[]>`
    select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1
  `;
  return last?.created_at ? Number(last.created_at) : undefined;
}

function readCommittedMigrations(directory = committedMigrationsDirectory): CommittedMigration[] {
  const journal: unknown = JSON.parse(readFileSync(join(directory, "meta/_journal.json"), "utf8"));
  const names = journalMigrationNames(journal);
  // Drizzle's reader keeps statement splitting and hashes identical to databases it migrated.
  return readMigrationFiles({ migrationsFolder: directory }).map((migration, index) => {
    const name = names[index];
    if (name === undefined) throw new Error("The migration journal does not name every migration");
    return {
      name,
      when: migration.folderMillis,
      hash: migration.hash,
      statements: migration.sql.filter((statement) => statement.trim().length > 0)
    };
  });
}

function journalMigrationNames(journal: unknown): string[] {
  if (typeof journal !== "object" || journal === null || !("entries" in journal))
    throw new Error("The migration journal has no entries");
  const { entries } = journal;
  if (!Array.isArray(entries)) throw new Error("The migration journal has no entries");
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || !("tag" in entry))
      throw new Error("A migration journal entry has no tag");
    const { tag } = entry;
    if (typeof tag !== "string") throw new Error("A migration journal entry has no tag");
    return tag;
  });
}
