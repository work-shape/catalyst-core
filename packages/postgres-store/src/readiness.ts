import type { DatabaseReadiness } from "@vivd-catalyst/core";
import { readMigrationState, type Queries } from "./migrations";

/**
 * How long the database has to answer a readiness check. Protects the proxy and the deploy step
 * that ask from waiting on a database that accepts connections and never answers. Past it the
 * check reads `database_unreachable`.
 */
export const READINESS_DATABASE_TIMEOUT_MS = 2_000;

const unreachable: DatabaseReadiness = { status: "not_ready", reason: "database_unreachable" };

/**
 * Asks the database whether it can serve this release. It never rejects, and what the driver
 * reported stays here: an error of the driver can repeat the connection string.
 */
export async function checkDatabaseReadiness(sql: Queries): Promise<DatabaseReadiness> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<DatabaseReadiness>((resolve) => {
    timer = setTimeout(() => resolve(unreachable), READINESS_DATABASE_TIMEOUT_MS);
  });
  try {
    // A query the timeout leaves behind ends by itself: the driver gives up on a connection
    // that does not open, and a query that was only slow returns its connection to the pool.
    return await Promise.race([readReadiness(sql).catch(() => unreachable), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function readReadiness(sql: Queries): Promise<DatabaseReadiness> {
  await sql.unsafe("select 1");
  const { applied, missing } = await readMigrationState(sql);
  const newest = applied.at(-1);
  if (missing.length > 0 || newest === undefined)
    return { status: "not_ready", reason: "database_behind", missing };
  return { status: "ready", migration: newest };
}
