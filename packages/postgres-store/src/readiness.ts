import { describeWithoutMessage } from "./error-without-message";
import type { DatabaseReadiness, Logger } from "@vivd-catalyst/core";
import { readMigrationState, type Queries } from "./migrations";

/**
 * How long the database has to answer a readiness check. Protects the proxy and the deploy step
 * that ask from waiting on a database that accepts connections and never answers. Past it the
 * check reads `database_unreachable`.
 */
export const READINESS_DATABASE_TIMEOUT_MS = 2_000;

const unreachable: DatabaseReadiness = { status: "not_ready", reason: "database_unreachable" };

/**
 * The check whether the database behind `sql` can serve this release. It never rejects, and
 * what the driver reported stays here: an error of the driver can repeat the connection string.
 * Every caller waits on the one read that is under way, so probes against a database that does
 * not answer hold one connection of the pool, however many arrive and however often.
 */
export function createDatabaseReadinessCheck(
  sql: Queries,
  logger?: Logger
): () => Promise<DatabaseReadiness> {
  let underWay: Promise<DatabaseReadiness> | undefined;
  const read = (): Promise<DatabaseReadiness> =>
    (underWay ??= readReadiness(sql)
      .catch((error: unknown) => {
        logger?.warn(describeWithoutMessage(error), "Readiness check could not read the database");
        return unreachable;
      })
      .finally(() => {
        underWay = undefined;
      }));

  return async () => {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<DatabaseReadiness>((resolve) => {
      timer = setTimeout(() => {
        logger?.warn(
          { timeoutMs: READINESS_DATABASE_TIMEOUT_MS },
          "Readiness check got no answer from the database in time"
        );
        resolve(unreachable);
      }, READINESS_DATABASE_TIMEOUT_MS);
    });
    try {
      return await Promise.race([read(), timedOut]);
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readReadiness(sql: Queries): Promise<DatabaseReadiness> {
  await sql.unsafe("select 1");
  const { applied, missing } = await readMigrationState(sql);
  const newest = applied.at(-1);
  if (missing.length > 0 || newest === undefined)
    return { status: "not_ready", reason: "database_behind", missing };
  return { status: "ready", migration: newest };
}
