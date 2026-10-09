import postgres from "postgres";
import { expect, inject } from "vitest";
import { PostgresFixtures } from "./postgres-fixtures";

declare module "vitest" {
  export interface ProvidedContext {
    postgresFixturePrefix: string;
  }
}

let fixtures: PostgresFixtures | undefined;
const databases = new Map<string, Promise<string>>();
export function fileTestDatabaseUrl(fixtureFile?: string): Promise<string> {
  fixtures ??= new PostgresFixtures(inject("postgresFixturePrefix"));
  const testPath = expect.getState().testPath;
  if (!testPath) throw new Error("No test file identity");
  const file = fixtureFile ? `${testPath}:${fixtureFile}` : testPath;
  let database = databases.get(file);
  if (!database) {
    database = fixtures.database(file);
    databases.set(file, database);
  }
  return database;
}

export async function closeFileTestDatabase(): Promise<void> {
  const settled = await Promise.allSettled(databases.values());
  const results = await Promise.allSettled(
    settled
      .filter((result) => result.status === "fulfilled")
      .map(async (result) => fixtures?.drop(result.value))
  );
  // A failed setup has no file database to drop; run teardown owns partial templates.
  databases.clear();
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "Postgres fixture cleanup failed"
    );
}

export async function resetFileTestDatabase(): Promise<void> {
  const settled = await Promise.allSettled(databases.values());
  for (const database of settled) {
    if (database.status !== "fulfilled") continue;
    const sql = postgres(database.value, { max: 1, onnotice() {} });
    try {
      const tables = await sql<
        { tablename: string }[]
      >`select tablename from pg_tables where schemaname = 'public'`;
      if (tables.length)
        await sql.unsafe(
          `truncate ${tables.map(({ tablename }) => `"${tablename.replaceAll('"', '""')}"`).join(", ")} restart identity cascade`
        );
    } finally {
      await sql.end();
    }
  }
}
