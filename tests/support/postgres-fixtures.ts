import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { migrateDatabase } from "@vivd-catalyst/postgres-store";

const defaultTestMigrationsDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/postgres-store/migrations"
);

function testMigrationsDirectory(): string {
  return process.env.CATALYST_TEST_MIGRATIONS_DIRECTORY ?? defaultTestMigrationsDirectory;
}

export function requiredTestDatabaseUrl(): string {
  const url = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
  if (!url)
    throw new Error(
      "Persisted tests require Postgres. Set POSTGRES_STORE_TEST_DATABASE_URL to a disposable Postgres database; its role must have CREATEDB. Tests never skip when Postgres is unavailable."
    );
  return url;
}

/**
 * What the driver reported, without its message: a connection error can repeat the connection
 * string. The code and the error class are enough to tell a refused connection from a missing
 * permission or a failed migration statement.
 */
function causeWithoutCredentials(error: unknown): Error {
  const name = error instanceof Error ? error.name : "UnknownError";
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : "none";
  return new Error(`${name} (code ${code})`);
}

/**
 * Owns only databases with this run's random prefix, never the configured database. The instance
 * that makes the prefix owns the run and may drop all of it; an instance that joins a run through
 * a given prefix drops only the databases it names.
 */
export class PostgresFixtures {
  readonly prefix: string;
  private readonly ownsRun: boolean;
  private readonly migrationsDirectory = testMigrationsDirectory();
  constructor(joinedPrefix?: string) {
    const prefix = joinedPrefix ?? `catalyst_test_${randomUUID().replaceAll("-", "")}`;
    if (!/^catalyst_test_[a-f0-9]{32}$/u.test(prefix))
      throw new Error("Invalid test database prefix");
    this.prefix = prefix;
    this.ownsRun = joinedPrefix === undefined;
  }

  private admin() {
    return postgres(requiredTestDatabaseUrl(), { max: 1, connect_timeout: 5, onnotice() {} });
  }

  private url(name: string): string {
    const url = new URL(requiredTestDatabaseUrl());
    url.pathname = `/${name}`;
    return url.toString();
  }

  async database(file: string, migrated = true): Promise<string> {
    const name = `${this.prefix}_${createHash("sha256").update(file).digest("hex").slice(0, 12)}`;
    const template = `${this.prefix}_template`;
    const admin = this.admin();
    try {
      // The lock serializes lazy template creation and clones across workers in this run.
      await admin`select pg_advisory_lock(hashtextextended(${this.prefix}, 0))`;
      const [exists] = await admin`select datname from pg_database where datname = ${name}`;
      if (!exists) {
        if (migrated) {
          const [ready] = await admin`select datname from pg_database where datname = ${template}`;
          if (!ready) {
            await admin.unsafe(`create database "${template}" template template0`);
            try {
              // The same entry an operator runs, so the template is what a deployment gets.
              await migrateDatabase({
                databaseUrl: this.url(template),
                migrationsDirectory: this.migrationsDirectory
              });
            } catch (error) {
              await admin.unsafe(`drop database "${template}" with (force)`);
              throw error;
            }
          }
        }
        await admin.unsafe(
          `create database "${name}" template "${migrated ? template : "template0"}"`
        );
      }
      return this.url(name);
    } catch (error) {
      throw new Error(
        "Postgres test fixture setup failed. Check POSTGRES_STORE_TEST_DATABASE_URL, CREATEDB permission, and CATALYST_TEST_MIGRATIONS_DIRECTORY.",
        { cause: causeWithoutCredentials(error) }
      );
    } finally {
      await admin.end({ timeout: 5 });
    }
  }

  async drop(databaseUrl: string): Promise<void> {
    const name = new URL(databaseUrl).pathname.slice(1);
    if (!name.startsWith(`${this.prefix}_`))
      throw new Error("Refusing to drop a database outside this test run");
    const admin = this.admin();
    try {
      await admin.unsafe(`drop database if exists "${name}" with (force)`);
    } finally {
      await admin.end({ timeout: 5 });
    }
  }

  /** Drops every database of the run, so only the run owner may call it. */
  async close(): Promise<void> {
    if (!this.ownsRun)
      throw new Error(
        "Only the owner of a test run drops all of its databases. A test file drops its own databases with drop()."
      );
    if (!process.env.POSTGRES_STORE_TEST_DATABASE_URL) return;
    const admin = this.admin();
    try {
      const databases = await admin<{ datname: string }[]>`select datname from pg_database`;
      const owned = databases.filter(({ datname }) => datname.startsWith(`${this.prefix}_`));
      // Drop clones before the template, including leftovers after a worker/setup failure.
      for (const { datname } of owned.sort(
        (a, b) => Number(a.datname.endsWith("_template")) - Number(b.datname.endsWith("_template"))
      )) {
        await admin.unsafe(`drop database if exists "${datname}" with (force)`);
      }
    } finally {
      await admin.end({ timeout: 5 });
    }
  }
}
