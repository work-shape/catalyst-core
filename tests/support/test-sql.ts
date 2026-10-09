import postgres from "postgres";
import { fileTestDatabaseUrl } from "./test-database";

/**
 * Runs raw SQL against the database of the test file. For what a test must see or arrange
 * that no store method reaches, such as the rows of the job executor or an expired lease.
 */
export async function withTestSql<Result>(
  run: (sql: postgres.Sql) => Promise<Result>
): Promise<Result> {
  const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
  try {
    return await run(sql);
  } finally {
    await sql.end();
  }
}
