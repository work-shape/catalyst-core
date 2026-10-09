import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres, { type ReservedSql } from "postgres";
import {
  concurrentIndexName,
  parseSqlChunk,
  runsOutsideTransaction,
  type MigrationStatement
} from "./migration-statements.js";

const committedMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);
const migrationLockKey = "vivd-catalyst:postgres-store:migrations";

/** Any query runner: the migration session, or the pool a running process reads through. */
export type Queries = Pick<ReservedSql, "unsafe">;

interface CommittedMigration {
  name: string;
  /** The journal timestamp. It orders migrations and is what the database records as applied. */
  when: number;
  hash: string;
  /** The query texts between drizzle's breakpoints, with the statements each one holds. */
  chunks: { text: string; statements: MigrationStatement[] }[];
}

export interface MigrateDatabaseInput {
  databaseUrl: string;
  /** Defaults to the migrations committed with this package. */
  migrationsDirectory?: string;
}

/**
 * The one way a database reaches the committed schema. One reserved session holds a Postgres
 * advisory lock for the whole run and executes every statement, so two callers apply every
 * migration once. Returns the names it applied, in order.
 */
export async function migrateDatabase(input: MigrateDatabaseInput): Promise<string[]> {
  const migrations = readCommittedMigrations(input.migrationsDirectory);
  const pool = postgres(input.databaseUrl, { max: 1, onnotice() {} });
  try {
    // The advisory lock belongs to a session. The pool may replace its connection after the
    // connection's lifetime; a reserved one stays with this run until it is released.
    const session = await pool.reserve();
    try {
      await session.unsafe("select pg_advisory_lock(hashtextextended($1, 0))", [migrationLockKey]);
      try {
        await session.unsafe("create schema if not exists drizzle");
        await session.unsafe(`
          create table if not exists drizzle.__drizzle_migrations (
            id serial primary key,
            hash text not null,
            created_at bigint
          )
        `);
        const lastApplied = await readLastAppliedMigration(session);
        const applied: string[] = [];
        for (const migration of migrations) {
          if (lastApplied !== undefined && migration.when <= lastApplied) continue;
          try {
            await applyMigration(session, migration);
          } catch (error) {
            throw new Error(
              `Migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error }
            );
          }
          applied.push(migration.name);
        }
        return applied;
      } finally {
        await session.unsafe("select pg_advisory_unlock(hashtextextended($1, 0))", [
          migrationLockKey
        ]);
      }
    } finally {
      session.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Stops a process whose database lacks committed migrations. It only reads: a database that is
 * behind is migrated by the explicit migration step, and one that is ahead belongs to a newer
 * release this process may still serve.
 */
export async function assertDatabaseMigrated(sql: Queries): Promise<void> {
  const { missing } = await readMigrationState(sql);
  if (missing.length > 0) throw new DatabaseBehindError(missing);
}

export interface MigrationState {
  /** The migrations of this release the database holds, oldest first. */
  applied: string[];
  /** The migrations of this release the database lacks, oldest first. */
  missing: string[];
}

/**
 * The one rule for what a database owes this release. It only reads. Migrations a newer release
 * applied are not counted against the database: it is ahead, and this release may serve it.
 */
export async function readMigrationState(sql: Queries): Promise<MigrationState> {
  const lastApplied = await readLastAppliedMigration(sql);
  const state: MigrationState = { applied: [], missing: [] };
  for (const migration of releaseMigrations()) {
    const isApplied = lastApplied !== undefined && migration.when <= lastApplied;
    (isApplied ? state.applied : state.missing).push(migration.name);
  }
  return state;
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

async function applyMigration(session: Queries, migration: CommittedMigration): Promise<void> {
  const record = () =>
    session.unsafe("insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)", [
      migration.hash,
      migration.when
    ]);
  // Postgres refuses a concurrent index build inside a transaction. The migration lint admits
  // such a migration only when every statement can be repeated after a partial run.
  const concurrent = migration.chunks.some((chunk) =>
    chunk.statements.some(runsOutsideTransaction)
  );
  if (!concurrent) {
    await session.unsafe("begin");
    try {
      for (const chunk of migration.chunks) await session.unsafe(chunk.text);
      await record();
      await session.unsafe("commit");
    } catch (error) {
      await session.unsafe("rollback");
      throw error;
    }
    return;
  }

  for (const chunk of migration.chunks) {
    // A build that failed earlier left an invalid index of this name. IF NOT EXISTS would skip
    // it, so it is dropped and the statement builds it again.
    for (const statement of chunk.statements) {
      const index = concurrentIndexName(statement);
      if (index !== undefined && (await invalidIndexes(session)).includes(index))
        await session.unsafe(`drop index concurrently if exists "${index.replaceAll('"', '""')}"`);
    }
    await session.unsafe(chunk.text);
  }
  const invalid = await invalidIndexes(session);
  if (invalid.length > 0)
    throw new Error(
      `it left an invalid index (${invalid.join(", ")}). Repair what stopped the build and run the migration step again.`
    );
  await record();
}

/** Indexes of the product's schema that a concurrent build left unusable. */
async function invalidIndexes(session: Queries): Promise<string[]> {
  const rows = await session.unsafe<{ name: string }[]>(`
    select c.relname as name
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = current_schema() and not i.indisvalid
    order by c.relname
  `);
  return rows.map((row) => row.name);
}

async function readLastAppliedMigration(sql: Queries): Promise<number | undefined> {
  const [table] = await sql.unsafe<{ name: string | null }[]>(
    "select to_regclass('drizzle.__drizzle_migrations')::text as name"
  );
  if (!table?.name) return undefined;
  const [last] = await sql.unsafe<{ created_at: string | null }[]>(
    "select created_at from drizzle.__drizzle_migrations order by created_at desc limit 1"
  );
  return last?.created_at ? Number(last.created_at) : undefined;
}

let committedWithRelease: CommittedMigration[] | undefined;

/** The migrations committed with this package. Read once: a release's files do not change. */
function releaseMigrations(): CommittedMigration[] {
  return (committedWithRelease ??= readCommittedMigrations());
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
      chunks: migration.sql
        .filter((text) => text.trim().length > 0)
        .map((text) => ({ text, statements: parseSqlChunk(text) }))
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
